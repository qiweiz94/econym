/**
 * Build the {@link WorkspaceIndex} guard.ts checks imports against, by reading
 * every workspace package's `package.json` from disk. Kept separate from
 * guard.ts so the boundary logic itself stays pure and unit-testable against
 * constructed fixtures — this module is the only place in the package that
 * touches the filesystem, and it does so with plain synchronous reads, no
 * subprocess.
 * @module @econym/dsh-plugin-arch-guard/workspace-index
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { WorkspaceIndex, WorkspacePackage } from './types.ts'

/** The subset of package.json fields the workspace index reads. */
interface PackageManifest {
  name?: string
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** One manifest glob and how to derive its packages' group from the matched repo-relative path. */
interface ManifestSource {
  readonly pattern: string
  readonly group: (relPath: string) => string
}

/**
 * `packages/<group>/<pkg>/package.json` carries its group in the path;
 * `vendor/<pkg>/package.json` is single-level and always the `vendor` group
 * (mirrors scripts/check-workspace-constraints.ts `workspaceGlobs`).
 */
const MANIFEST_SOURCES: readonly ManifestSource[] = [
  { pattern: 'packages/*/*/package.json', group: groupFromPackagesPath },
  { pattern: 'vendor/*/package.json', group: () => 'vendor' },
]

/** Extract the `<group>` segment of a `packages/<group>/<pkg>/package.json` glob match. */
function groupFromPackagesPath(relPath: string): string {
  const [, group] = relPath.split('/')
  /* v8 ignore next -- the `packages/*\/*\/package.json` glob guarantees a group segment; this only guards the indexed-access type. */
  if (group === undefined) throw new Error(`workspace-index: unexpected package path ${relPath}`)
  return group
}

/**
 * Scan the workspace package manifests under `root` and build the index
 * {@link checkModuleBoundary} evaluates imports against.
 * @param root - absolute repository root.
 * @returns the discovered workspace packages, keyed by npm package name.
 */
export function buildWorkspaceIndex(root: string): WorkspaceIndex {
  const packages = new Map<string, WorkspacePackage>()
  for (const source of MANIFEST_SOURCES) {
    for (const relPath of globSync(source.pattern, { cwd: root }).map(path => path.split(sep).join('/')).sort()) {
      const manifest = readManifest(resolve(root, relPath))
      if (manifest.name === undefined) continue
      packages.set(manifest.name, {
        name: manifest.name,
        group: source.group(relPath),
        dir: dirname(relPath),
        exports: Object.keys(manifest.exports ?? {}),
        dependsOn: workspaceDependencyNames(manifest),
      })
    }
  }
  return { packages }
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

/** Names of workspace-protocol dependencies across dependencies/devDependencies/peerDependencies. */
function workspaceDependencyNames(manifest: PackageManifest): readonly string[] {
  const names = new Set<string>()
  for (const section of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
    for (const [name, range] of Object.entries(section ?? {})) {
      if (range.startsWith('workspace:')) names.add(name)
    }
  }
  return [...names]
}
