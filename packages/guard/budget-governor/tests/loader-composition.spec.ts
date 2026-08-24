// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) against
// the real subagent, agent, and token-meter services, and a governed child
// run started against the real fork-in-process backend is actually
// terminated end to end once its cordis.yml-configured ceiling trips.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ForkProvider from '@deepseek-ai/dsh-subagent-fork-in-process'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as PluginGovernor from '../src/index.ts'
import { MockAdapter, toolCallResponse } from './fixtures/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-budget-governor-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-subagent-fork-in-process'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-fork-in-process', ForkProvider],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@econym/dsh-budget-governor', PluginGovernor],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('budget-governor real Loader composition through cordis.yml', () => {
  it('has the namespace-plugin export shape (no stray default) — the Loader would drop `inject` otherwise', () => {
    expect('default' in PluginGovernor).toBe(false)
    expect(PluginGovernor.name).toBe('budget-governor')
    expect(PluginGovernor.inject).toEqual(['subagents', 'agents', 'tokenMeter'])
    expect(typeof PluginGovernor.apply).toBe('function')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(PluginGovernor) as Record<string, unknown>
    expect(unwrapped).toBe(PluginGovernor)
    expect(unwrapped.name).toBe('budget-governor')
    expect(unwrapped.inject).toEqual(['subagents', 'agents', 'tokenMeter'])
  })

  it('fails loud at load when no ceiling is configured', async () => {
    await expect(boot(
      "- name: '@econym/dsh-budget-governor'\n  config: {}",
    )).rejects.toThrow(/no ceiling is configured/)
  }, 30_000)

  it('terminates a governed child run through the fully Loader-composed real backend', async () => {
    const ctx = await boot(
      "- name: '@econym/dsh-budget-governor'\n  config:\n    maxConsecutiveToolFailures: 1",
    )
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'test-only failing edit tool',
      parameters: { file_path: { type: 'string', required: true } },
      async execute(args) {
        throw new Error(`edit failed: ${args.file_path}`)
      },
    }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: 'a.ts' }),
    ]))
    const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const run = await ctx.subagents.start('fork', {
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'child q' }],
      parent,
    })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await run.dispose()
  }, 30_000)
})
