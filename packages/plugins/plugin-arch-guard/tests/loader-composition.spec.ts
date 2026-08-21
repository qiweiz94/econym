// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply), which
// scans a real on-disk fixture workspace, and the registered tool is callable
// end to end against it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import * as PluginArchGuard from '@deepseek-ai/dsh-plugin-arch-guard'

let fixtureRoot: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

/** Write one fixture package.json under `fixtureRoot/relDir/package.json`. */
async function writeManifest(relDir: string, manifest: unknown): Promise<void> {
  const dir = join(fixtureRoot!, relDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
}

/** Build the small on-disk fixture workspace the booted guard scans. */
async function seedFixtureWorkspace(): Promise<void> {
  await writeManifest('packages/plugins/demo-plugin', {
    name: '@deepseek-ai/dsh-demo-plugin',
    exports: { '.': { default: './lib/index.js' } },
  })
  await writeManifest('packages/core/demo-core', {
    name: '@deepseek-ai/dsh-demo-core',
    exports: { '.': { default: './lib/index.js' }, './widgets/*': './lib/widgets/*' },
  })
}

async function boot(): Promise<{ ctx: Context }> {
  const bootRoot = await mkdtemp(join(tmpdir(), 'dsh-arch-guard-loader-'))
  fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-arch-guard-fixture-'))
  await seedFixtureWorkspace()

  const configPath = join(bootRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-plugin-arch-guard'",
    '  config:',
    `    root: ${JSON.stringify(fixtureRoot)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(bootRoot).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-plugin-arch-guard', PluginArchGuard],
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
  return { ctx }
}

describe('plugin-arch-guard real Loader composition through cordis.yml', () => {
  it('exposes check_module_boundary and allows a legal cross-package import against the scanned fixture', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'check_module_boundary')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-boundary-check-allowed'),
      name: 'check_module_boundary',
      arguments: {
        sourcePath: 'packages/plugins/demo-plugin/src/index.ts',
        targetImport: '@deepseek-ai/dsh-demo-core/widgets/panel.ts',
      },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected check_module_boundary success')
    expect(result.value).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  }, 30_000)

  it('blocks a subpath the target does not export, through the same composed tool', async () => {
    const { ctx } = await boot()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-boundary-check-blocked'),
      name: 'check_module_boundary',
      arguments: {
        sourcePath: 'packages/plugins/demo-plugin/src/index.ts',
        targetImport: '@deepseek-ai/dsh-demo-core/internal',
      },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected check_module_boundary success')
    expect(result.value).toEqual({
      allowed: false,
      rule: 'non-exported-subpath',
      suggestion: '@deepseek-ai/dsh-demo-core does not export ./internal; it exports: ., ./widgets/*.',
    })
  }, 30_000)
})
