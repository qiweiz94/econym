import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as tool from '../src/index.ts'
import { worktreeExists } from '../src/worktree.ts'
import type { SandboxExecResult } from '../src/types.ts'
import { createGitRepo, gitIn, removeRepo } from './git-fixture.ts'

const testToolSignal = new AbortController().signal
const repos: string[] = []

/** Narrow the registry's untyped result value to the sandbox contract. */
function sandboxValue(result: { value: unknown }): SandboxExecResult {
  return result.value as SandboxExecResult
}

/** Whether a trial worktree with the given name is still registered. */
async function worktreeExistsFor(ctx: Context, repo: string, name: string): Promise<boolean> {
  return worktreeExists(ctx, repo, 'git', join(repo, '.dsh', 'worktrees', name))
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
    // Cleanup runs even when the trial itself failed.
    await expect(worktreeExistsFor(ctx, repo, 'subagent-t2')).resolves.toBe(false)
    await ctx.fiber.dispose()
  })

  it('returns the partial diff when the command times out', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo, timeoutMs: 200 })
    const result = await callSandbox(ctx, { id: 't3', command: 'echo partial > p.txt; sleep 5' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sandbox success')
    // The command was killed by the timeout, so exitCode is null and a signal ran.
    expect(sandboxValue(result).exitCode).toBeNull()
    expect(sandboxValue(result).signal).not.toBeNull()
    // The timeout must not cancel the follow-up diff capture.
    expect(sandboxValue(result).diff.text).toContain('p.txt')
    await ctx.fiber.dispose()
  }, 15_000)

  it('keeps a reused trial diff anchored to its own base when the main branch moves', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo, cleanup: false })
    await callSandbox(ctx, { id: 'b1', command: 'echo trial > b.txt' })
    // Move the main branch forward with an unrelated commit.
    writeFileSync(join(repo, 'main-only.txt'), 'main\n')
    gitIn(repo, ['add', 'main-only.txt'])
    gitIn(repo, ['commit', '-m', 'main moves'])
    // Reuse the trial: its diff must not include the main branch's new commit.
    const second = await callSandbox(ctx, { id: 'b1', command: 'echo more >> b.txt' })
    expect(second.isError).toBe(false)
    if (second.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(second).diff.text).toContain('b.txt')
    expect(sandboxValue(second).diff.text).not.toContain('main-only.txt')
    expect(sandboxValue(second).changedFiles).toEqual(['b.txt'])
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

  it('rejects a trial id that escapes the trial root', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo })
    const traversal = await callSandbox(ctx, { id: '../../../evil', command: 'echo pwned' })
    expect(traversal.isError).toBe(true)
    expect(text(traversal)).toContain('invalid sandbox trial id')
    const tooLong = await callSandbox(ctx, { id: 'a'.repeat(65), command: 'echo pwned' })
    expect(tooLong.isError).toBe(true)
    expect(text(tooLong)).toContain('invalid sandbox trial id')
    await ctx.fiber.dispose()
  })

  it('classifies sandbox calls as parallel-safe', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo })
    expect(ctx.tools.executionMode({
      name: 'sandbox_exec',
      arguments: { id: 'p', command: 'true' },
      callId: CallId('sandbox-mode'),
      signal: testToolSignal,
    })).toEqual({ kind: 'parallel' })
    await ctx.fiber.dispose()
  })
})

/** Write an executable fake-git shim delegating to real git except `snippet`'s cases. */
function fakeGit(repo: string, snippet: string): string {
  const path = join(repo, 'fake-git.sh')
  writeFileSync(path, `#!/bin/sh\n${snippet}\nexec git "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

describe('sandbox result rendering', () => {
  it('renders plural changed files and both output streams', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo })
    const result = await callSandbox(ctx, {
      id: 'render',
      command: 'echo one > f1.txt; echo two > f2.txt; echo out-line; echo err-line >&2',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('2 files changed: f1.txt, f2.txt')
    expect(text(result)).toContain('stdout:\nout-line')
    expect(text(result)).toContain('stderr:\nerr-line')
    await ctx.fiber.dispose()
  })

  it('marks every truncated section when the envelope is tiny', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await setup({ cwd: repo, maxOutputBytes: 40 })
    const result = await callSandbox(ctx, {
      id: 'tiny',
      command: 'seq 1 200 > big.txt; seq 1 100; seq 100 200 >&2',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('[diff truncated by the output envelope]')
    expect(text(result)).toContain('[stdout truncated]')
    expect(text(result)).toContain('[stderr truncated]')
    await ctx.fiber.dispose()
  })
})

describe('sandbox git failure paths', () => {
  it('reuses the trial when a concurrent add already created the worktree', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    // The shim performs the real add, then still reports failure — the shape
    // of losing a same-id race: the error arrives but the worktree exists.
    const git = fakeGit(repo, 'if [ "$1 $2" = "worktree add" ]; then git "$@" >/dev/null 2>&1; echo "synthetic add race" >&2; exit 1; fi')
    const ctx = await setup({ cwd: repo, gitBinary: git })
    const result = await callSandbox(ctx, { id: 'race', command: 'echo raced > raced.txt' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(result).created).toBe(false)
    expect(sandboxValue(result).changedFiles).toEqual(['raced.txt'])
    await ctx.fiber.dispose()
  })

  it('fails loud when the worktree add fails without creating the worktree', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    // stdout-only failure text exercises the stderr-empty fallback.
    const git = fakeGit(repo, 'if [ "$1 $2" = "worktree add" ]; then echo "add exploded"; exit 1; fi')
    const ctx = await setup({ cwd: repo, gitBinary: git })
    const result = await callSandbox(ctx, { id: 'no-add', command: 'echo never' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('git worktree add failed: add exploded')
    await ctx.fiber.dispose()
  })

  it('surfaces a trial-head resolution failure as the primary error', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const git = fakeGit(repo, 'if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then echo "head gone" >&2; exit 1; fi')
    const ctx = await setup({ cwd: repo, gitBinary: git })
    const result = await callSandbox(ctx, { id: 'no-head', command: 'echo probe > probe.txt' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('git rev-parse HEAD failed in trial worktree: head gone')
    await ctx.fiber.dispose()
  })

  it('reports a successful trial with a cleanup note when removal fails', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const git = fakeGit(repo, 'if [ "$1 $2" = "worktree remove" ]; then echo "remove blocked" >&2; exit 1; fi')
    const ctx = await setup({ cwd: repo, gitBinary: git })
    const result = await callSandbox(ctx, { id: 'stuck', command: 'echo kept > kept.txt' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sandbox success')
    expect(sandboxValue(result).cleanupError).toContain('git worktree remove failed: remove blocked')
    expect(text(result)).toContain('note: the trial worktree could not be removed')
    await ctx.fiber.dispose()
  })

  it('aggregates a primary failure with a cleanup failure', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    // Both failures print to stdout only, exercising the stderr-empty fallback
    // in the trial-head and removal guards.
    const git = fakeGit(repo, `
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then echo "head lost"; exit 1; fi
if [ "$1 $2" = "worktree remove" ]; then echo "remove lost"; exit 1; fi`)
    const ctx = await setup({ cwd: repo, gitBinary: git })
    const result = await callSandbox(ctx, { id: 'double', command: 'echo doomed > doomed.txt' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sandbox_exec failed: git rev-parse HEAD failed in trial worktree: head lost')
    expect(text(result)).toContain('cleanup failed: Error: git worktree remove failed: remove lost')
    await ctx.fiber.dispose()
  })

  it('falls back to stdout text when a base-ref resolution fails silently on stderr', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const git = fakeGit(repo, 'if [ "$1" = "rev-parse" ] && [ "$2" != "HEAD" ]; then echo "bad ref"; exit 1; fi')
    const ctx = await setup({ cwd: repo, gitBinary: git })
    const result = await callSandbox(ctx, { id: 'bad-base', command: 'echo never' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('failed: bad ref')
    await ctx.fiber.dispose()
  })
})

describe('sandbox config fallbacks outside the loader', () => {
  it('applies documented defaults when apply runs without loader-filled config', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    // Direct apply bypasses the loader's schema defaults; every `??` fallback
    // must reproduce them. The repo root falls back to the process cwd.
    const previousCwd = process.cwd()
    process.chdir(repo)
    try {
      tool.apply(ctx, {})
      const result = await callSandbox(ctx, { id: 'defaults', command: 'echo d > d.txt' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected sandbox success')
      expect(sandboxValue(result).baseRef).toBe('HEAD')
      expect(sandboxValue(result).changedFiles).toEqual(['d.txt'])
    } finally {
      process.chdir(previousCwd)
      await ctx.fiber.dispose()
    }
  })
})
