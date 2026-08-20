import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as tool from '../src/index.ts'
import { mountScriptedProvider, type ScriptedConfig } from './scripted-provider.ts'

const testToolSignal = new AbortController().signal

/** A minimal parent Agent passed through to the provider request. */
function fakeAgent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

async function setup(config: tool.Config, scripted: ScriptedConfig = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  mountScriptedProvider(ctx, { name: 'mock', ...scripted })
  await ctx.plugin(tool, config)
  return ctx
}

let callCounter = 0
function callSubagent(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}): ReturnType<typeof ctx.tools.execute> {
  const agent = 'agent' in over ? over.agent : fakeAgent()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'subagent',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

afterEach(async () => {
  /* The test context is disposed by each test's own lifecycle where mounted. */
})

describe('plugin-subagent-router', () => {
  it('registers a model-facing `subagent` tool exposing only description and prompt', async () => {
    const ctx = await setup({ providers: ['mock'] })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'prompt'])
    await ctx.fiber.dispose()
  })

  it('delegates to the configured provider and returns its output', async () => {
    const ctx = await setup({ providers: ['mock'] }, { reply: 'child says hi' })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'go research X' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected subagent success')
    expect(result.value).toEqual({
      kind: 'foreground',
      runId: 'scripted-subagent:mock:parent-1',
      output: [{ type: 'text', text: 'child says hi' }],
    })
    expect(text(result)).toBe('child says hi')
    await ctx.fiber.dispose()
  })

  it('routes by label to a matching route before falling back to the default candidates', async () => {
    let seen: string | undefined
    const ctx = await setup(
      { providers: ['unused'], routes: [{ label: 'summarize', providers: ['mock'] }] },
      { onStart: (request) => { seen = request.label } },
    )
    const result = await callSubagent(ctx, { description: 'Summarize the notes', prompt: 'summarize' })
    expect(result.isError).toBe(false)
    expect(seen).toBe('Summarize the notes')
    await ctx.fiber.dispose()
  })

  it('falls through to the next matching route when an earlier one cannot serve', async () => {
    let seen: string | undefined
    const ctx = await setup(
      {
        providers: ['unused'],
        routes: [
          { label: 'summarize', providers: ['ghost'] },
          { label: 'meeting', providers: ['mock'] },
        ],
      },
      { onStart: (request) => { seen = request.label } },
    )
    const result = await callSubagent(ctx, { description: 'Summarize the meeting notes', prompt: 'summarize' })
    expect(result.isError).toBe(false)
    expect(seen).toBe('Summarize the meeting notes')
    await ctx.fiber.dispose()
  })

  it('fails loud when a matched route cannot serve, never falling back to defaults', async () => {
    const ctx = await setup(
      { providers: ['mock'], routes: [{ label: 'summarize', providers: ['ghost'] }] },
    )
    const result = await callSubagent(ctx, { description: 'Summarize the notes', prompt: 'summarize' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('none of the configured providers (ghost) are currently registered')
    await ctx.fiber.dispose()
  })

  it('rejects a delegation when none of the configured providers are registered', async () => {
    const ctx = await setup({ providers: ['ghost'] })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('none of the configured providers (ghost) are currently registered')
    await ctx.fiber.dispose()
  })

  it('fails loud when the registered provider lacks a required capability', async () => {
    const ctx = await setup({ providers: ['mock'], persona: 'expert' }, {
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('do not support the required capability (persona)')
    await ctx.fiber.dispose()
  })

  it('requires a calling agent', async () => {
    const ctx = await setup({ providers: ['mock'] })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'p' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
    await ctx.fiber.dispose()
  })

  it('maps a non-completed stop reason to an isError result with partial output', async () => {
    const ctx = await setup({ providers: ['mock'] }, { stopReason: 'refusal' })
    const result = await callSubagent(ctx, { description: 'do a thing', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent declined the task')
    await ctx.fiber.dispose()
  })

  it('fails loud at load when providers is empty', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(tool, { providers: [] })).rejects.toThrow(/providers/)
  })

  it('fails loud at load when a route label is empty', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(tool, {
      providers: ['mock'],
      routes: [{ label: '', providers: ['mock'] }],
    })).rejects.toThrow(/string length >= 1/)
  })
})
