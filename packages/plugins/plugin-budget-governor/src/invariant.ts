/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-budget-governor`.
 * @module @deepseek-ai/dsh-plugin-budget-governor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-budget-governor'

/** Cordis companion plugin name. */
export const name = 'plugin-budget-governor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the governor's per-run telemetry is private to its own
 * listeners and exposes no package-owned event or snapshot an independent
 * companion can observe; the `subagent/start`/`subagent/end` pairing it keys on
 * is owned and asserted by `@deepseek-ai/dsh-subagent`.
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
