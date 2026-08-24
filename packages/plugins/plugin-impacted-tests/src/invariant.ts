/**
 * Package-owned invariant companion for `@econym/dsh-plugin-impacted-tests`.
 * @module @econym/dsh-plugin-impacted-tests/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@econym/dsh-plugin-impacted-tests'

/** Cordis companion plugin name. */
export const name = 'plugin-impacted-tests-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the selector owns no package-local event history or
 * durable mutable data — each call derives the import graph from the working
 * tree, runs the selected suites, and retains nothing, so there is no owned
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
