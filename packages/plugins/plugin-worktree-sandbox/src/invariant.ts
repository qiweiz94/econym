/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-worktree-sandbox`.
 * @module @deepseek-ai/dsh-plugin-worktree-sandbox/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-worktree-sandbox'

/** Cordis companion plugin name. */
export const name = 'plugin-worktree-sandbox-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the sandbox owns no package-local event history or
 * durable mutable data — each call creates, uses, and (by default) removes a
 * git worktree derived from the repo state, so there is no owned relationship
 * to assert.
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
