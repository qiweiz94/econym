/**
 * A package-local scripted `SubagentProvider` for the router's tests: it
 * stands in for the nondeterministic child boundary (the one-shot child and
 * its LLM turn), returning a canned result and recording the resolved request
 * so tests can assert what the router dispatched.
 * @module plugin-subagent-router/test/scripted-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Test configuration for the scripted provider. */
export interface ScriptedConfig {
  /** Registry name (default `mock`). */
  readonly name?: string
  /** The child's canned reply text (default `scripted subagent reply`). */
  readonly reply?: string
  /** The canned terminal stop reason (default `completed`). */
  readonly stopReason?: SubagentResult['stopReason']
  /** Advertised start-time capabilities (default: all supported). */
  readonly capabilities?: SubagentCapabilities
  /** Called with the resolved request the router dispatched. */
  readonly onStart?: (request: import('@deepseek-ai/dsh-subagent').ResolvedSubagentStartRequest) => void
}

/**
 * Register a scripted provider on `ctx.subagents`.
 * @param ctx - the test Cordis context.
 * @param config - scripted behavior.
 * @returns the registration disposer.
 */
export function mountScriptedProvider(ctx: Context, config: ScriptedConfig = {}): () => void {
  const name = config.name ?? 'mock'
  return ctx.subagents.registerProvider({
    name,
    capabilities: config.capabilities ?? {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    inheritsParentContext: false,
    async start(request) {
      config.onStart?.(request)
      const id = SessionId(`scripted-subagent:${name}:${request.parent.id}`)
      return {
        id,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: config.reply ?? 'scripted subagent reply' }],
          stopReason: config.stopReason ?? 'completed',
        }),
        async dispose() {},
      } satisfies SubagentRun
    },
  } satisfies SubagentProvider)
}
