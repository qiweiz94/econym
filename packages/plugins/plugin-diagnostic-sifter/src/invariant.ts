/**
 * Package-owned invariant companion for `@econym/dsh-plugin-diagnostic-sifter`.
 * @module @econym/dsh-plugin-diagnostic-sifter/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@econym/dsh-plugin-diagnostic-sifter'

/** Cordis companion plugin name. */
export const name = 'plugin-diagnostic-sifter-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the sifter owns no package-local event history or
 * durable mutable data — each call spawns one check process and returns a
 * bounded value derived only from that process's output, so there is no owned
 * relationship to assert.
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
