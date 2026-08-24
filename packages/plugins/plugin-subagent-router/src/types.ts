/**
 * Type-only contracts for `@econym/dsh-plugin-subagent-router`: the
 * capability needs a delegation imposes on a provider.
 * @module @econym/dsh-plugin-subagent-router/types
 */

/** Start-time capabilities a delegation request needs from its provider. */
export interface NeededCapabilities {
  readonly persona: boolean
  readonly toolFilter: boolean
  readonly depthLimit: boolean
}
