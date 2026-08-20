// Exercises the `subagent/start` intake path itself: which runs the governor
// tracks at all, before any detector ever fires. Real termination behavior is
// covered by governed-run.spec.ts against the real fork-in-process provider.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as governor from '../src/index.ts'
import { mountScriptedProvider } from './scripted-remote-provider.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function setup(config: governor.Config): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(governor, config)
  return ctx
}

describe('budget-governor subagent/start intake', () => {
  it('never tracks a remote run (local: false) — the intake guard returns before any warning', async () => {
    const context = await setup({ maxConsecutiveToolFailures: 1 })
    mountScriptedProvider(context, { name: 'remote', stopReason: 'error' })
    let observedLocal: boolean | undefined
    context.on('subagent/start', (info) => {
      observedLocal = info.local
    })
    // Discriminates "returned at the `!info.local` guard" from "returned at
    // the no-live-agent guard": a remote run resolves no local Agent either,
    // so removing the local-run guard would still warn here instead of
    // silently skipping. Only the local-run guard produces neither.
    const warnSpy = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    const run = await context.subagents.start('remote', {
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'go' }],
      parent: { id: SessionId('parent') } as unknown as Agent,
    })
    const result = await run.result
    expect(observedLocal).toBe(false)
    expect(result.stopReason).toBe('error')
    expect(warnSpy).not.toHaveBeenCalled()
    await run.dispose()
  })

  it('warns and does not track a "local" run whose claimed Agent never resolves on ctx.agents', async () => {
    const context = await setup({ maxConsecutiveToolFailures: 1 })
    mountScriptedProvider(context, { name: 'ghost', localAgent: {} as Agent })
    const warnSpy = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    const run = await context.subagents.start('ghost', {
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'go' }],
      parent: { id: SessionId('parent') } as unknown as Agent,
    })
    await run.result
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('has no live agent; the run is not governed'))
    await run.dispose()
  })
})
