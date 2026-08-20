/**
 * Pure types of the pinned-scratchpad domain: the ONE home of the
 * `scratchpad/write` session-event declaration plus its payload type, free of
 * this package's host-side value imports (dsh-tools, schemastery).
 *
 * @module @deepseek-ai/dsh-plugin-pinned-scratchpad/types
 */

import type {} from '@deepseek-ai/dsh-session/types'

/**
 * One pinned scratchpad entry — the unit of the `scratchpad/write` session
 * event's whole-store snapshot.
 *
 * Deliberately minimal: a `key` label and a `value` fact. No id or timestamp —
 * the store is replaced wholesale on every write (last-write-wins), keys are
 * unique within a snapshot, and entries keep insertion order.
 */
export interface ScratchpadEntry {
  /** Entry name: non-empty, trimmed, single-line, unique within a snapshot. */
  key: string
  /** The pinned fact: a non-empty, trimmed string; it may span several lines. */
  value: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-store scratchpad snapshot; latest write wins on replay. Log-only
     * (never derived history), but model-visible: the `scratchpad:pinned`
     * prompt section renders the latest snapshot into every request, so the
     * event is required-on-read and never carries the envelope's `ignorable`
     * marker — a reader that does not know this type must refuse the log
     * rather than silently drop pinned state.
     * @param data - the complete replacement entry list, in insertion order.
     */
    'scratchpad/write': { entries: ScratchpadEntry[] }
  }
}
