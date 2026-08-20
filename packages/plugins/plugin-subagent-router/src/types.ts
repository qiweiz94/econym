/**
 * Type-only contracts for `@deepseek-ai/dsh-plugin-subagent-router`: the
 * capability needs a delegation imposes on a provider and the router tool's
 * foreground result value.
 * @module @deepseek-ai/dsh-plugin-subagent-router/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'

/** Start-time capabilities a delegation request needs from its provider. */
export interface NeededCapabilities {
  readonly persona: boolean
  readonly toolFilter: boolean
  readonly depthLimit: boolean
}

/** The router tool's foreground result value. */
export interface ForegroundToolResult {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}
