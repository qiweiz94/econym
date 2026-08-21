// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) beside the
// real session store and tool registry, and the registered
// `get_session_telemetry` tool answers from a real session log end to end.
// Only the Agent identity is hand-made; the session it carries is the real one.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PluginTelemetry from '@deepseek-ai/dsh-plugin-telemetry-recorder'
import type { TelemetrySnapshot } from '@deepseek-ai/dsh-plugin-telemetry-recorder'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-recorder-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-plugin-telemetry-recorder', PluginTelemetry],
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

/** Append two complete turns whose second one reports cached prompt usage. */
function conversation(session: Session): void {
  session.append('request/context', { provider: 'mock', model: 'mock-1', contextWindow: 4000 })
  for (const turn of [1, 2]) {
    session.append('turn/start', { turn })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'composed answer' }],
        source: { kind: 'model', provider: 'mock', model: 'mock-1' },
      }),
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

describe('plugin-telemetry-recorder real Loader composition through cordis.yml', () => {
  it('exposes the telemetry tool and answers from the calling session\'s own log', async () => {
    const ctx = await boot("- name: '@deepseek-ai/dsh-plugin-telemetry-recorder'\n  config:\n    windowTurns: 5")

    const schema = ctx.tools.schemas().find(entry => entry.name === 'get_session_telemetry')
    expect(schema).toBeDefined()

    const session = ctx.sessions.create(SessionId('composed-telemetry'))
    conversation(session)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-telemetry-read'),
      name: 'get_session_telemetry',
      arguments: {},
      agent: { id: session.id, session } as unknown as Agent,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a telemetry snapshot')
    const value = result.value as unknown as TelemetrySnapshot
    expect(value.windowTurns).toBe(5)
    expect(value.closedTurns).toBe(2)
    expect(value.tokenVelocity).toEqual({ turns: 2, totalTokens: 900, tokensPerTurn: 450 })
    expect(value.promptCache).toEqual({ hitRatio: 0.75, promptTokens: 800, cacheReadTokens: 600 })
    expect(value.contextHeadroom?.headroomTokens).toBe(3600)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('token velocity: 450 tokens/turn (900 over 2)')
  })

  it('removes the tool when the plugin fiber unloads (HMR safety)', async () => {
    const ctx = await boot("- name: '@deepseek-ai/dsh-plugin-telemetry-recorder'")
    expect(ctx.tools.schemas().some(entry => entry.name === 'get_session_telemetry')).toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-plugin-telemetry-recorder')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()

    expect(ctx.tools.schemas().some(entry2 => entry2.name === 'get_session_telemetry')).toBe(false)
  })

  it('fails loud at load when windowTurns is not positive', async () => {
    await expect(boot(
      "- name: '@deepseek-ai/dsh-plugin-telemetry-recorder'\n  config:\n    windowTurns: 0",
    )).rejects.toThrow(/windowTurns/)
  })
})
