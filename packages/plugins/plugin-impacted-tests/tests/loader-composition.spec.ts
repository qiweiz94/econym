// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) against a
// real subprocess provider, and the registered run_impacted_tests tool is
// callable end to end on a throwaway workspace. The configured runner is
// `echo`, so the composed call records the suite list it would have handed a
// test runner without spawning one.
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
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as PluginImpactedTests from '@econym/dsh-plugin-impacted-tests'
import type { ImpactedTestsResult } from '../src/types.ts'
import { createWorkspace, removeWorkspace } from './workspace-fixture.ts'

let root: string | undefined
let context: Context | undefined
const workspaces: string[] = []

/** Narrow a successful execution's untyped result value to the tool's contract. */
function impactValue(result: ToolExecutionResult): ImpactedTestsResult {
  if (result.isError) throw new Error('expected an impacted-tests selection')
  return result.value as unknown as ImpactedTestsResult
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  for (const workspace of workspaces) removeWorkspace(workspace)
  workspaces.length = 0
})

async function boot(pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-impacted-tests-loader-'))
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
    ['@econym/dsh-plugin-impacted-tests', PluginImpactedTests],
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

/** The cordis.yml entry mounting the plugin over a fixture workspace. */
function entryFor(workspace: string, extra: readonly string[] = []): string {
  return [
    "- name: '@econym/dsh-plugin-impacted-tests'",
    '  config:',
    `    cwd: ${workspace}`,
    '    tsconfigPath: tsconfig.json',
    '    testPatterns:',
    "      - 'packages/*/*/tests/**/*.spec.ts'",
    '    runnerCommand:',
    '      - echo',
    '      - ran',
    ...extra,
  ].join('\n')
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('plugin-impacted-tests real Loader composition through cordis.yml', () => {
  it('selects and runs strictly the impacted suites', async () => {
    const workspace = createWorkspace()
    workspaces.push(workspace)
    const ctx = await boot(entryFor(workspace))

    const schema = ctx.tools.schemas().find(definition => definition.name === 'run_impacted_tests')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-impacted'),
      name: 'run_impacted_tests',
      arguments: { files: ['packages/group/app/src/core.ts'] },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected an impacted-tests selection')
    expect(impactValue(result).kind).toBe('impacted-tests')
    expect(impactValue(result).selectedSuites).toEqual(['packages/group/app/tests/core.spec.ts'])
    expect(impactValue(result).skippedCount).toBe(2)
    expect(impactValue(result).results.stdout.text.trim()).toBe('ran packages/group/app/tests/core.spec.ts')
    expect(text(result)).toContain('all selected suites passed')
  }, 30_000)

  it('runs nothing for a changed file no suite imports', async () => {
    const workspace = createWorkspace()
    workspaces.push(workspace)
    const ctx = await boot(entryFor(workspace))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-impacted-none'),
      name: 'run_impacted_tests',
      arguments: { files: ['sample/notes.md'] },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected an impacted-tests selection')
    expect(impactValue(result).selectedSuites).toEqual([])
    expect(impactValue(result).results.executed).toBe(false)
    expect(text(result)).toContain('no test suite imports them')
  }, 30_000)

  it('fails loud at load when maxOutputBytes is not positive', async () => {
    const workspace = createWorkspace()
    workspaces.push(workspace)
    await expect(boot(entryFor(workspace, ['    maxOutputBytes: 0']))).rejects.toThrow(/maxOutputBytes/)
  }, 30_000)
})
