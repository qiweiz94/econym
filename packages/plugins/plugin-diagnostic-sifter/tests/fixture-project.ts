/**
 * Test fixture helper: a throwaway `tsc -b` + `vitest run` project the tool
 * spawns for real. `node_modules` is a symlink to the repository's own
 * install (this repo's local `tsc`/`vitest` binaries), so the fixture never
 * needs its own dependency install.
 * @module plugin-diagnostic-sifter/test/fixture-project
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root's `node_modules`, symlinked into every fixture project. */
const repoNodeModules = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules')

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    composite: true,
    outDir: 'lib',
    skipLibCheck: true,
  },
  include: ['src'],
}, null, 2)

const VITEST_CONFIG = [
  "import { defineConfig } from 'vitest/config'",
  "export default defineConfig({ test: { include: ['src/**/*.test.ts'], watch: false } })",
  '',
].join('\n')

/**
 * Create a throwaway fixture project with a composite `tsconfig.json` and a
 * `vitest.config.ts`, both wired to run against `src/`.
 * @param files - path (under the project root) → content, written after the
 * base config; use this to add `src/*.ts` and `src/*.test.ts`.
 * @returns the project root.
 */
export function createFixtureProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-sifter-fixture-'))
  symlinkSync(repoNodeModules, join(root, 'node_modules'))
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG)
  writeFileSync(join(root, 'vitest.config.ts'), VITEST_CONFIG)
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content)
  return root
}

/** Remove a throwaway fixture project root (its `node_modules` symlink, not its target). */
export function removeFixtureProject(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
