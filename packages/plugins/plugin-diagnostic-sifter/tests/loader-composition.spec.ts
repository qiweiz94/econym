// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) against a
// real subprocess provider, and the registered run_diagnostic_check tool is
// callable end to end against a throwaway fixture project.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as PluginSifter from '@deepseek-ai/dsh-plugin-diagnostic-sifter'
import type { DiagnosticCheckResult } from '../src/types.ts'
import { createFixtureProject, removeFixtureProject } from './fixture-project.ts'

let root: string | undefined
let context: Context | undefined
const projects: string[] = []

/** Narrow the registry's untyped result value to the diagnostic contract. */
function diagnosticValue(result: { value: unknown }): DiagnosticCheckResult {
  return result.value as DiagnosticCheckResult
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  for (const project of projects) removeFixtureProject(project)
  projects.length = 0
})

async function boot(pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-diagnostic-sifter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    pluginEntry,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-plugin-diagnostic-sifter', PluginSifter],
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

describe('plugin-diagnostic-sifter real Loader composition through cordis.yml', () => {
  it('runs a typecheck through the composed tool and returns the structured result', async () => {
    const project = createFixtureProject({ 'src/ok.ts': 'export const ok = 1\n' })
    projects.push(project)
    const ctx = await boot(`- name: '@deepseek-ai/dsh-plugin-diagnostic-sifter'\n  config:\n    cwd: ${project}`)

    const schema = ctx.tools.schemas().find(s => s.name === 'run_diagnostic_check')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-diagnostic'),
      name: 'run_diagnostic_check',
      arguments: { command: 'typecheck' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a clean typecheck through the composed tool')
    expect(diagnosticValue(result).kind).toBe('diagnostic')
    expect(diagnosticValue(result).success).toBe(true)
    expect(text(result)).toContain('typecheck clean')
  }, 30_000)

  it('fails loud at load when maxOutputBytes is not positive', async () => {
    const project = createFixtureProject()
    projects.push(project)
    await expect(boot(
      `- name: '@deepseek-ai/dsh-plugin-diagnostic-sifter'\n  config:\n    cwd: ${project}\n    maxOutputBytes: 0`,
    )).rejects.toThrow(/maxOutputBytes/)
  }, 30_000)
})
