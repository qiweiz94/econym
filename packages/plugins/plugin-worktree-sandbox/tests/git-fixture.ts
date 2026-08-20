/**
 * Test fixture helpers: create throwaway git repositories for the worktree
 * sandbox tests. Uses Node's own child_process (test infrastructure only) so
 * the fixtures are independent of the seam under test.
 * @module plugin-worktree-sandbox/test/git-fixture
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Run `git` and return stdout. Throws on a non-zero exit. */
export function gitIn(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/**
 * Create a throwaway git repository with an initial commit.
 * @param files - path → content map committed as the initial tree (default: one `a.txt`).
 * @returns the repository root.
 */
export function createGitRepo(files: Record<string, string> = { 'a.txt': 'base\n' }): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sandbox-git-'))
  gitIn(root, ['init'])
  gitIn(root, ['config', 'user.email', 'sandbox-test@example.com'])
  gitIn(root, ['config', 'user.name', 'Sandbox Test'])
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  gitIn(root, ['add', '.'])
  gitIn(root, ['commit', '-m', 'init'])
  return root
}

/** Remove a throwaway repository root. */
export function removeRepo(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
