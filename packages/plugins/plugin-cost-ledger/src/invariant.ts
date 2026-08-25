/**
 * Package-owned invariant companion for `@econym/dsh-plugin-cost-ledger`.
 * @module @econym/dsh-plugin-cost-ledger/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@econym/dsh-plugin-cost-ledger'

/** Cordis companion plugin name. */
export const name = 'plugin-cost-ledger-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns no event stream and no durable
 * session data. Its ledger is a derived read-only fold over events other
 * packages own and already check — usage accounting belongs to the session
 * surface and dsh-agent-loop's step lifecycle, and model attribution to the
 * assistant-message source contract. The JSONL export is deployment-side
 * file I/O addressed by config, not a durable harness format.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
