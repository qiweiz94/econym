/**
 * Foreground run settlement for the routing delegation tool: collect and
 * release one one-shot subagent run, mapping a non-`completed` stop reason to
 * a tool error that still preserves the child's partial output.
 * @module @deepseek-ai/dsh-plugin-subagent-router/foreground
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ForegroundToolResult } from './types.ts'

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 * @param error - the stop-reason headline.
 * @param output - the child's selected output (`SubagentResult.output`).
 * @returns the headline, extended with the partial text when any exists.
 */
function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/**
 * Render text blocks from the canonical JSON block array without trusting
 * arbitrary values.
 * @param values - the tool result's JSON block array.
 * @returns the concatenated text of the text blocks.
 */
export function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 * @param run - the published one-shot run to settle.
 * @returns the foreground tool result value.
 * @throws the result failure, or the disposal failure when only disposal failed.
 */
export async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withPartialText(error, result.output))
      }
      return {
        kind: 'foreground',
        runId: run.id,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}
