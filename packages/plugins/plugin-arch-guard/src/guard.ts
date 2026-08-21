/**
 * Pure module-boundary check: given a source file and an import specifier, is
 * the import legal under the monorepo's layering rules? No filesystem access
 * and no process spawning — callers resolve a {@link WorkspaceIndex} (see
 * workspace-index.ts) once and pass it in, so this file stays a pure function
 * of its inputs and is exercised directly against constructed fixtures.
 *
 * The rules are derived from the repo's own constraint tooling and stated
 * conventions, not invented:
 *
 * - **Tier direction** (foundation < capability < surface): `vendor` packages
 *   carry no in-repo dsh-scoped dependency (scripts/check-workspace-constraints.ts
 *   `vendoredPackages` returns early from every dsh-scoped check) and `util`
 *   is documented "harness-dep-free" (packages/README.md); together they form
 *   the foundation tier. `plugins`/`host`/`client` are the composition surface
 *   plugins/README.md describes as "self-contained model-facing tool plugins"
 *   and the web GUI halves built atop the product spine; everything else is
 *   the broad capability/product-spine tier packages/core/README.md calls
 *   "the stable surface plugins and consumers build against." A lower tier
 *   depending on a higher one would invert that spine.
 * - **Plugins do not import each other undeclared**: packages/README.md states
 *   "Extension plugins depend on Service Definitions, never concrete
 *   providers," and empirically no shipped `packages/plugins/*` package lists
 *   another `plugins/*` package in its `dependencies`/`peerDependencies`/
 *   `devDependencies` — each depends only on capability-tier seams (tools,
 *   invariants, llm, subagent, subprocess, output-retention) plus cordis.
 * - **Acyclicity**: scripts/package-graph.ts `topoSort` throws
 *   `dependency cycle among ...` when a package's peer-dependency graph is not
 *   a DAG; that same graph (here, `WorkspacePackage.dependsOn`) is the module-
 *   graph gate scripts/gen-module-graph.ts renders from.
 * - **Exports map validity**: `scripts/check-workspace-constraints.ts` and
 *   every shipped package.json restrict consumers to declared `exports`
 *   subpaths (Node's own package-exports enforcement); a subpath a target does
 *   not export is not importable regardless of tier.
 * - **Relative imports stay in-package**: root AGENTS.md conventions call for
 *   package-name imports across packages and `.ts`-suffixed relative imports
 *   only within one package; a relative specifier that resolves outside the
 *   source package's own directory is the escape this rule catches.
 *
 * @module @deepseek-ai/dsh-plugin-arch-guard/guard
 */

import type { CheckModuleBoundaryInput, CheckModuleBoundaryResult, PackageTier, WorkspaceIndex, WorkspacePackage } from './types.ts'

/** Groups with no in-repo dsh-scoped dependency: the vendored framework and the dep-free `util` group. */
const FOUNDATION_GROUPS: ReadonlySet<string> = new Set(['vendor', 'util'])

/** Groups that compose the product spine into a model-facing surface: tool plugins and the web GUI halves. */
const SURFACE_GROUPS: ReadonlySet<string> = new Set(['plugins', 'host', 'client'])

/** Group whose members may not import one another without a declared dependency edge. */
const PLUGINS_GROUP = 'plugins'

/** Ordering used to decide whether an edge points from a lower tier to a higher one. */
const TIER_RANK: Readonly<Record<PackageTier, number>> = {
  foundation: 0,
  capability: 1,
  surface: 2,
}

/**
 * Classify a package group into its architectural tier.
 * @param group - the `packages/<group>` segment (or `vendor`).
 * @returns the tier the group belongs to.
 */
export function tierOf(group: string): PackageTier {
  if (FOUNDATION_GROUPS.has(group)) return 'foundation'
  if (SURFACE_GROUPS.has(group)) return 'surface'
  return 'capability'
}

/**
 * Check whether a proposed import is legal under the monorepo's layering
 * rules: tier direction, the plugins-do-not-import-siblings rule, package-
 * graph acyclicity, and the target package's `exports` map.
 * @param input - the source file and the import specifier written there.
 * @param workspace - the workspace package graph to check against.
 * @returns the verdict, with the deciding rule name and, when disallowed, a suggestion.
 */
export function checkModuleBoundary(
  input: CheckModuleBoundaryInput,
  workspace: WorkspaceIndex,
): CheckModuleBoundaryResult {
  const sourcePkg = resolveOwningPackage(input.sourcePath, workspace)
  if (sourcePkg === undefined) {
    return {
      allowed: false,
      rule: 'unknown-source-package',
      suggestion: 'sourcePath must live under a workspace package directory (packages/<group>/<pkg>/... or vendor/<pkg>/...).',
    }
  }

  if (isRelativeSpecifier(input.targetImport)) {
    return checkRelativeImport(input.sourcePath, input.targetImport, sourcePkg)
  }

  const { packageName, subpath } = splitBareSpecifier(input.targetImport)
  if (!packageName.startsWith('@deepseek-ai/')) {
    return { allowed: true, rule: 'external-dependency' }
  }

  const targetPkg = workspace.packages.get(packageName)
  if (targetPkg === undefined) {
    return {
      allowed: false,
      rule: 'unknown-workspace-package',
      suggestion: `${packageName} is not a known @deepseek-ai/* workspace package; check the name, or that the workspace index was built after it was added.`,
    }
  }

  if (targetPkg.name === sourcePkg.name) {
    return { allowed: true, rule: 'self-package-import' }
  }

  const layerViolation = checkTierDirection(sourcePkg, targetPkg)
  if (layerViolation !== undefined) return layerViolation

  const siblingViolation = checkPluginSiblingRule(sourcePkg, targetPkg)
  if (siblingViolation !== undefined) return siblingViolation

  if (wouldCreateCycle(sourcePkg, targetPkg, workspace)) {
    return {
      allowed: false,
      rule: 'circular-workspace-dependency',
      suggestion: `${targetPkg.name} already depends (directly or transitively) on ${sourcePkg.name}; importing it back would put a cycle in the package graph.`,
    }
  }

  if (!matchesExportKey(targetPkg.exports, subpath)) {
    return {
      allowed: false,
      rule: 'non-exported-subpath',
      suggestion: `${targetPkg.name} does not export ${subpath}; it exports: ${targetPkg.exports.join(', ') || '(nothing)'}.`,
    }
  }

  const isDeclaredPluginSibling = sourcePkg.group === PLUGINS_GROUP && targetPkg.group === PLUGINS_GROUP
  return {
    allowed: true,
    rule: isDeclaredPluginSibling ? 'plugins-declared-sibling-import' : 'legal-cross-package-import',
  }
}

/** Find the workspace package that owns a repo-relative source file, by longest directory-prefix match. */
function resolveOwningPackage(sourcePath: string, workspace: WorkspaceIndex): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined
  for (const pkg of workspace.packages.values()) {
    if (sourcePath !== pkg.dir && !sourcePath.startsWith(`${pkg.dir}/`)) continue
    if (best === undefined || pkg.dir.length > best.dir.length) best = pkg
  }
  return best
}

/** Whether an import specifier is a relative path rather than a bare package specifier. */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

/** Evaluate a relative import: legal only while it stays inside the source package's own directory. */
function checkRelativeImport(
  sourcePath: string,
  targetImport: string,
  sourcePkg: WorkspacePackage,
): CheckModuleBoundaryResult {
  const resolved = resolveRelativeSpecifier(sourcePath, targetImport)
  if (resolved === sourcePkg.dir || resolved.startsWith(`${sourcePkg.dir}/`)) {
    return { allowed: true, rule: 'same-package-relative-import' }
  }
  return {
    allowed: false,
    rule: 'relative-import-escapes-package',
    suggestion: `a relative import from ${sourcePath} may not leave ${sourcePkg.dir}; import ${sourcePkg.name}'s target by package name instead.`,
  }
}

/** Join a relative specifier onto a source file's directory and collapse `.`/`..` segments (posix, no fs access). */
function resolveRelativeSpecifier(sourcePath: string, specifier: string): string {
  const sourceSegments = sourcePath.split('/')
  sourceSegments.pop() // drop the file name; joins happen from its directory
  const combined = [...sourceSegments, ...specifier.split('/')]
  const resolved: string[] = []
  for (const segment of combined) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolved.length > 0) resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}

/** Split a bare import specifier into its package name and the `exports`-map subpath key it addresses. */
function splitBareSpecifier(specifier: string): { packageName: string; subpath: string } {
  const segments = specifier.split('/')
  const nameSegments = specifier.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)
  const packageName = nameSegments.join('/')
  const rest = segments.slice(nameSegments.length).join('/')
  return { packageName, subpath: rest === '' ? '.' : `./${rest}` }
}

/** Deny an import whose target tier ranks above the source's tier. */
function checkTierDirection(sourcePkg: WorkspacePackage, targetPkg: WorkspacePackage): CheckModuleBoundaryResult | undefined {
  const sourceTier = tierOf(sourcePkg.group)
  const targetTier = tierOf(targetPkg.group)
  if (TIER_RANK[targetTier] <= TIER_RANK[sourceTier]) return undefined
  return {
    allowed: false,
    rule: 'layer-violation',
    suggestion: `${sourcePkg.group} (${sourceTier}) may not depend on ${targetPkg.group} (${targetTier}); a package may depend on its own tier or a lower one only.`,
  }
}

/** Deny a plugins-group import of a sibling plugins-group package that the source does not declare a dependency on. */
function checkPluginSiblingRule(sourcePkg: WorkspacePackage, targetPkg: WorkspacePackage): CheckModuleBoundaryResult | undefined {
  if (sourcePkg.group !== PLUGINS_GROUP || targetPkg.group !== PLUGINS_GROUP) return undefined
  if (sourcePkg.dependsOn.includes(targetPkg.name)) return undefined
  return {
    allowed: false,
    rule: 'plugins-forbidden-sibling-import',
    suggestion: `${sourcePkg.name} does not declare ${targetPkg.name} as a dependency; plugins may not import each other unless the edge is declared in package.json.`,
  }
}

/** Whether the target package already (transitively) depends on the source, so importing it back would cycle. */
function wouldCreateCycle(sourcePkg: WorkspacePackage, targetPkg: WorkspacePackage, workspace: WorkspaceIndex): boolean {
  const seen = new Set<string>()
  const stack = [targetPkg.name]
  while (stack.length > 0) {
    const current = stack.pop()
    /* v8 ignore next -- the loop condition guarantees a non-empty stack; the guard answers pop()'s optional type. */
    if (current === undefined) continue
    if (seen.has(current)) continue
    seen.add(current)
    if (current === sourcePkg.name) return true
    const pkg = workspace.packages.get(current)
    if (pkg === undefined) continue
    for (const dep of pkg.dependsOn) if (!seen.has(dep)) stack.push(dep)
  }
  return false
}

/** Whether an `exports`-map key set covers a subpath, honoring one `*` wildcard per Node's subpath-pattern rules. */
function matchesExportKey(exportKeys: readonly string[], subpath: string): boolean {
  for (const pattern of exportKeys) {
    if (pattern === subpath) return true
    const starIndex = pattern.indexOf('*')
    if (starIndex === -1) continue
    const prefix = pattern.slice(0, starIndex)
    const suffix = pattern.slice(starIndex + 1)
    if (subpath.length > prefix.length + suffix.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) return true
  }
  return false
}
