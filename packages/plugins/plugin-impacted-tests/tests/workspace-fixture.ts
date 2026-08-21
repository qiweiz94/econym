/**
 * Test fixture helpers: build a throwaway workspace whose layout mirrors the
 * repository (a tsconfig with `paths`, packages under `packages/<group>/<pkg>`
 * with `src` and `tests`, and one package published only as a built `lib`), so
 * the analyzer's real module resolution is exercised against real files.
 * @module plugin-impacted-tests/test/workspace-fixture
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Write one file, creating parent directories. */
export function writeFixtureFile(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/**
 * Create the fixture workspace.
 *
 * - `@fixture/mapped` is reachable through a tsconfig `paths` entry (the repo's own convention).
 * - `@fixture/unmapped` and `plainpkg` have no `paths` entry and no `node_modules`
 *   link, so only the workspace manifest index can resolve them.
 * - `@fixture/built` has a `paths` entry pointing at its emitted `lib/index.js`,
 *   so the artifact→source remap decides its node.
 * - `packages/app` holds the suites, their sources, and one source no suite imports.
 * @returns the fixture root.
 */
export function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-impacted-ws-'))

  writeFixtureFile(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      module: 'esnext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      paths: {
        '@fixture/mapped': ['./packages/group/mapped/src/index.ts'],
        '@fixture/built': ['./packages/group/built/lib/index.js'],
      },
    },
  }))

  writeFixtureFile(root, 'packages/group/mapped/package.json', JSON.stringify({ name: '@fixture/mapped' }))
  writeFixtureFile(root, 'packages/group/mapped/src/index.ts', 'export const mapped = 1\n')

  writeFixtureFile(root, 'packages/group/unmapped/package.json', JSON.stringify({ name: '@fixture/unmapped' }))
  writeFixtureFile(root, 'packages/group/unmapped/src/index.ts', "export { helper } from './helper.ts'\n")
  writeFixtureFile(root, 'packages/group/unmapped/src/helper.ts', 'export const helper = 2\n')
  writeFixtureFile(root, 'packages/group/unmapped/src/nested/index.ts', 'export const nested = 3\n')

  writeFixtureFile(root, 'packages/group/plain/package.json', JSON.stringify({ name: 'plainpkg' }))
  writeFixtureFile(root, 'packages/group/plain/src/index.ts', 'export const plain = 4\n')
  writeFixtureFile(root, 'packages/group/plain/src/sub.ts', 'export const sub = 5\n')

  writeFixtureFile(root, 'packages/group/built/package.json', JSON.stringify({ name: '@fixture/built' }))
  writeFixtureFile(root, 'packages/group/built/src/index.ts', 'export const built = 6\n')
  writeFixtureFile(root, 'packages/group/built/lib/index.js', 'export const built = 6\n')
  writeFixtureFile(root, 'packages/group/built/lib/types/index.d.ts', 'export declare const built: number\n')

  // A manifest the workspace itself cannot parse, and one with no name: both
  // contribute no importable sources and must simply be absent from the index.
  writeFixtureFile(root, 'packages/group/broken/package.json', '{ not json')
  writeFixtureFile(root, 'packages/group/nameless/package.json', JSON.stringify({ version: '0.0.0' }))

  writeFixtureFile(root, 'packages/group/app/package.json', JSON.stringify({ name: '@fixture/app' }))
  writeFixtureFile(root, 'packages/group/app/src/core.ts', [
    "import { mapped } from '@fixture/mapped'",
    "import { helper } from '@fixture/unmapped'",
    "import { built } from '@fixture/built'",
    "import { leaf } from './leaf.ts'",
    "import missing from 'not-a-package-anywhere'",
    'export const core = mapped + helper + built + leaf + Number(missing)',
    '',
  ].join('\n'))
  writeFixtureFile(root, 'packages/group/app/src/leaf.ts', 'export const leaf = 7\n')
  writeFixtureFile(root, 'packages/group/app/src/unrelated.ts', 'export const unrelated = 8\n')
  writeFixtureFile(root, 'packages/group/app/tests/core.spec.ts', "import { core } from '../src/core.ts'\nexport default core\n")
  writeFixtureFile(root, 'packages/group/app/tests/unrelated.spec.ts', "import { unrelated } from '../src/unrelated.ts'\nexport default unrelated\n")
  writeFixtureFile(root, 'packages/group/app/tests/standalone.spec.ts', 'export default 9\n')

  writeFixtureFile(root, 'sample/notes.md', '# not code\n')
  return root
}

/** Remove a fixture workspace root. */
export function removeWorkspace(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
