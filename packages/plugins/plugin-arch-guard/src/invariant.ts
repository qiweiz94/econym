/**
 * Package-owned invariant companion for `@econym/dsh-plugin-arch-guard`.
 * @module @econym/dsh-plugin-arch-guard/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@econym/dsh-plugin-arch-guard'

/** Cordis companion plugin name. */
export const name = 'plugin-arch-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: config validated at apply time. The guard scans the
 * workspace package graph once at mount and answers check_module_boundary
 * calls as a pure function of that graph; it owns no package-local event
 * history or mutable data relation to assert.
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
