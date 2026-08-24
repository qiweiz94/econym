/**
 * Package-owned invariant companion for `@econym/dsh-plugin-subagent-router`.
 * @module @econym/dsh-plugin-subagent-router/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@econym/dsh-plugin-subagent-router'

/** Cordis companion plugin name. */
export const name = 'plugin-subagent-router-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the router owns no package-local event history or
 * mutable data — it derives each delegation's provider from the live
 * `ctx.subagents` registry at call time, so there is no owned relationship to
 * assert.
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
