/**
 * `run_impacted_tests` tool: select the test suites a change can actually
 * break by walking the workspace import DAG in reverse from the changed files,
 * then execute strictly those suites through the configured runner. With no
 * changes it runs nothing; a changed file no suite imports selects nothing.
 * Named exports preserve loader injection metadata.
 * @module @econym/dsh-plugin-impacted-tests
 */

import type { Context } from '@deepseek-ai/cordis'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { analyzeImpact, parseGitStatus } from './analyzer.ts'
import type { ImpactedTestsResult, RetainedOutput, SuiteRunOutcome, SuiteRunner } from './types.ts'

export const name = 'plugin-impacted-tests'
export const inject = ['tools', 'subprocess']

/** The empty bounded record used wherever no process ran. */
const NO_OUTPUT: RetainedOutput = { text: '', truncated: false }

/** Runtime configuration for the impacted-tests tool. */
export interface Config {
  /** Repository root; defaults to the process cwd. */
  cwd?: string
  /** The tsconfig whose `paths` drive module resolution; defaults to `tsconfig.base.json`. */
  tsconfigPath?: string
  /** Root-relative globs naming the selectable suites. */
  testPatterns?: string[]
  /** Argv prefix the selected suites are appended to; defaults to the repo's vitest. */
  runnerCommand?: string[]
  /** Refuse to run more than this many suites in one call; defaults to 200. */
  maxSuites?: number
  /** Output-retention envelope in bytes; defaults to 15_000 (15 KB). */
  maxOutputBytes?: number
  /** Runner timeout in milliseconds; defaults to 600_000. */
  timeoutMs?: number
  /** Model-facing tool name; defaults to `run_impacted_tests`. */
  toolName?: string
  /** Path to the git binary; defaults to `git`. */
  gitBinary?: string
}

/** Runtime configuration schema for the impacted-tests tool. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  tsconfigPath: z.string().default('tsconfig.base.json'),
  testPatterns: z.array(z.string()).default(['packages/*/*/tests/**/*.spec.ts', 'packages/*/*/tests/**/*.spec.tsx']),
  runnerCommand: z.array(z.string()).default(['node', 'node_modules/vitest/vitest.mjs', 'run']),
  maxSuites: z.number().step(1).min(1).default(200),
  maxOutputBytes: z.number().step(1).min(1).default(15_000),
  timeoutMs: z.number().step(1).min(1).default(600_000),
  toolName: z.string().default('run_impacted_tests'),
  gitBinary: z.string().default('git'),
})

/**
 * Spawn one process and retain both streams through the output-retention
 * envelope with the `tail` strategy: a runner's verdict and its failure
 * summary are at the END of the stream, so a run over the envelope keeps the
 * part that answers the call.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param cwd - the child's working directory.
 * @param argv - executable and arguments; never shell-interpreted.
 * @param maxBytes - the envelope's byte cap per stream.
 * @param signal - cancellation for the process tree.
 * @returns the exit facts and both retained streams.
 */
async function runRetained(
  ctx: Context,
  cwd: string,
  argv: readonly string[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<SuiteRunOutcome> {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 2_000,
    signal,
  })
  const stdout = new TextRetainer({ kind: 'tail', maxBytes })
  const stderr = new TextRetainer({ kind: 'tail', maxBytes })
  /* jscpd:ignore-start -- mirrors plugin-diagnostic-sifter's runDiagnostic; each plugin owns its one-shot spawn-and-drain independently. */
  const drain = async (reader: AsyncIterable<Buffer> | undefined, into: TextRetainer): Promise<void> => {
    /* v8 ignore next -- this spawn pipes both streams, so both readers exist. */
    if (reader === undefined) return
    for await (const chunk of reader) into.push(chunk)
  }
  const consumed = Promise.all([
    drain(handle.stdout as AsyncIterable<Buffer> | undefined, stdout),
    drain(handle.stderr as AsyncIterable<Buffer> | undefined, stderr),
  ])
  const outcome = await handle.done
  await consumed
  const retainedOut = stdout.finish()
  const retainedErr = stderr.finish()
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: { text: retainedOut.text, truncated: retainedOut.truncated },
    stderr: { text: retainedErr.text, truncated: retainedErr.truncated },
  }
  /* jscpd:ignore-end */
}

/** Render the structured selection as model-facing text. */
function renderResult(result: ImpactedTestsResult): string {
  const changed = `${result.changedFiles.length} changed file${result.changedFiles.length === 1 ? '' : 's'}`
  if (result.selectedSuites.length === 0) {
    return `${changed}; no test suite imports them — ${result.skippedCount} suite${result.skippedCount === 1 ? '' : 's'} skipped, nothing run.`
  }
  const verdict = result.results.exitCode === 0
    ? 'all selected suites passed'
    : result.results.signal !== null
      ? `the runner was killed by signal ${result.results.signal}`
      : `the runner exited ${result.results.exitCode}`
  const lines = [
    `${changed} select ${result.selectedSuites.length} suite${result.selectedSuites.length === 1 ? '' : 's'} (${result.skippedCount} skipped): ${verdict}.`,
    ...result.selectedSuites.map(suite => `  ${suite}`),
  ]
  const stdout = result.results.stdout.text.trim()
  const stderr = result.results.stderr.text.trim()
  if (stdout.length > 0) lines.push(`runner stdout:\n${stdout}${result.results.stdout.truncated ? '\n[stdout truncated to the tail by the output envelope]' : ''}`)
  if (stderr.length > 0) lines.push(`runner stderr:\n${stderr}${result.results.stderr.truncated ? '\n[stderr truncated to the tail by the output envelope]' : ''}`)
  return lines.join('\n')
}

/** Every configuration field settled, so no call-time code re-decides a default. */
type ResolvedConfig = Required<Config>

/**
 * Settle the configuration once, at registration. The schema fills these for a
 * config-mounted plugin; this step is what makes a direct `apply(ctx, {})`
 * equally well-specified, and keeps `execute` free of hidden defaulting.
 * @param config - the author-facing configuration.
 * @returns every field settled.
 */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    cwd: config.cwd ?? process.cwd(),
    tsconfigPath: config.tsconfigPath ?? 'tsconfig.base.json',
    testPatterns: config.testPatterns ?? ['packages/*/*/tests/**/*.spec.ts', 'packages/*/*/tests/**/*.spec.tsx'],
    runnerCommand: config.runnerCommand ?? ['node', 'node_modules/vitest/vitest.mjs', 'run'],
    maxSuites: config.maxSuites ?? 200,
    maxOutputBytes: config.maxOutputBytes ?? 15_000,
    timeoutMs: config.timeoutMs ?? 600_000,
    toolName: config.toolName ?? 'run_impacted_tests',
    gitBinary: config.gitBinary ?? 'git',
  }
}

/**
 * Register the impacted-tests tool.
 * @param ctx - Cordis context carrying the tool registry and subprocess service.
 * @param config - impacted-tests configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveConfig(config)
  const runSuites: SuiteRunner = (suites, signal) => runRetained(
    ctx,
    settings.cwd,
    [...settings.runnerCommand, ...suites],
    settings.maxOutputBytes,
    signal,
  )
  ctx.tools.register(defineTool({
    name: settings.toolName,
    description: 'Run only the test suites that a set of changed files can actually break. Builds the repository\'s '
      + 'import graph, finds every test suite that transitively imports a changed file, and runs strictly those '
      + 'suites. Omit `files` to use the uncommitted changes in the working tree. When nothing is changed, or when '
      + 'a changed file (a Markdown document, say) is imported by no suite, nothing is run — that is the answer, '
      + 'not a failure. Use it after editing source to get a fast, targeted verdict instead of the whole suite.',
    parameters: {
      files: {
        type: 'array',
        items: { type: 'string', description: 'A repo-relative path.' },
        description: 'The changed files to analyse. Omit to use the uncommitted modified files in the working tree.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'impacted-tests' },
          changedFiles: { type: 'array', required: true, items: { type: 'string' } },
          selectedSuites: { type: 'array', required: true, items: { type: 'string' } },
          skippedCount: { type: 'integer', required: true },
          results: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              executed: { type: 'boolean', required: true },
              /* jscpd:ignore-start -- mirrors plugin-worktree-sandbox's result schema; both independently describe a process outcome. */
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
              /* jscpd:ignore-end */
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      let changedFiles: string[]
      if (args.files === undefined) {
        const status = await runRetained(
          ctx,
          settings.cwd,
          [settings.gitBinary, 'status', '--porcelain'],
          settings.maxOutputBytes,
          exec.signal,
        )
        if (status.exitCode !== 0) {
          throw new Error(`git status --porcelain failed in ${settings.cwd}: ${status.stderr.text}${status.stdout.text}`)
        }
        changedFiles = parseGitStatus(status.stdout.text)
      } else {
        changedFiles = [...args.files]
      }

      const analysis = analyzeImpact({
        root: settings.cwd,
        changedFiles,
        testPatterns: settings.testPatterns,
        tsconfigPath: settings.tsconfigPath,
      })
      const base = {
        kind: 'impacted-tests',
        changedFiles,
        selectedSuites: analysis.selectedSuites,
        skippedCount: analysis.skippedCount,
      } as const

      if (analysis.selectedSuites.length === 0) {
        return { ...base, results: { executed: false, exitCode: null, signal: null, stdout: NO_OUTPUT, stderr: NO_OUTPUT } }
      }
      if (analysis.selectedSuites.length > settings.maxSuites) {
        throw new Error(`${analysis.selectedSuites.length} suites are impacted, exceeding the ${settings.maxSuites}-suite limit; narrow the change set or raise maxSuites`)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, settings.timeoutMs)
      try {
        const outcome = await runSuites(analysis.selectedSuites, AbortSignal.any([exec.signal, controller.signal]))
        return { ...base, results: { executed: true, ...outcome } }
      } finally {
        clearTimeout(timer)
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Run impacted tests',
      kind: 'execute',
      rawInput: args.files === undefined ? 'uncommitted changes' : args.files.join(' '),
    }),
  }))
}
