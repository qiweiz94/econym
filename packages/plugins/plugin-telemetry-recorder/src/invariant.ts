/**
 * Package-owned invariant companion for `@econym/dsh-plugin-telemetry-recorder`.
 * @module @econym/dsh-plugin-telemetry-recorder/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@econym/dsh-plugin-telemetry-recorder'

/** Cordis companion plugin name. */
export const name = 'plugin-telemetry-recorder-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns no event stream and no durable data.
 * Its recorder is a derived read-only fold over events other packages own and
 * already check — `turn/start`/`turn/end` pairing and monotonic turn numbers
 * belong to dsh-agent-loop, usage accounting to the session surface, and
 * `subagent/start`/`subagent/end` run-id pairing to dsh-subagent's own
 * companion. Asserting any of them here would restate another package's
 * contract instead of an owned relationship.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
