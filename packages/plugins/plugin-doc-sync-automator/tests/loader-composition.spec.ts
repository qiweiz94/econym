// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) and the
// registered sync_bilingual_pair tool is callable end to end against a
// throwaway doc pair.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PluginDocSyncAutomator from '@econym/dsh-plugin-doc-sync-automator'
import type { SyncBilingualPairResult } from '../src/types.ts'

let configRoot: string | undefined
let docsRoot: string | undefined
let context: Context | undefined

const SOURCE = ['# Title', '', '## Configuration', '', 'Old config text.', ''].join('\n')
const MIRROR = ['# 标题', '', '## 配置', '', '旧配置文本。', ''].join('\n')

/** Narrow the registry's untyped result value to the sync contract. */
function syncValue(result: { value: unknown }): SyncBilingualPairResult {
  return result.value as SyncBilingualPairResult
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (configRoot !== undefined) await rm(configRoot, { recursive: true, force: true })
  configRoot = undefined
  if (docsRoot !== undefined) await rm(docsRoot, { recursive: true, force: true })
  docsRoot = undefined
})

async function boot(pluginEntry: string): Promise<Context> {
  configRoot = await mkdtemp(join(tmpdir(), 'dsh-doc-sync-loader-'))
  const configPath = join(configRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(configRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@econym/dsh-plugin-doc-sync-automator', PluginDocSyncAutomator],
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

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('plugin-doc-sync-automator real Loader composition through cordis.yml', () => {
  it('splices a section into the paired mirror and re-records the pair', async () => {
    docsRoot = await mkdtemp(join(tmpdir(), 'dsh-doc-sync-docs-'))
    await writeFile(join(docsRoot, 'doc.md'), SOURCE)
    await writeFile(join(docsRoot, 'doc.zh.md'), MIRROR)

    const ctx = await boot(`- name: '@econym/dsh-plugin-doc-sync-automator'\n  config:\n    root: ${docsRoot}`)

    const schema = ctx.tools.schemas().find(s => s.name === 'sync_bilingual_pair')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-doc-sync'),
      name: 'sync_bilingual_pair',
      arguments: { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sync success')
    expect(syncValue(result).paired).toBe(true)
    expect(syncValue(result).mirrorPath).toBe('doc.zh.md')
    expect(text(result)).toContain('NEEDS-TRANSLATION debt')
  }, 30_000)

  it('fails loud at load when budgetManifestPath is not a string', async () => {
    docsRoot = await mkdtemp(join(tmpdir(), 'dsh-doc-sync-docs-'))
    await mkdir(docsRoot, { recursive: true })
    await expect(boot(
      `- name: '@econym/dsh-plugin-doc-sync-automator'\n  config:\n    root: ${docsRoot}\n    budgetManifestPath: 42`,
    )).rejects.toThrow()
  }, 30_000)
})
