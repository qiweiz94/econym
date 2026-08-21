/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-doc-sync-automator`.
 * @module @deepseek-ai/dsh-plugin-doc-sync-automator/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-doc-sync-automator'

/** Cordis companion plugin name. */
export const name = 'plugin-doc-sync-automator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each `sync_bilingual_pair` call reads the current
 * document pair, writes the mirror and its `.i18n.yaml` sidecar, and returns
 * — there is no package-local event history or durable in-memory state to
 * assert a relation over between calls.
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
