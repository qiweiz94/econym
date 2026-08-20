/** Package-owned durable scratchpad-snapshot invariants. @module @deepseek-ai/dsh-plugin-pinned-scratchpad/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-pinned-scratchpad'

/** Cordis companion plugin name. */
export const name = 'plugin-pinned-scratchpad-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one whole-store scratchpad snapshot before it reaches the durable
 * log.
 *
 * Deliberately silent on the rendered block's byte size. That is the tool's
 * per-deployment budget (`Config.totalBudget`), not a durable-shape rule: a
 * log written while a larger budget was configured must still replay after a
 * deployment shrinks the budget, so tying the invariant to the current config
 * would reject history that was valid when it was written.
 */
function validateEntries(value: unknown, fail: InvariantFailure): void {
  if (!Array.isArray(value)) fail('scratchpad/write entries must be an array')
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null) fail('scratchpad/write entries must be objects')
    const { key, value: fact } = item as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0 || key.trim() !== key || key.includes('\n') || key.includes('\r')) {
      fail('scratchpad/write key must be non-empty, single-line, and already trimmed')
    }
    if (seen.has(key)) fail(`scratchpad/write repeats key ${JSON.stringify(key)}`)
    seen.add(key)
    if (typeof fact !== 'string' || fact.length === 0 || fact.trim() !== fact) {
      fail(`scratchpad/write value for ${JSON.stringify(key)} must be non-empty and already trimmed`)
    }
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'scratchpad/write') validateEntries(event.data.entries, fail)
}

/** Install validation for loaded and newly appended whole-store scratchpad snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the scratchpad invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
