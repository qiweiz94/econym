import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { addWorktree, sweepStaleWorktrees, worktreeExists } from '../src/worktree.ts'
import { createGitRepo, gitIn, removeRepo } from './git-fixture.ts'

const repos: string[] = []
const contexts: Context[] = []

afterEach(() => {
  for (const repo of repos) removeRepo(repo)
  repos.length = 0
  for (const ctx of contexts) void ctx.fiber.dispose()
  contexts.length = 0
})

async function mountCtx(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

/** Backdate a directory's mtime so the age-based sweep treats it as stale. */
function backdate(dir: string): void {
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
  utimesSync(dir, stale, stale)
}

describe('sweepStaleWorktrees', () => {
  it('removes a subagent-* worktree whose directory is older than the ceiling', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await mountCtx()
    const worktreeRoot = join(repo, '.dsh', 'worktrees')
    const commit = await (async () => {
      const probeCtx = ctx
      const head = gitIn(repo, ['rev-parse', 'HEAD'])
      void probeCtx
      return head.trim()
    })()
    mkdirSync(worktreeRoot, { recursive: true })
    const path = join(worktreeRoot, 'subagent-stale')
    await addWorktree(ctx, repo, 'git', path, commit)
    expect(await worktreeExists(ctx, repo, 'git', path)).toBe(true)

    backdate(path)
    const swept = await sweepStaleWorktrees(ctx, {
      repoRoot: repo,
      worktreeRoot,
      git: 'git',
      staleAfterMs: 60 * 60 * 1000,
    })

    expect(swept).toEqual([path])
    expect(await worktreeExists(ctx, repo, 'git', path)).toBe(false)
  })

  it('keeps a fresh subagent-* worktree under the ceiling', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await mountCtx()
    const worktreeRoot = join(repo, '.dsh', 'worktrees')
    const commit = gitIn(repo, ['rev-parse', 'HEAD']).trim()
    mkdirSync(worktreeRoot, { recursive: true })
    const path = join(worktreeRoot, 'subagent-fresh')
    await addWorktree(ctx, repo, 'git', path, commit)

    const swept = await sweepStaleWorktrees(ctx, {
      repoRoot: repo,
      worktreeRoot,
      git: 'git',
      staleAfterMs: 60 * 60 * 1000,
    })

    expect(swept).toEqual([])
    expect(await worktreeExists(ctx, repo, 'git', path)).toBe(true)
  })

  it('ignores directories outside the subagent- namespace even when stale', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await mountCtx()
    const worktreeRoot = join(repo, '.dsh', 'worktrees')
    const foreign = join(worktreeRoot, 'unrelated-stuff')
    mkdirSync(foreign, { recursive: true })
    backdate(foreign)

    const swept = await sweepStaleWorktrees(ctx, {
      repoRoot: repo,
      worktreeRoot,
      git: 'git',
      staleAfterMs: 60 * 60 * 1000,
    })

    expect(swept).toEqual([])
  })

  it('prunes dangling worktree metadata when nothing meets the age ceiling', async () => {
    const repo = createGitRepo()
    repos.push(repo)
    const ctx = await mountCtx()
    const worktreeRoot = join(repo, '.dsh', 'worktrees')
    const commit = gitIn(repo, ['rev-parse', 'HEAD']).trim()
    mkdirSync(worktreeRoot, { recursive: true })
    const path = join(worktreeRoot, 'subagent-dangling')
    await addWorktree(ctx, repo, 'git', path, commit)
    // Simulate an out-of-band directory deletion: the git registration dangles.
    const { rmSync } = await import('node:fs')
    rmSync(path, { recursive: true, force: true })

    const swept = await sweepStaleWorktrees(ctx, {
      repoRoot: repo,
      worktreeRoot,
      git: 'git',
      // Nothing can be older than +1h from now, so no removal happens; only
      // the metadata prune runs — which must clear the dangling registration.
      staleAfterMs: -60 * 60 * 1000,
    })
    expect(swept).toEqual([])
    expect(await worktreeExists(ctx, repo, 'git', path)).toBe(false)
  })
})
