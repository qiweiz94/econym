/**
 * `run_diagnostic_check` tool: run the repository's typecheck (`tsc -b`) or a
 * scoped test run (`vitest run`) through `ctx.subprocess`, then sift the output
 * into root-cause diagnostics — module-resolution cascades suppressed, exact
 * duplicates merged, only failed-assertion detail retained — bounded by the
 * output-retention envelope. A failing exit the sifter cannot explain is
 * reported as a parse failure carrying the bounded raw output, so absence of
 * parsed diagnostics never reads as a clean run. Named exports preserve loader
 * injection metadata.
 * @module @econym/dsh-plugin-diagnostic-sifter
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { DiagnosticCheckResult, DiagnosticCommand, DiagnosticRootCause } from './types.ts'
import { boundRootCauses, retainRaw, siftTest, siftTypecheck } from './sifter.ts'
import { runCheck } from './spawn.ts'

export const name = 'plugin-diagnostic-sifter'
export const inject = ['tools', 'subprocess']

/** Runtime configuration for the diagnostic tool. */
export interface Config {
  /** Directory the checks run in (the repository root); defaults to the process cwd. */
  cwd?: string
  /**
   * Typecheck argv (executable first); defaults to
   * `['node_modules/.bin/tsc', '-b', '--pretty', 'false']` — a `cwd`-relative
   * executable path the OS resolves directly, like {@link vitestBin}, never a
   * bare name that depends on an ambient `PATH` possibly resolving to an
   * unrelated global install; `--pretty false` is the sifter's input-format
   * contract with `siftTypecheck` (its `TSC_LOCATED`/`TSC_GLOBAL` patterns
   * match only the non-pretty, single-line diagnostic layout), not a
   * deployment-varying choice, so it stays in the default rather than
   * becoming independently configurable. A `targetPath` argument is appended.
   */
  tscArgs?: string[]
  /** Vitest executable; defaults to `node_modules/.bin/vitest` (resolved by the OS against `cwd`). */
  vitestBin?: string
  /** Output-retention envelope in bytes; defaults to 15_000 (15 KB). */
  maxOutputBytes?: number
  /** Per-check timeout in milliseconds; defaults to 120_000. */
  timeoutMs?: number
  /** Model-facing tool name; defaults to `run_diagnostic_check`. */
  toolName?: string
}

/** Runtime configuration schema for the diagnostic tool. */
export const Config: z<Config> = z.object({
  cwd: z.string().default(process.cwd()),
  tscArgs: z.array(String).default(['node_modules/.bin/tsc', '-b', '--pretty', 'false']),
  vitestBin: z.string().default('node_modules/.bin/vitest'),
  maxOutputBytes: z.number().step(1).min(1).default(15_000),
  timeoutMs: z.number().step(1).min(1).default(120_000),
  toolName: z.string().default('run_diagnostic_check'),
})

/** One root cause's model-facing line. */
function formatRootCause(cause: DiagnosticRootCause): string {
  const location = cause.file.length > 0 ? `${cause.file}:${cause.line}` : '(project)'
  return `${location}${cause.code === undefined ? '' : ` [${cause.code}]`} ${cause.message}`
}

/** Render the structured diagnostic result as model-facing text. */
function renderDiagnosticResult(result: DiagnosticCheckResult): string {
  const status = result.exitCode === 0
    ? 'exit 0'
    : result.signal !== null
      ? `killed by signal ${result.signal}`
      : `exit ${result.exitCode}`
  if (result.parseFailure) {
    const lines = [
      `${result.command}: ${status}; output was NOT recognized as ${result.command} diagnostics (parse failure — do not read this as a clean run)`,
    ]
    if (result.raw !== undefined && result.raw.text.trim().length > 0) {
      lines.push(`raw output:\n${result.raw.text}${result.raw.truncated ? '\n[raw output truncated by the output envelope]' : ''}`)
    }
    return lines.join('\n')
  }
  if (result.rootCauses.length === 0) {
    return `${result.command} clean: ${status}, no diagnostics`
  }
  const counts = [`${result.rootCauses.length} root cause${result.rootCauses.length === 1 ? '' : 's'}`]
  if (result.suppressedCascadeCount > 0) counts.push(`${result.suppressedCascadeCount} cascade error${result.suppressedCascadeCount === 1 ? '' : 's'} suppressed`)
  if (result.deduplicatedCount > 0) counts.push(`${result.deduplicatedCount} duplicate${result.deduplicatedCount === 1 ? '' : 's'} merged`)
  const lines = [
    `${result.command}: ${status}; ${counts.join(', ')}`,
    ...result.rootCauses.map(formatRootCause),
  ]
  if (result.truncated) lines.push('[root causes truncated by the output envelope]')
  return lines.join('\n')
}

/** The durable presentation projection persisted with each result. */
interface DiagnosticMeta {
  command: string
  success: boolean
  parseFailure: boolean
  rootCauseCount: number
  top: string[]
}

/** Narrow a replayed presentation payload back to {@link DiagnosticMeta}. */
function asDiagnosticMeta(meta: unknown): DiagnosticMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  if (typeof record.command !== 'string' || typeof record.success !== 'boolean'
    || typeof record.parseFailure !== 'boolean' || typeof record.rootCauseCount !== 'number'
    || !Array.isArray(record.top) || record.top.some(entry => typeof entry !== 'string')) return undefined
  return record as unknown as DiagnosticMeta
}

/**
 * Validate and contain the model-supplied `targetPath` before it becomes a
 * spawned argv. A check runs the TARGET's own vitest/tsc config, so a path that
 * escapes `cwd` — `../..`, or an absolute path elsewhere — would load and
 * execute a foreign config; a leading dash would inject an option. Both are
 * rejected before spawn.
 * @param raw - the model-supplied path, or `undefined` when omitted.
 * @param cwd - the working directory the check runs in and the path is contained to.
 * @returns the cwd-relative path to pass as an argv (`.` for the cwd itself), or `undefined` when omitted.
 * @throws Error when the path is empty, option-injecting, or escapes `cwd`.
 */
function containTargetPath(raw: string | undefined, cwd: string): string | undefined {
  if (raw === undefined) return undefined
  // The path lands in a spawned argv; the tool JSON validator cannot express
  // "no leading dash", so reject option injection outright.
  if (raw.length === 0 || raw.startsWith('-')) {
    throw new Error(`invalid targetPath ${JSON.stringify(raw)}: must be a non-empty path and must not start with '-'`)
  }
  const rel = relative(cwd, resolve(cwd, raw))
  if (rel.startsWith('..')) {
    throw new Error(`invalid targetPath ${JSON.stringify(raw)}: must stay within the working directory`)
  }
  /* v8 ignore next 3 -- a non-'..' absolute rel means a different Windows drive; posix relative() never returns one */
  if (isAbsolute(rel)) {
    throw new Error(`invalid targetPath ${JSON.stringify(raw)}: must stay within the working directory`)
  }
  return rel === '' ? '.' : rel
}

/**
 * Register the diagnostic tool.
 * @param ctx - Cordis context carrying the tool registry and subprocess service.
 * @param config - diagnostic configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tscArgs = config.tscArgs ?? ['node_modules/.bin/tsc', '-b', '--pretty', 'false']
  if (tscArgs.length === 0) {
    throw new Error('plugin-diagnostic-sifter: tscArgs must name an executable (got an empty array)')
  }
  ctx.tools.register(defineTool({
    name: config.toolName ?? 'run_diagnostic_check',
    description: 'Run the repository typecheck or a scoped test run and return only the root-cause diagnostics: downstream module-resolution cascade errors are suppressed and counted, duplicate diagnostics are merged, and test output keeps only failed-assertion detail. A failing run whose output could not be parsed is reported as a parse failure with the raw output — it is never a clean result.',
    parameters: {
      command: {
        required: true,
        description: 'Which check to run: `typecheck` (the configured tsc build) or `test` (the configured vitest run).',
        oneOf: [
          { type: 'string', const: 'typecheck' },
          { type: 'string', const: 'test' },
        ],
      },
      targetPath: {
        type: 'string',
        description: 'Optional path scoping the check, relative to the configured working directory and contained within it: a tsc project/directory for `typecheck`, a test file or directory for `test`. Omit to check everything.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'diagnostic' },
          command: { required: true, oneOf: [{ type: 'string', const: 'typecheck' }, { type: 'string', const: 'test' }] },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          success: { type: 'boolean', required: true },
          parseFailure: { type: 'boolean', required: true },
          rootCauses: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                code: { type: 'string' },
                message: { type: 'string', required: true },
              },
            },
          },
          suppressedCascadeCount: { type: 'integer', required: true },
          deduplicatedCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          raw: {
            type: 'object', additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDiagnosticResult(value) }],
      presentationMeta: (_args, value) => ({
        command: value.command,
        success: value.success,
        parseFailure: value.parseFailure,
        rootCauseCount: value.rootCauses.length,
        top: value.rootCauses.slice(0, 3).map(cause => cause.file.length > 0 ? `${cause.file}:${cause.line}` : '(project)'),
      }),
    },
    async execute(args, exec) {
      const command: DiagnosticCommand = args.command
      const cwd = config.cwd ?? process.cwd()
      const targetPath = containTargetPath(args.targetPath, cwd)
      const envelope = config.maxOutputBytes ?? 15_000
      const argv = command === 'typecheck'
        ? [...tscArgs, ...targetPath === undefined ? [] : [targetPath]]
        : [config.vitestBin ?? 'node_modules/.bin/vitest', 'run', ...targetPath === undefined ? [] : [targetPath]]

      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, config.timeoutMs ?? 120_000)
      let run
      try {
        run = await runCheck(ctx, cwd, argv, envelope, AbortSignal.any([exec.signal, controller.signal]))
      } finally {
        clearTimeout(timer)
      }

      const combined = [run.stdout.text, run.stderr.text].filter(text => text.length > 0).join('\n')
      const sift = command === 'typecheck' ? siftTypecheck(combined) : siftTest(combined)
      const bounded = boundRootCauses(sift.rootCauses, envelope)
      // A failing exit MUST be explained by parsed diagnostics; an unexplained
      // failure (or unrecognized output) is a parse failure carrying the raw text.
      // Checked against the PRE-bounding sift result: a tiny output envelope can
      // legitimately empty `bounded.rootCauses` (see `boundRootCauses`'s
      // `prefixBytes >= remaining` early return) without that being a parse
      // failure — `truncated` carries that story instead.
      const parseFailure = !sift.recognized
        || (run.exitCode !== 0 && sift.rootCauses.length === 0 && sift.suppressedCascadeCount === 0)
      const result: DiagnosticCheckResult = {
        kind: 'diagnostic',
        command,
        exitCode: run.exitCode,
        signal: run.signal,
        success: run.exitCode === 0,
        parseFailure,
        rootCauses: bounded.rootCauses,
        suppressedCascadeCount: sift.suppressedCascadeCount,
        deduplicatedCount: sift.deduplicatedCount,
        truncated: bounded.truncated || run.stdout.truncated || run.stderr.truncated,
      }
      return parseFailure ? { ...result, raw: retainRaw(combined, envelope) } : result
    },
    // Pure display: args name the check and optional scope; no result data exists yet.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Diagnose ${args.command}${args.targetPath === undefined ? '' : ` ${args.targetPath}`}`,
        kind: 'execute',
        ...args.targetPath === undefined ? {} : { locations: [{ path: args.targetPath }] },
      }
    },
    // Pure display over the persisted projection; malformed replayed meta falls
    // back to the generic presentation.
    presentResult(_args, result: ToolResult): GenericResultView | undefined {
      const meta = asDiagnosticMeta(result.meta)
      if (meta === undefined) return undefined
      const title = meta.parseFailure
        ? `${meta.command}: parse failure`
        : meta.success && meta.rootCauseCount === 0
          ? `${meta.command}: clean`
          : `${meta.command}: ${meta.rootCauseCount} root cause${meta.rootCauseCount === 1 ? '' : 's'}`
      return {
        card: 'generic',
        title,
        ...meta.top.length === 0 ? {} : { content: [{ type: 'text', text: meta.top.join('\n') }] },
      }
    },
  }))
}
