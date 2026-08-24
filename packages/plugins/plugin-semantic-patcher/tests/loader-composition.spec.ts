// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) and the
// registered tool patches a file end to end.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PluginSemanticPatcher from '@econym/dsh-plugin-semantic-patcher'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(source: string, config: string = '\n  config:\n    cwd: ROOT'): Promise<{ ctx: Context; path: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-semantic-patcher-loader-'))
  const path = join(root, 'sample.ts')
  await writeFile(path, source)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    `- name: '@econym/dsh-plugin-semantic-patcher'${config.replace('ROOT', root)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@econym/dsh-plugin-semantic-patcher', PluginSemanticPatcher],
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
  return { ctx, path }
}

describe('plugin-semantic-patcher real Loader composition through cordis.yml', () => {
  it('exposes patch_symbol_body and patches a file from the booted composition', async () => {
    const { ctx, path } = await boot('export class Baz {\n  qux() { return 1 }\n}\n')
    const schema = ctx.tools.schemas().find(s => s.name === 'patch_symbol_body')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-patch'),
      name: 'patch_symbol_body',
      arguments: { path, symbol: 'Baz.qux', newBody: '{ return 2 }' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected patch_symbol_body success')
    expect(result.value).toEqual({ path, symbol: 'Baz.qux', kind: 'method', line: 2, endLine: 2 })
    expect(await readFile(path, 'utf8')).toBe('export class Baz {\n  qux() { return 2 }\n}\n')
  }, 30_000)

  it('fails loud at load when maxBytes is not a positive integer', async () => {
    await expect(boot(
      'export function a() {}\n',
      '\n  config:\n    maxBytes: 0',
    )).rejects.toThrow(/maxBytes/)
  }, 30_000)
})
