/**
 * Type-only contracts for `@deepseek-ai/dsh-plugin-subagent-router`: the
 * capability needs a delegation imposes on a provider.
 * @module @deepseek-ai/dsh-plugin-subagent-router/types
 */

/** Start-time capabilities a delegation request needs from its provider. */
export interface NeededCapabilities {
  readonly persona: boolean
  readonly toolFilter: boolean
  readonly depthLimit: boolean
}
