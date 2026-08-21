/**
 * Import-DAG analysis for `run_impacted_tests`.
 *
 * The graph is seeded from the discovered test suites and walked FORWARD
 * through each file's import specifiers, resolved with the TypeScript compiler
 * API against the workspace's own `tsconfig` (so `paths` land on `src`). The
 * forward edges are inverted once, and the impact walk runs REVERSE from the
 * change set: every file that transitively imports a changed file, intersected
 * with the discovered suites, is the selection.
 *
 * Seeding from the suites is exhaustive for this question: a file no suite can
 * reach cannot be imported by a suite, so its reverse closure contains no
 * suite. It also keeps the walk off the ~7,500 files a whole-workspace program
 * would load.
 *
 * Every path in the graph is absolute and symlink-free ({@link canonicalPath}),
 * because git reports repo-relative paths, the compiler reports absolute ones,
 * and a macOS `tmpdir()` fixture is reached through a `/var` → `/private/var`
 * symlink. A single normalizer is what keeps "selects nothing" a real answer
 * instead of a path-shape mismatch.
 * @module @deepseek-ai/dsh-plugin-impacted-tests/analyzer
 */

import { globSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type { ImpactAnalysis, ImportGraph } from './types.ts'

/** Source extensions the walk follows; a specifier landing elsewhere leaves the graph. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const

/** Workspace globs holding one manifest each, matching the repository layout. */
const MANIFEST_GLOBS = ['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json'] as const

/**
 * Absolute, symlink-free form of a path. The one normalizer every path in this
 * module passes through.
 * @param path - any absolute or relative path.
 * @returns the resolved real path, or the merely absolute path when it does not exist yet.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // The path names a deleted or not-yet-created file (a `git status` deletion,
    // or a changed path outside the tree); nothing else can fail here, and an
    // absolute non-existent path still compares correctly against the graph.
    return resolve(path)
  }
}

/**
 * Repo-relative, forward-slash form of an absolute path — the form the tool
 * reports and the runner receives.
 * @param root - the repository root.
 * @param path - an absolute path inside the root.
 * @returns the repo-relative path with `/` separators.
 */
export function toRepoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/**
 * Whether a resolved path is a source file the graph walks.
 * @param path - a resolved absolute path.
 * @returns true when the extension is a walkable TypeScript source extension.
 */
export function isSourcePath(path: string): boolean {
  return !path.endsWith('.d.ts') && SOURCE_EXTENSIONS.some(extension => path.endsWith(extension))
}

/** The first candidate that exists as a file, or undefined when none does. */
function firstExistingFile(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (ts.sys.fileExists(candidate)) return candidate
  }
  return undefined
}

/**
 * Load the compiler options that drive module resolution — chiefly `paths` and
 * `moduleResolution`, which map workspace package names onto `src`.
 * @param root - the repository root.
 * @param tsconfigPath - the config to read, absolute or root-relative.
 * @returns the parsed compiler options.
 */
export function loadCompilerOptions(root: string, tsconfigPath: string): ts.CompilerOptions {
  const configPath = isAbsolute(tsconfigPath) ? tsconfigPath : join(root, tsconfigPath)
  const read = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
  if (read.error !== undefined) {
    throw new Error(`cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`)
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath)).options
}

/**
 * Index every workspace manifest by package name, so a bare workspace import
 * that the compiler cannot resolve still lands on the package's sources.
 * @param root - the repository root.
 * @returns package name → the absolute package directory.
 */
export function workspacePackageIndex(root: string): Map<string, string> {
  const index = new Map<string, string>()
  for (const manifest of globSync([...MANIFEST_GLOBS], { cwd: root })) {
    const manifestPath = join(root, manifest)
    let name: unknown
    try {
      name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }).name
    } catch {
      // The manifest is unreadable or not valid JSON. A package the workspace
      // itself cannot parse contributes no importable sources, so it is simply
      // absent from the index; no other failure reaches this read.
      continue
    }
    if (typeof name === 'string') index.set(name, dirname(manifestPath))
  }
  return index
}

/**
 * Map a built artifact back onto its source file, keeping the graph on the
 * source plane: `<pkg>/lib/index.js` and `<pkg>/lib/types/x.d.ts` both become
 * `<pkg>/src/…`.
 * @param resolved - an absolute path the compiler resolved to.
 * @returns the source counterpart, or undefined when the path is not a built artifact.
 */
export function sourceForArtifact(resolved: string): string | undefined {
  const marker = resolved.lastIndexOf(`${sep}lib${sep}`)
  if (marker < 0) return undefined
  const packageDir = resolved.slice(0, marker)
  const emitted = resolved.slice(marker + `${sep}lib${sep}`.length)
  const withoutTypes = emitted.startsWith(`types${sep}`) ? emitted.slice(`types${sep}`.length) : emitted
  const stem = withoutTypes.replace(/\.d\.ts$|\.[cm]?[jt]sx?$/, '')
  return firstExistingFile([
    ...SOURCE_EXTENSIONS.map(extension => join(packageDir, 'src', `${stem}${extension}`)),
    ...SOURCE_EXTENSIONS.map(extension => join(packageDir, 'src', stem, `index${extension}`)),
  ])
}

/**
 * Resolve a bare workspace-package specifier against the manifest index. Used
 * when the compiler cannot resolve the name at all — an unbuilt package has no
 * `lib/` for its `exports` map to point at.
 * @param specifier - the import specifier, e.g. `@deepseek-ai/dsh-tools/schema`.
 * @param packages - the {@link workspacePackageIndex}.
 * @returns the source file, or undefined when the name is not a workspace package.
 */
export function sourceForWorkspaceSpecifier(specifier: string, packages: ReadonlyMap<string, string>): string | undefined {
  const firstSlash = specifier.indexOf('/')
  const nameEnd = specifier.startsWith('@') ? specifier.indexOf('/', firstSlash + 1) : firstSlash
  const name = nameEnd < 0 ? specifier : specifier.slice(0, nameEnd)
  const packageDir = packages.get(name)
  if (packageDir === undefined) return undefined
  const subpath = nameEnd < 0 ? '' : specifier.slice(nameEnd + 1)
  if (subpath.length === 0) {
    return firstExistingFile(SOURCE_EXTENSIONS.map(extension => join(packageDir, 'src', `index${extension}`)))
  }
  // A `./src/*` subpath export already names the source file; every other
  // subpath is an export alias resolved under `src`.
  const base = subpath.startsWith('src/') ? join(packageDir, subpath) : join(packageDir, 'src', subpath)
  return firstExistingFile([
    base,
    ...SOURCE_EXTENSIONS.map(extension => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map(extension => join(base, `index${extension}`)),
  ])
}

/** Resolve one import specifier from one containing file to an absolute path. */
export type ModuleResolver = (specifier: string, containingFile: string) => string | undefined

/**
 * Build the resolver the graph walk uses: the compiler's own resolution first
 * (relative specifiers, `paths`, `node_modules` and package `exports`), then
 * the artifact→source remap, then the workspace manifest index.
 * @param root - the repository root, the module-resolution cache's base.
 * @param options - the compiler options from {@link loadCompilerOptions}.
 * @param packages - the {@link workspacePackageIndex}.
 * @returns the resolver.
 */
export function createModuleResolver(
  root: string,
  options: ts.CompilerOptions,
  packages: ReadonlyMap<string, string>,
): ModuleResolver {
  const cache = ts.createModuleResolutionCache(root, fileName => fileName, options)
  return (specifier, containingFile) => {
    const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys, cache).resolvedModule
    if (resolved === undefined) return sourceForWorkspaceSpecifier(specifier, packages)
    return sourceForArtifact(resolved.resolvedFileName)
      ?? sourceForWorkspaceSpecifier(specifier, packages)
      ?? resolved.resolvedFileName
  }
}

/**
 * Discover the test suites the selection chooses among.
 * @param root - the repository root.
 * @param patterns - root-relative suite globs.
 * @returns canonical absolute suite paths, sorted and deduplicated.
 */
export function discoverSuites(root: string, patterns: readonly string[]): string[] {
  const suites = new Set<string>()
  for (const match of globSync([...patterns], { cwd: root, exclude: path => path.includes('node_modules') })) {
    suites.add(canonicalPath(join(root, match)))
  }
  return [...suites].sort()
}

/**
 * Walk the import DAG forward from the seeds and return it with its inverted
 * view. Only source files inside the resolver's reach become nodes.
 * @param seeds - canonical absolute files to start from (the discovered suites).
 * @param resolveModule - the {@link ModuleResolver}.
 * @returns the forward and reverse edge maps.
 */
export function buildImportGraph(seeds: readonly string[], resolveModule: ModuleResolver): ImportGraph {
  const imports = new Map<string, Set<string>>()
  const importedBy = new Map<string, Set<string>>()
  const queue = [...seeds]
  const visited = new Set<string>(seeds)
  while (queue.length > 0) {
    const file = queue.pop()
    /* v8 ignore next -- the loop condition guarantees pop() returns an element. */
    if (file === undefined) continue
    const text = ts.sys.readFile(file)
    if (text === undefined) continue
    const targets = new Set<string>()
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const target = resolveModule(imported.fileName, file)
      if (target === undefined || !isSourcePath(target)) continue
      const node = canonicalPath(target)
      targets.add(node)
      const importers = importedBy.get(node)
      if (importers === undefined) importedBy.set(node, new Set([file]))
      else importers.add(file)
      if (visited.has(node)) continue
      visited.add(node)
      queue.push(node)
    }
    imports.set(file, targets)
  }
  return { imports, importedBy }
}

/**
 * Walk the DAG in reverse: every file that transitively imports a changed
 * file, plus the changed files themselves (so a changed suite selects itself).
 * @param importedBy - the graph's reverse edges.
 * @param changed - canonical absolute changed paths.
 * @returns the reverse closure.
 */
export function reverseClosure(importedBy: ReadonlyMap<string, ReadonlySet<string>>, changed: readonly string[]): Set<string> {
  const closure = new Set<string>(changed)
  const queue = [...changed]
  while (queue.length > 0) {
    const file = queue.pop()
    /* v8 ignore next -- the loop condition guarantees pop() returns an element. */
    if (file === undefined) continue
    for (const importer of importedBy.get(file) ?? []) {
      if (closure.has(importer)) continue
      closure.add(importer)
      queue.push(importer)
    }
  }
  return closure
}

/**
 * Parse `git status --porcelain` into the uncommitted change set. Renames
 * report their destination; quoted paths are unquoted.
 * @param porcelain - the `git status --porcelain` output.
 * @returns the changed paths, repo-relative.
 */
export function parseGitStatus(porcelain: string): string[] {
  const files: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length <= 3) continue
    const entry = line.slice(3)
    const arrow = entry.lastIndexOf(' -> ')
    const path = arrow < 0 ? entry : entry.slice(arrow + 4)
    files.push(path.replace(/^"(.*)"$/, '$1'))
  }
  return files
}

/** One impact question: which suites can this change set break? */
export interface ImpactRequest {
  /** The repository root. */
  readonly root: string
  /** The change set, repo-relative or absolute. */
  readonly changedFiles: readonly string[]
  /** Root-relative suite globs. */
  readonly testPatterns: readonly string[]
  /** The tsconfig driving module resolution, absolute or root-relative. */
  readonly tsconfigPath: string
}

/**
 * Answer one impact question. An empty change set selects nothing and builds
 * no graph — running every suite is the failure this tool exists to prevent.
 * @param request - the {@link ImpactRequest}.
 * @returns the {@link ImpactAnalysis}.
 */
export function analyzeImpact(request: ImpactRequest): ImpactAnalysis {
  const root = canonicalPath(request.root)
  const suites = discoverSuites(root, request.testPatterns)
  if (request.changedFiles.length === 0) {
    return { selectedSuites: [], skippedCount: suites.length, discoveredCount: suites.length }
  }
  const changed = request.changedFiles.map(file => canonicalPath(resolve(root, file)))
  const options = loadCompilerOptions(root, request.tsconfigPath)
  const resolver = createModuleResolver(root, options, workspacePackageIndex(root))
  const { importedBy } = buildImportGraph(suites, resolver)
  const closure = reverseClosure(importedBy, changed)
  const selectedSuites = suites.filter(suite => closure.has(suite)).map(suite => toRepoRelative(root, suite)).sort()
  return { selectedSuites, skippedCount: suites.length - selectedSuites.length, discoveredCount: suites.length }
}
