/**
 * Compaction-resistant per-session working memory. `scratchpad_update` upserts
 * or deletes one entry in a per-session key/value store; each accepted call
 * appends a `scratchpad/write` whole-store snapshot to the calling agent's
 * session (replay is last-write-wins), and the `scratchpad:pinned` system-prompt
 * section re-renders the latest snapshot as a bounded `<agent_scratchpad>`
 * block on every request. The system prompt is reassembled per request and
 * never compacted, so pinned facts survive context compaction by construction.
 * State is folded from the session log alone — resume and fork restore it with
 * no live mirror. A non-agent caller has no owning session and is rejected.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-pinned-scratchpad
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: the AssembleContext `agent` field this package's section provider reads.
import type {} from '@deepseek-ai/dsh-agent'
import type { ScratchpadEntry } from './types.ts'
// The `scratchpad/write` event declaration lives in src/types.ts (its one
// home); this re-export projects the type face onto the package root AND keeps
// the module edge in the emitted index.d.ts, so aggregate programs consuming
// the declarations still receive the SessionEventMap merge.
export type * from './types.ts'

export const name = 'plugin-pinned-scratchpad'
export const inject = ['tools', 'systemPrompt']

/** Pinned-scratchpad configuration. */
export interface Config {
  /**
   * Byte budget for the complete rendered `<agent_scratchpad>` block: the
   * UTF-8 byte length of the block, wrapper tags included. An update that
   * would overflow it fails loud naming the needed, allowed, and current byte
   * counts; stored entries are never silently truncated. The bound is bytes,
   * not tokens — the harness has no tokenizer for the serving model, so a
   * token bound would be a guess. Default 1000.
   */
  totalBudget: number
}

/** Schemastery configuration for the pinned-scratchpad plugin. */
export const Config: z<Config> = z.object({
  totalBudget: z.number().step(1).min(1).default(1000),
})

/** Opening line of the rendered scratchpad block. */
const OPEN_TAG = '<agent_scratchpad>'

/** Closing line of the rendered scratchpad block. */
const CLOSE_TAG = '</agent_scratchpad>'

/**
 * Render the model-visible scratchpad block: one `key: value` line per entry
 * between the wrapper tags, in insertion order.
 * @param entries - the entry store to render.
 * @returns the block, or `''` for an empty store (an empty section contributes nothing to the prompt).
 */
function renderScratchpad(entries: readonly ScratchpadEntry[]): string {
  if (entries.length === 0) return ''
  return [OPEN_TAG, ...entries.map(entry => `${entry.key}: ${entry.value}`), CLOSE_TAG].join('\n')
}

/**
 * The UTF-8 byte length of the rendered block — the complete retained value
 * {@link Config.totalBudget} bounds, wrapper tags included.
 * @param entries - the entry store to measure.
 * @returns the rendered block's byte length; `0` for an empty store.
 */
function usedBytes(entries: readonly ScratchpadEntry[]): number {
  return Buffer.byteLength(renderScratchpad(entries), 'utf8')
}

/** The smallest budget that admits any entry: the minimal one-entry block. */
const MIN_TOTAL_BUDGET = usedBytes([{ key: 'k', value: 'v' }])

/**
 * The current entry store folded from one session log: the latest
 * `scratchpad/write` snapshot, or the empty store before the first write.
 * @param events - the owning session's event log.
 * @returns the current entries, in insertion order.
 */
function foldScratchpad(events: readonly SessionEvent[]): readonly ScratchpadEntry[] {
  const last = events.findLast(
    (event): event is SessionEvent<'scratchpad/write'> => event.type === 'scratchpad/write',
  )
  return last?.data.entries ?? []
}

const DESCRIPTION =
  'Pin a fact to your scratchpad, or remove one. The scratchpad renders in '
  + 'every request as the <agent_scratchpad> block of your system prompt and '
  + 'survives context compaction, so keep the few facts you must not lose '
  + 'there: the current goal, key decisions, file paths, ids. A string value '
  + 'adds or replaces the entry under key; null deletes it. The whole rendered '
  + 'block is capped by a byte budget — an update that would overflow fails '
  + 'and reports the usage, so keep entries short and delete stale ones.'

/**
 * Register the `scratchpad_update` tool on `ctx.tools` and the
 * `scratchpad:pinned` prompt section on `ctx.systemPrompt`.
 * @param ctx - registrant context carrying the tool registry and prompt registry.
 * @param config - deployment's explicit byte budget.
 */
export function apply(ctx: Context, config: Config): void {
  const totalBudget = config.totalBudget
  if (totalBudget < MIN_TOTAL_BUDGET) {
    throw new Error(
      `plugin-pinned-scratchpad: totalBudget must be at least ${MIN_TOTAL_BUDGET} bytes`
      + ` (the smallest one-entry block); got ${totalBudget}`,
    )
  }

  ctx.systemPrompt.section({
    name: 'scratchpad:pinned',
    // Tail order: the block changes on every accepted scratchpad_update, so it
    // renders after the stable sections — an update rewrites only the prompt
    // tail and leaves the cacheable prefix byte-identical (the plan:policy
    // order-1000 rationale; this section sits just after it).
    order: 1010,
    text: context => context.agent === undefined
      ? ''
      : renderScratchpad(foldScratchpad(context.agent.session.events)),
  })

  ctx.tools.register(defineTool({
    name: 'scratchpad_update',
    description: DESCRIPTION,
    parameters: {
      key: {
        type: 'string',
        required: true,
        description: 'Entry name — short and single-line. An existing key is replaced or deleted; a new key is appended.',
      },
      value: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        required: true,
        description: 'The fact to pin under key, or null to delete the entry.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['set', 'delete'] },
          key: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                value: { type: 'string', required: true },
              },
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              usedBytes: { type: 'integer', required: true },
              budgetBytes: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Scratchpad ${value.action === 'set' ? 'set' : 'deleted'} "${value.key}": `
          + `${value.entries.length} ${value.entries.length === 1 ? 'entry' : 'entries'} using `
          + `${value.usage.usedBytes} of ${value.usage.budgetBytes} budget bytes.`,
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        // The store is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('scratchpad_update requires an owning agent session')
      }
      const key = args.key.trim()
      if (key.length === 0) {
        throw new Error('invalid scratchpad key: must be a non-empty string')
      }
      if (key.includes('\n') || key.includes('\r')) {
        throw new Error(`invalid scratchpad key ${JSON.stringify(key)}: must be a single line`)
      }
      const session = exec.agent.session
      const current = foldScratchpad(session.events)
      let action: 'set' | 'delete'
      let next: ScratchpadEntry[]
      if (args.value === null) {
        action = 'delete'
        if (!current.some(entry => entry.key === key)) {
          const known = current.map(entry => JSON.stringify(entry.key)).join(', ')
          throw new Error(`scratchpad key ${JSON.stringify(key)} does not exist; current keys: ${known.length > 0 ? known : '(none)'}`)
        }
        next = current.filter(entry => entry.key !== key)
      } else {
        action = 'set'
        const value = args.value.trim()
        if (value.length === 0) {
          throw new Error(`invalid scratchpad value for ${JSON.stringify(key)}: must be non-empty (pass null to delete the entry)`)
        }
        next = current.some(entry => entry.key === key)
          ? current.map(entry => entry.key === key ? { key, value } : entry)
          : [...current, { key, value }]
        const needed = usedBytes(next)
        if (needed > totalBudget) {
          throw new Error(
            `scratchpad update would need ${needed} bytes but totalBudget is ${totalBudget} bytes`
            + ` (currently ${usedBytes(current)} used); shorten the value or delete entries first`,
          )
        }
      }
      session.append('scratchpad/write', { entries: next })
      return Promise.resolve({
        action,
        key,
        entries: next.map(entry => ({ key: entry.key, value: entry.value })),
        usage: { usedBytes: usedBytes(next), budgetBytes: totalBudget },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update scratchpad', kind: 'other', rawInput: args }),
  }))
}
