import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as tool from '../src/index.ts'
import type { SandboxExecResult } from '../src/types.ts'
import { createGitRepo, removeRepo } from './git-fixture.ts'

const testToolSignal = new AbortController().signal
const repos: string[] = []

/** Narrow the registry's untyped result value to the sandbox contract. */
function sandboxValue(result: { value: unknown }): SandboxExecResult {
  return result.value as SandboxExecResult
}

afterEach(() => {
  for (const repo of repos) removeRepo(repo)
  repos.length = 0
})

async function setup(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

function callSandbox(ctx: Context, args: unknown): ReturnType<typeof ctx.tools.execute> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`sandbox-${Math.random().toString(16).slice(2)}`),
    name: 'sandbox_exec',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('plugin-worktree-sandbox', () => {
  it('registers a model-facing `sandbox_exec` tool exposing id + command', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo })
    const schema = ctx.tools.schemas().find(s => s.name === 'sandbox_exec')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['command', 'id'])
    await ctx.fiber.dispose()
  })

  it('runs a trial in an isolated worktree and returns the structured diff', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo })
    const result = await callSandbox(ctx, { id: 't1', command: 'echo trial > trial.txt' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(result).kind).toBe('sandbox')
    expect(sandboxValue(result).exitCode).toBe(0)
    expect(sandboxValue(result).changedFiles).toEqual(['trial.txt'])
    expect(sandboxValue(result).diff.text).toContain('trial.txt')
    expect(sandboxValue(result).worktree).toContain('.dsh/worktrees/subagent-t1')
    // Isolation: the main tree is untouched and the worktree is cleaned up.
    expect(() => readFileSync(join(repo, 'trial.txt'))).toThrow()
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('base\n')
    await ctx.fiber.dispose()
  })

  it('reports a non-zero exit status with no changes as a clean diff', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo })
    const result = await callSandbox(ctx, { id: 't2', command: 'exit 3' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(result).exitCode).toBe(3)
    expect(sandboxValue(result).changedFiles).toEqual([])
    expect(sandboxValue(result).diff.text).toBe('')
    await ctx.fiber.dispose()
  })

  it('keeps the trial worktree across calls when cleanup is disabled', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo, cleanup: false })
    await callSandbox(ctx, { id: 'keep', command: 'echo one > notes.txt' })
    // Reuse the same id: the second trial sees the first trial's change.
    const second = await callSandbox(ctx, { id: 'keep', command: 'echo two >> notes.txt' })
    expect(second.isError).toBe(false)
    if (second.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(second).created).toBe(false)
    expect(sandboxValue(second).diff.text).toContain('notes.txt')
    expect(sandboxValue(second).changedFiles).toEqual(['notes.txt'])
    await ctx.fiber.dispose()
  })

  it('fails loud when the configured root is not a git repository', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'dsh-sandbox-nonrepo-'))
    repos.push(nonRepo)
    const ctx = await setup({ cwd: nonRepo })
    const result = await callSandbox(ctx, { command: 'echo hi' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('git rev-parse')
    await ctx.fiber.dispose()
  })
})
