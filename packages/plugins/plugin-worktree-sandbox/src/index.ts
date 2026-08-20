/**
 * `sandbox_exec` tool: run a command inside an isolated git worktree
 * (`.dsh/worktrees/subagent-*`) so a trial subagent run cannot touch the main
 * working tree, then return the trial's structured git diff and the command's
 * exit status, both bounded by the output-retention envelope. The worktree is
 * removed after the call by default, so a trial's changes are disposable until
 * the caller decides to apply them. Named exports preserve loader injection
 * metadata.
 * @module @deepseek-ai/dsh-plugin-worktree-sandbox
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { SandboxExecResult } from './types.ts'
import {
  addWorktree,
  collectRetained,
  parseChangedFiles,
  removeWorktree,
  resolveBaseCommit,
  resolveWorktreeHead,
  runCommand,
  worktreeExists,
} from './worktree.ts'

export const name = 'plugin-worktree-sandbox'
export const inject = ['tools', 'subprocess']

/** Runtime configuration for the sandbox tool. */
export interface Config {
  /** Repository root; defaults to the process cwd. */
  cwd?: string
  /** Where trial worktrees are created; defaults to `<cwd>/.dsh/worktrees`. */
  worktreeRoot?: string
  /** Base ref the trial worktrees detach from; defaults to HEAD. */
  baseRef?: string
  /** Output-retention envelope in bytes; defaults to 15_000 (15 KB). */
  maxOutputBytes?: number
  /** Per-command timeout in milliseconds; defaults to 30_000. */
  timeoutMs?: number
  /** Model-facing tool name; defaults to `sandbox_exec`. */
  toolName?: string
  /** Remove the trial worktree after the call; defaults to true. */
  cleanup?: boolean
  /** Path to the git binary; defaults to `git`. */
  gitBinary?: string
}

/** Runtime configuration schema for the sandbox tool. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  worktreeRoot: z.string(),
  baseRef: z.string().default('HEAD'),
  maxOutputBytes: z.number().step(1).min(1).default(15_000),
  timeoutMs: z.number().step(1).min(1).default(30_000),
  toolName: z.string().default('sandbox_exec'),
  cleanup: z.boolean().default(true),
  gitBinary: z.string().default('git'),
})

/** Render the structured sandbox result as model-facing text. */
function renderSandboxResult(result: SandboxExecResult): string {
  const status = result.exitCode === 0
    ? 'exit 0'
    : result.signal !== null
      ? `killed by signal ${result.signal}`
      : `exit ${result.exitCode}`
  const changed = result.changedFiles.length === 0
    ? 'no files changed'
    : `${result.changedFiles.length} file${result.changedFiles.length === 1 ? '' : 's'} changed: ${result.changedFiles.join(', ')}`
  const stat = result.diffStat.text.trim()
  const diff = result.diff.text.trim()
  const stdout = result.stdout.text.trim()
  const stderr = result.stderr.text.trim()
  const lines = [
    `sandbox trial ${result.worktree} on ${result.baseRef}: ${status}; ${changed}`,
  ]
  if (stat.length > 0) lines.push(stat)
  if (diff.length > 0) lines.push(`diff:\n${diff}${result.diff.truncated ? '\n[diff truncated by the output envelope]' : ''}`)
  if (stdout.length > 0) lines.push(`stdout:\n${stdout}${result.stdout.truncated ? '\n[stdout truncated]' : ''}`)
  if (stderr.length > 0) lines.push(`stderr:\n${stderr}${result.stderr.truncated ? '\n[stderr truncated]' : ''}`)
  if (result.cleanupError !== undefined) lines.push(`note: the trial worktree could not be removed (${result.cleanupError})`)
  return lines.join('\n')
}

/**
 * Register the sandbox tool.
 * @param ctx - Cordis context carrying the tool registry and subprocess service.
 * @param config - sandbox configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const toolName = config.toolName ?? 'sandbox_exec'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Run a command inside an isolated git worktree (a disposable trial) and return the trial\'s git diff and the command\'s exit status. The worktree is detached from the current branch and removed after the call, so the trial cannot change the main working tree. Use it to safely experiment (e.g. a subagent trial) before committing changes to the real tree.',
    parameters: {
      id: {
        type: 'string',
        description: 'Trial id naming the worktree `.dsh/worktrees/subagent-<id>`; letters, digits, `-` and `_`, max 64 characters. Omit to auto-generate; reuse an id to keep the same trial worktree across calls (with `cleanup: false`).',
      },
      command: {
        type: 'string',
        required: true,
        description: 'The shell command to run inside the trial worktree.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'sandbox' },
          worktree: { type: 'string', required: true },
          baseRef: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          stdout: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          stderr: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          diff: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          diffStat: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          changedFiles: { type: 'array', required: true, items: { type: 'string' } },
          cleanupError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSandboxResult(value) }],
    },
    // Each trial owns an isolated worktree and a disjoint process tree. A
    // same-`id` race on worktree creation resolves to a reused trial, so sibling
    // sandbox calls cannot corrupt one another's state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const repoRoot = config.cwd ?? process.cwd()
      const worktreeRoot = config.worktreeRoot ?? join(repoRoot, '.dsh', 'worktrees')
      const git = config.gitBinary ?? 'git'
      const envelope = config.maxOutputBytes ?? 15_000
      const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : randomUUID().slice(0, 8)
      // The id lands in a worktree path; the tool JSON validator supports no
      // pattern constraint, so reject traversal outright before any operation.
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
        throw new Error(`invalid sandbox trial id ${JSON.stringify(id)}: allowed characters are letters, digits, - and _, max length 64`)
      }
      const worktreePath = join(worktreeRoot, `subagent-${id}`)
      const baseRef = config.baseRef ?? 'HEAD'

      // Validate the repository first so a non-git root fails loud on
      // `git rev-parse` before any trial directory is created.
      const commit = await resolveBaseCommit(ctx, repoRoot, git, baseRef)
      await mkdir(worktreeRoot, { recursive: true })
      let created = false
      if (!await worktreeExists(ctx, repoRoot, git, worktreePath)) {
        try {
          await addWorktree(ctx, repoRoot, git, worktreePath, commit)
          created = true
        } catch (error: unknown) {
          // A concurrent same-`id` call may have added the worktree first;
          // treat that as a reused trial rather than failing the call.
          if (!await worktreeExists(ctx, repoRoot, git, worktreePath)) throw error
        }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, config.timeoutMs ?? 30_000)
      // The timeout bounds the COMMAND; caller cancellation (exec.signal) also
      // cancels the follow-up capture so a timed-out trial still reports its
      // partial diff. The follow-up git steps never inherit the timeout signal.
      const commandSignal = AbortSignal.any([exec.signal, controller.signal])

      let result: SandboxExecResult | undefined
      let primaryError: unknown
      try {
        const run = await runCommand(ctx, worktreePath, ['sh', '-c', args.command], envelope, commandSignal)
        // Mark untracked files intent-to-add so `git diff` includes them; the
        // trial's new files are the point of the diff.
        await runCommand(ctx, worktreePath, [git, 'add', '-N', '.'], envelope, exec.signal)
        // Diff against the trial worktree's own HEAD so a reused trial's diff
        // stays anchored to its base even when the main branch moves.
        const trialBase = await resolveWorktreeHead(ctx, worktreePath, git, exec.signal)
        const diff = await collectRetained(ctx, worktreePath, [git, 'diff', trialBase, '--'], envelope, exec.signal)
        const diffStat = await collectRetained(ctx, worktreePath, [git, 'diff', '--stat', trialBase, '--'], envelope, exec.signal)
        const status = await runCommand(ctx, worktreePath, [git, 'status', '--porcelain'], envelope, exec.signal)

        result = {
          kind: 'sandbox',
          worktree: worktreePath,
          baseRef,
          created,
          exitCode: run.exitCode,
          signal: run.signal,
          stdout: run.stdout,
          stderr: run.stderr,
          diff: { text: diff.text, truncated: diff.truncated },
          diffStat: { text: diffStat.text, truncated: diffStat.truncated },
          changedFiles: parseChangedFiles(status.stdout.text),
        }
      } catch (error: unknown) {
        primaryError = error
      } finally {
        clearTimeout(timer)
      }

      // Clean up the trial worktree on EVERY exit path (success or failure),
      // never masking the primary result or error.
      let cleanupError: string | undefined
      if (config.cleanup !== false) {
        try {
          await removeWorktree(ctx, repoRoot, git, worktreePath)
        } catch (error: unknown) {
          cleanupError = String(error)
        }
      }
      if (primaryError !== undefined) {
        const primary = primaryError instanceof Error ? primaryError : new Error(JSON.stringify(primaryError))
        if (cleanupError !== undefined) {
          throw new AggregateError(
            [primary, new Error(cleanupError)],
            `sandbox_exec failed: ${primary.message}; cleanup failed: ${cleanupError}`,
          )
        }
        throw primary
      }
      if (result === undefined) {
        throw new Error('sandbox_exec produced no result')
      }
      return cleanupError !== undefined
        ? { ...result, cleanupError }
        : result
    },
  }))
}
