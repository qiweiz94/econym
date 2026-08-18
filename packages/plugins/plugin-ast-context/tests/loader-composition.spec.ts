// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) and the
// registered tool is callable end to end.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import * as PluginAstContext from '@deepseek-ai/dsh-plugin-ast-context'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(source: string): Promise<{ ctx: Context; path: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ast-context-loader-'))
  const path = join(root, 'sample.ts')
  await writeFile(path, source)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-plugin-ast-context'",
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
    ['@deepseek-ai/dsh-plugin-ast-context', PluginAstContext],
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

describe('plugin-ast-context real Loader composition through cordis.yml', () => {
  it('exposes get_file_outline and outlines a file from the booted composition', async () => {
    const { ctx, path } = await boot('export class Baz {\n  qux() {}\n}\n')
    const schema = ctx.tools.schemas().find(s => s.name === 'get_file_outline')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-outline'),
      name: 'get_file_outline',
      arguments: { path },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected get_file_outline success')
    expect(result.value).toEqual({
      path,
      symbols: [{ kind: 'class', name: 'Baz', line: 1, endLine: 3, children: [
        { kind: 'function', name: 'qux', line: 2, endLine: 2, children: [] },
      ] }],
    })
  }, 30_000)
})
