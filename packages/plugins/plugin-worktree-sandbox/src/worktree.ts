/**
 * Git worktree isolation and bounded capture for the sandbox tool: run a
 * command inside a disposable trial worktree under `.dsh/worktrees`, collect
 * the trial's uncommitted diff vs its base commit through the output-retention
 * envelope, and remove the worktree. All processes go through `ctx.subprocess`;
 * the tool owns only orchestration and reporting.
 * @module @deepseek-ai/dsh-plugin-worktree-sandbox/worktree
 */

import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { TextRetainer, type RetainedText } from '@deepseek-ai/dsh-output-retention'

/** A fully-specified spawned process's captured outcome. */
export interface ProcessOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: { readonly text: string; readonly truncated: boolean }
  readonly stderr: { readonly text: string; readonly truncated: boolean }
}

/**
 * Run one command, capturing stdout and stderr through the subprocess seam's
 * bounded collect (tail retention).
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param cwd - the child's working directory.
 * @param argv - executable and arguments; never shell-interpreted here.
 * @param maxBytes - in-memory byte cap for each stream.
 * @param signal - cancellation for the process tree.
 * @returns exit facts and the bounded streams.
 */
export async function runCommand(
  ctx: Context,
  cwd: string,
  argv: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ProcessOutcome> {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes },
      stderr: { maxBytes },
    },
    graceMs: 2_000,
    signal,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    /* v8 ignore next -- this spawn always configures bounded capture for stdout, so the collector exists. */
    stdout: { text: stdout?.text ?? '', truncated: stdout?.lossy ?? false },
    /* v8 ignore next -- this spawn always configures bounded capture for stderr, so the collector exists. */
    stderr: { text: stderr?.text ?? '', truncated: stderr?.lossy ?? false },
  }
}

/**
 * Collect one process's stdout through the output-retention envelope (head
 * strategy), returning the retained text with exact omission metadata.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param cwd - the child's working directory.
 * @param argv - executable and arguments.
 * @param maxBytes - the envelope's byte cap.
 * @param signal - cancellation for the process tree.
 * @returns the retained text plus the process's exit code.
 */
export async function collectRetained(
  ctx: Context,
  cwd: string,
  argv: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<RetainedText & { readonly exitCode: number | null }> {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    graceMs: 2_000,
    signal,
  })
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  const reader = handle.stdout
  const consume = (async (): Promise<void> => {
    /* v8 ignore next -- stdout is always piped by this spawn's stdio config, so the reader exists. */
    if (reader === undefined) return
    for await (const chunk of reader as AsyncIterable<Buffer>) {
      retainer.push(chunk)
    }
  })()
  const outcome = await handle.done
  await consume
  return { ...retainer.finish(), exitCode: outcome.exitCode }
}

/**
 * Whether a git worktree is already registered at `path` (absolute).
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param repoRoot - the main repository root; `git worktree list` runs there.
 * @param git - the git binary path.
 * @param path - the candidate trial worktree path.
 * @returns true when the worktree is registered.
 */
export async function worktreeExists(ctx: Context, repoRoot: string, git: string, path: string): Promise<boolean> {
  const list = await runCommand(ctx, repoRoot, [git, 'worktree', 'list', '--porcelain'], 16_384)
  // `git worktree list` prints the resolved path; on macOS a `tmpdir()`-based
  // path is `/var/folders/...` while git reports `/private/var/folders/...`,
  // so match the realpath and the given path.
  const candidates = new Set<string>([path])
  try {
    candidates.add(realpathSync(path))
  } catch {
    // The worktree may not exist yet; the given path is the only candidate.
  }
  return list.stdout.text
    .split('\n')
    .some(line => line.startsWith('worktree ') && candidates.has(line.slice('worktree '.length)))
}

/**
 * Resolve a ref (e.g. `HEAD`) to its commit hash.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param repoRoot - the main repository root.
 * @param git - the git binary path.
 * @param ref - the base ref to resolve.
 * @returns the resolved commit hash.
 */
export async function resolveBaseCommit(ctx: Context, repoRoot: string, git: string, ref: string): Promise<string> {
  const resolved = await runCommand(ctx, repoRoot, [git, 'rev-parse', `${ref}^{commit}`], 4_096)
  if (resolved.exitCode !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${resolved.stderr.text || resolved.stdout.text}`)
  }
  return resolved.stdout.text.trim()
}

/**
 * Resolve a trial worktree's own HEAD commit. For a fresh worktree this is the
 * base commit it was detached from; for a reused trial it is the trial's
 * current head, so the returned diff stays anchored to the trial's base even
 * when the main branch moves between calls.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param worktreePath - the trial worktree path to inspect.
 * @param git - the git binary path.
 * @param signal - cancellation for the process tree.
 * @returns the trial worktree's HEAD commit hash.
 */
export async function resolveWorktreeHead(ctx: Context, worktreePath: string, git: string, signal?: AbortSignal): Promise<string> {
  const resolved = await runCommand(ctx, worktreePath, [git, 'rev-parse', 'HEAD'], 4_096, signal)
  if (resolved.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed in trial worktree: ${resolved.stderr.text || resolved.stdout.text}`)
  }
  return resolved.stdout.text.trim()
}

/**
 * Add a detached trial worktree at `path` from `commit`.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param repoRoot - the main repository root.
 * @param git - the git binary path.
 * @param path - the trial worktree path to create.
 * @param commit - the commit the worktree detaches from.
 */
export async function addWorktree(ctx: Context, repoRoot: string, git: string, path: string, commit: string): Promise<void> {
  const added = await runCommand(ctx, repoRoot, [git, 'worktree', 'add', '--detach', path, commit], 8_192)
  if (added.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${added.stderr.text || added.stdout.text}`)
  }
}

/**
 * Remove a trial worktree (forced, so uncommitted trial changes are discarded).
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param repoRoot - the main repository root.
 * @param git - the git binary path.
 * @param path - the trial worktree path to remove.
 */
export async function removeWorktree(ctx: Context, repoRoot: string, git: string, path: string): Promise<void> {
  const removed = await runCommand(ctx, repoRoot, [git, 'worktree', 'remove', '--force', path], 8_192)
  if (removed.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${removed.stderr.text || removed.stdout.text}`)
  }
}

/**
 * Parse `git status --porcelain` lines into changed/added file paths.
 * @param porcelain - the `git status --porcelain` output.
 * @returns the changed or added file paths.
 */
export function parseChangedFiles(porcelain: string): string[] {
  const files: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length === 0) continue
    // Two status columns, then a space, then the path (quoted when it contains
    // special characters). Renames use the destination after ` -> `.
    /* v8 ignore next -- String.split always yields at least one segment, so pop() cannot return undefined. */
    const path = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() ?? ''
    if (path.length > 0) files.push(path)
  }
  return files
}
