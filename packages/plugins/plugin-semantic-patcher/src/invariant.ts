/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-semantic-patcher`.
 * @module @deepseek-ai/dsh-plugin-semantic-patcher/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-semantic-patcher'

/** Cordis companion plugin name. */
export const name = 'plugin-semantic-patcher-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each patch is decided entirely from the file text read
 * within the call and committed by a single atomic rename, so the package owns
 * no event history and no mutable data relation between calls. The consistency
 * this package does enforce — that a written file still parses — is checked in
 * memory before the write and so cannot be observed as a violated relation.
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
