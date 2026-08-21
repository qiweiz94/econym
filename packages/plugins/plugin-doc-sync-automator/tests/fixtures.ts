/**
 * Test fixture helpers: throwaway repo-shaped directories for the doc-sync
 * tests. Pure `node:fs`, independent of the seam under test.
 * @module plugin-doc-sync-automator/test/fixtures
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Create a throwaway directory and write the given repo-relative files into it.
 * @param files - repo-relative path → content map.
 * @returns the directory root.
 */
export function createFixtureRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doc-sync-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

/** Remove a fixture root created by `createFixtureRoot`. */
export function removeFixtureRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
