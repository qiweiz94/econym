/**
 * Bounded check execution for the diagnostic tool: spawn one check command
 * through `ctx.subprocess` and head-retain both output streams at the
 * output-retention envelope, so the sifter always sees the FIRST diagnostics
 * (checks report errors from the start of their output). The tool owns only
 * orchestration; command construction stays config-owned in the plugin.
 * @module @econym/dsh-plugin-diagnostic-sifter/spawn
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { TextRetainer, type RetainedText } from '@deepseek-ai/dsh-output-retention'

/** One spawned check's captured outcome: exit facts plus head-retained streams. */
export interface CheckOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: RetainedText
  readonly stderr: RetainedText
}

/**
 * Run one check command, head-retaining stdout and stderr at `maxBytes` each.
 * @param ctx - the Cordis context carrying `ctx.subprocess`.
 * @param cwd - the check's working directory.
 * @param argv - executable and arguments; never shell-interpreted here.
 * @param maxBytes - the envelope's byte cap for each stream.
 * @param signal - cancellation for the process tree.
 * @returns exit facts and the bounded streams; rejects on spawn-level failure.
 */
export async function runCheck(
  ctx: Context,
  cwd: string,
  argv: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CheckOutcome> {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 2_000,
    signal,
    // Protocol hygiene, not a tunable: the sifter's regexes match plain ASCII
    // diagnostic lines. `--pretty false` already disables tsc's colorizer;
    // vitest's own reporter does honor a non-TTY pipe, but a startup-time
    // failure (e.g. an unresolvable vitest.config) is formatted by Vite's own
    // error reporter, which colorizes unconditionally — pin `NO_COLOR` so
    // that path can never leak ANSI escapes into the captured output either.
    env: { NO_COLOR: '1' },
  })
  const stdout = new TextRetainer({ kind: 'head', maxBytes })
  const stderr = new TextRetainer({ kind: 'head', maxBytes })
  const consume = async (reader: AsyncIterable<Buffer> | undefined, retainer: TextRetainer): Promise<void> => {
    /* v8 ignore next -- both streams are always piped by this spawn's stdio config, so the readers exist. */
    if (reader === undefined) return
    for await (const chunk of reader) retainer.push(chunk)
  }
  const [outcome] = await Promise.all([
    handle.done,
    consume(handle.stdout, stdout),
    consume(handle.stderr, stderr),
  ])
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout.finish(),
    stderr: stderr.finish(),
  }
}
