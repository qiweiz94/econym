/**
 * Types shared by the module-boundary guard and its workspace-index builder.
 * This module contains only types; the pure boundary logic lives in guard.ts.
 * @module @deepseek-ai/dsh-plugin-arch-guard/types
 */

/**
 * Architectural tier a package group belongs to, ordered foundation < capability
 * < surface. A package may depend on its own tier or a lower one, never a
 * higher one. See guard.ts for the ordering rule and its rationale.
 */
export type PackageTier = 'foundation' | 'capability' | 'surface'

/** One workspace package as the guard sees it: identity, layer, exported surface, and declared edges. */
export interface WorkspacePackage {
  /** The full npm package name (e.g. `@deepseek-ai/dsh-tools`). */
  readonly name: string
  /** The `packages/<group>/<pkg>` group segment, or `vendor` for the vendored framework packages. */
  readonly group: string
  /** Repo-relative package directory (e.g. `packages/plugins/plugin-arch-guard`). */
  readonly dir: string
  /** Subpath export keys from `package.json` `exports` (e.g. `.`, `./invariant`, `./src/*`). */
  readonly exports: readonly string[]
  /** Names of other workspace packages this package declares as dependencies/peerDependencies/devDependencies. */
  readonly dependsOn: readonly string[]
}

/** The full workspace package graph the guard checks one import against. */
export interface WorkspaceIndex {
  /** Every known workspace package, keyed by npm package name. */
  readonly packages: ReadonlyMap<string, WorkspacePackage>
}

/** One `check_module_boundary` call. */
export interface CheckModuleBoundaryInput {
  /** Repo-relative path of the file the import would be written in (e.g. `packages/plugins/plugin-arch-guard/src/guard.ts`). */
  readonly sourcePath: string
  /** The import specifier as it would be written at the source site (e.g. `@deepseek-ai/dsh-tools`, `./helpers.ts`). */
  readonly targetImport: string
}

/** The guard's verdict on one proposed import. */
export interface CheckModuleBoundaryResult {
  /** Whether the import is legal under the encoded layering rules. */
  readonly allowed: boolean
  /** The rule name that decided the verdict, stable for programmatic matching. */
  readonly rule: string
  /** A corrective suggestion, present when the import is disallowed and a fix is known. */
  readonly suggestion?: string
}
