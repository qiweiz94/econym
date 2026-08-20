/**
 * A package-local scripted `SubagentProvider` standing in for the
 * nondeterministic child boundary in tests that exercise the governor's
 * `subagent/start` intake path itself (remote runs, a run whose provider
 * claims a local agent that never registers), rather than real detector
 * termination. Real termination is exercised against the real fork-in-process
 * provider driven by a scripted `MockAdapter` (see `governed-run.spec.ts`).
 * @module plugin-budget-governor/test/scripted-remote-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Test configuration for the scripted provider. */
export interface ScriptedConfig {
  /** Registry name (default `scripted`). */
  readonly name?: string
  /** The child's canned reply text (default `scripted subagent reply`). */
  readonly reply?: string
  readonly stopReason?: SubagentResult['stopReason']
  /**
   * `localAgent` reported to the runtime, which derives `subagent/start`'s
   * `local` flag from its presence. Omitted ⇒ a remote-shaped run
   * (`local: false`); a non-`undefined` stand-in (never registered on
   * `ctx.agents`) reproduces a local run whose claimed Agent never resolves.
   */
  readonly localAgent?: Agent
}

const capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

/**
 * Register a scripted provider on `ctx.subagents`.
 * @param ctx - the test Cordis context.
 * @param config - scripted behavior.
 * @returns the registration disposer.
 */
export function mountScriptedProvider(ctx: Context, config: ScriptedConfig = {}): () => void {
  const providerName = config.name ?? 'scripted'
  return ctx.subagents.registerProvider({
    name: providerName,
    capabilities,
    inheritsParentContext: false,
    async start(request) {
      const id = SessionId(`scripted-subagent:${providerName}:${request.parent.id}`)
      return {
        id,
        localAgent: config.localAgent,
        result: Promise.resolve({
          output: [{ type: 'text', text: config.reply ?? 'scripted subagent reply' }],
          stopReason: config.stopReason ?? 'completed',
        }),
        async dispose() {},
      } satisfies SubagentRun
    },
  } satisfies SubagentProvider)
}
