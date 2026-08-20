import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  addWorktree,
  collectRetained,
  parseChangedFiles,
  removeWorktree,
  resolveBaseCommit,
  runCommand,
  worktreeExists,
} from '../src/worktree.ts'
import { createGitRepo, gitIn, removeRepo } from './git-fixture.ts'

const repos: string[] = []

afterEach(() => {
  for (const repo of repos) removeRepo(repo)
  repos.length = 0
})

async function mountCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

describe('plugin-worktree-sandbox worktree helpers', () => {
  it('runs a command and captures exit facts and bounded streams', async () => {
    const ctx = await mountCtx()
    const repo = createGitRepo()
    repos.push(repo)
    const outcome = await runCommand(ctx, repo, ['sh', '-c', 'echo out; echo err 1>&2; exit 3'], 4_096)
    expect(outcome.exitCode).toBe(3)
    expect(outcome.signal).toBeNull()
    expect(outcome.stdout.text).toBe('out\n')
    expect(outcome.stderr.text).toBe('err\n')
  })

  it('bounds collected stdout with the head retention envelope', async () => {
    const ctx = await mountCtx()
    const repo = createGitRepo()
    repos.push(repo)
    // 4 bytes retained from a 6-byte stream → truncated.
    const retained = await collectRetained(ctx, repo, ['sh', '-c', 'printf abcdef'], 4)
    expect(retained.text).toBe('abcd')
    expect(retained.truncated).toBe(true)
    expect(retained.omittedBytes).toEqual({ kind: 'exact', count: 2 })
    const small = await collectRetained(ctx, repo, ['sh', '-c', 'printf ab'], 4)
    expect(small.text).toBe('ab')
    expect(small.truncated).toBe(false)
  })

  it('resolves a ref to its commit hash', async () => {
    const ctx = await mountCtx()
    const repo = createGitRepo()
    repos.push(repo)
    const head = gitIn(repo, ['rev-parse', 'HEAD']).trim()
    expect(await resolveBaseCommit(ctx, repo, 'git', 'HEAD')).toBe(head)
  })

  it('creates and removes an isolated detached worktree', async () => {
    const ctx = await mountCtx()
    const repo = createGitRepo()
    repos.push(repo)
    const base = await resolveBaseCommit(ctx, repo, 'git', 'HEAD')
    const worktree = join(repo, '.dsh', 'worktrees', 'subagent-t1')

    await addWorktree(ctx, repo, 'git', worktree, base)
    expect(await worktreeExists(ctx, repo, 'git', worktree)).toBe(true)

    // A change inside the worktree is isolated from the main tree.
    await runCommand(ctx, worktree, ['sh', '-c', 'echo trial > trial.txt'], 4_096)
    expect(readFileSync(join(worktree, 'trial.txt'), 'utf8')).toBe('trial\n')
    // New files need intent-to-add before `git diff` includes them.
    await runCommand(ctx, worktree, ['git', 'add', '-N', '.'], 4_096)
    const diff = await collectRetained(ctx, worktree, ['git', 'diff', base, '--'], 4_096)
    expect(diff.text).toContain('trial.txt')
    expect(() => readFileSync(join(repo, 'trial.txt'))).toThrow()

    await removeWorktree(ctx, repo, 'git', worktree)
    expect(await worktreeExists(ctx, repo, 'git', worktree)).toBe(false)
  })

  it('parses porcelain status into changed file paths', () => {
    expect(parseChangedFiles(' M src/a.ts\n?? new-file.txt\nR  old.txt -> new.txt\n')).toEqual([
      'src/a.ts',
      'new-file.txt',
      'new.txt',
    ])
    expect(parseChangedFiles('')).toEqual([])
  })
})
