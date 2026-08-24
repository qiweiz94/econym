// Proves the plugin survives a REAL Loader composition: a cordis.yml booted
// through the Loader mounts the namespace plugin (name/inject/apply) against a
// real subprocess provider, and the registered sandbox_exec tool is callable
// end to end on a throwaway git repository.
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
import * as PluginSandbox from '@econym/dsh-plugin-worktree-sandbox'
import type { SandboxExecResult } from '../src/types.ts'
import { createGitRepo, removeRepo } from './git-fixture.ts'

let root: string | undefined
let context: Context | undefined
const repos: string[] = []

/** Narrow the registry's untyped result value to the sandbox contract. */
function sandboxValue(result: { value: unknown }): SandboxExecResult {
  return result.value as SandboxExecResult
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  for (const repo of repos) removeRepo(repo)
  repos.length = 0
})

async function boot(repoCwd: string, pluginEntry: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-worktree-sandbox-loader-'))
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
    ['@econym/dsh-plugin-worktree-sandbox', PluginSandbox],
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
  void repoCwd
  return ctx
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('plugin-worktree-sandbox real Loader composition through cordis.yml', () => {
  it('runs an isolated trial and returns the structured diff', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await boot(repo, `- name: '@econym/dsh-plugin-worktree-sandbox'\n  config:\n    cwd: ${repo}`)

    const schema = ctx.tools.schemas().find(s => s.name === 'sandbox_exec')
    expect(schema).toBeDefined()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-sandbox'),
      name: 'sandbox_exec',
      arguments: { id: 'c1', command: 'echo composed > from-trial.txt' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(result).kind).toBe('sandbox')
    expect(sandboxValue(result).exitCode).toBe(0)
    expect(sandboxValue(result).changedFiles).toEqual(['from-trial.txt'])
    expect(text(result)).toContain('from-trial.txt')
  }, 30_000)

  it('fails loud at load when maxOutputBytes is not positive', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    await expect(boot(
      repo,
      `- name: '@econym/dsh-plugin-worktree-sandbox'\n  config:\n    cwd: ${repo}\n    maxOutputBytes: 0`,
    )).rejects.toThrow(/maxOutputBytes/)
  }, 30_000)
})
