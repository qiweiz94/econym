import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  analyzeImpact,
  buildImportGraph,
  canonicalPath,
  createModuleResolver,
  discoverSuites,
  isSourcePath,
  loadCompilerOptions,
  parseGitStatus,
  reverseClosure,
  sourceForArtifact,
  sourceForWorkspaceSpecifier,
  toRepoRelative,
  workspacePackageIndex,
} from '../src/analyzer.ts'
import { createWorkspace, removeWorkspace, writeFixtureFile } from './workspace-fixture.ts'

const roots: string[] = []
const SUITE_PATTERNS = ['packages/*/*/tests/**/*.spec.ts'] as const

/** Create a fixture workspace registered for teardown. */
function workspace(): string {
  const root = createWorkspace()
  roots.push(root)
  return canonicalPath(root)
}

/** The analyzer's resolver over a fixture workspace. */
function resolverFor(root: string): ReturnType<typeof createModuleResolver> {
  return createModuleResolver(root, loadCompilerOptions(root, 'tsconfig.json'), workspacePackageIndex(root))
}

/** Run the whole selection against a fixture workspace. */
function analyze(root: string, changedFiles: readonly string[]): ReturnType<typeof analyzeImpact> {
  return analyzeImpact({ root, changedFiles, testPatterns: SUITE_PATTERNS, tsconfigPath: 'tsconfig.json' })
}

afterEach(() => {
  for (const root of roots) removeWorkspace(root)
  roots.length = 0
})

describe('path normalization', () => {
  it('resolves an existing path through its symlinks and an absent one to an absolute path', () => {
    const root = workspace()
    const source = join(root, 'packages/group/app/src/leaf.ts')
    expect(canonicalPath(source)).toBe(source)
    const absent = join(root, 'packages/group/app/src/deleted.ts')
    expect(canonicalPath(absent)).toBe(absent)
  })

  it('reports repo-relative paths with forward slashes', () => {
    const root = workspace()
    expect(toRepoRelative(root, join(root, 'packages/group/app/src/leaf.ts'))).toBe('packages/group/app/src/leaf.ts')
  })

  it('walks TypeScript sources but not declarations or emitted JavaScript', () => {
    expect(isSourcePath('/a/b.ts')).toBe(true)
    expect(isSourcePath('/a/b.tsx')).toBe(true)
    expect(isSourcePath('/a/b.mts')).toBe(true)
    expect(isSourcePath('/a/b.d.ts')).toBe(false)
    expect(isSourcePath('/a/b.js')).toBe(false)
    expect(isSourcePath('/a/b.md')).toBe(false)
  })
})

describe('compiler options', () => {
  it('loads the resolution options from the workspace tsconfig', () => {
    const root = workspace()
    const options = loadCompilerOptions(root, 'tsconfig.json')
    expect(options.paths?.['@fixture/mapped']).toBeDefined()
    expect(loadCompilerOptions(root, join(root, 'tsconfig.json')).paths).toEqual(options.paths)
  })

  it('fails loud when the tsconfig cannot be read', () => {
    const root = workspace()
    expect(() => loadCompilerOptions(root, 'tsconfig.absent.json')).toThrow(/cannot read/)
  })
})

describe('workspace manifest index', () => {
  it('indexes every parsable named manifest and omits the rest', () => {
    const root = workspace()
    const index = workspacePackageIndex(root)
    expect(index.get('@fixture/unmapped')).toBe(join(root, 'packages/group/unmapped'))
    expect(index.get('plainpkg')).toBe(join(root, 'packages/group/plain'))
    expect([...index.keys()].some(name => name.includes('broken'))).toBe(false)
    // mapped, unmapped, plain, built, app — the unparsable and the nameless are absent.
    expect(index.size).toBe(5)
  })
})

describe('artifact to source remap', () => {
  it('maps an emitted entry and a declaration back onto the package sources', () => {
    const root = workspace()
    const built = join(root, 'packages/group/built')
    expect(sourceForArtifact(join(built, 'lib/index.js'))).toBe(join(built, 'src/index.ts'))
    expect(sourceForArtifact(join(built, 'lib/types/index.d.ts'))).toBe(join(built, 'src/index.ts'))
  })

  it('maps an emitted directory entry onto its source index', () => {
    const root = workspace()
    const built = join(root, 'packages/group/built')
    writeFixtureFile(root, 'packages/group/built/src/deep/index.ts', 'export const deep = 1\n')
    expect(sourceForArtifact(join(built, 'lib/deep.js'))).toBe(join(built, 'src/deep/index.ts'))
  })

  it('returns nothing for a path outside a lib directory or with no source counterpart', () => {
    const root = workspace()
    expect(sourceForArtifact(join(root, 'packages/group/app/src/leaf.ts'))).toBeUndefined()
    expect(sourceForArtifact(join(root, 'packages/group/built/lib/absent.js'))).toBeUndefined()
  })
})

describe('workspace specifier fallback', () => {
  it('resolves scoped and unscoped workspace names, bare and with a subpath', () => {
    const root = workspace()
    const packages = workspacePackageIndex(root)
    const unmapped = join(root, 'packages/group/unmapped')
    const plain = join(root, 'packages/group/plain')
    expect(sourceForWorkspaceSpecifier('@fixture/unmapped', packages)).toBe(join(unmapped, 'src/index.ts'))
    expect(sourceForWorkspaceSpecifier('@fixture/unmapped/src/helper.ts', packages)).toBe(join(unmapped, 'src/helper.ts'))
    expect(sourceForWorkspaceSpecifier('@fixture/unmapped/helper', packages)).toBe(join(unmapped, 'src/helper.ts'))
    expect(sourceForWorkspaceSpecifier('@fixture/unmapped/nested', packages)).toBe(join(unmapped, 'src/nested/index.ts'))
    expect(sourceForWorkspaceSpecifier('plainpkg', packages)).toBe(join(plain, 'src/index.ts'))
    expect(sourceForWorkspaceSpecifier('plainpkg/sub', packages)).toBe(join(plain, 'src/sub.ts'))
  })

  it('returns nothing for a non-workspace name or an absent subpath', () => {
    const root = workspace()
    const packages = workspacePackageIndex(root)
    expect(sourceForWorkspaceSpecifier('./leaf.ts', packages)).toBeUndefined()
    expect(sourceForWorkspaceSpecifier('@nowhere/none', packages)).toBeUndefined()
    expect(sourceForWorkspaceSpecifier('@fixture/unmapped/absent', packages)).toBeUndefined()
  })
})

describe('module resolution', () => {
  it('lands every specifier kind on the source plane', () => {
    const root = workspace()
    const resolve = resolverFor(root)
    const core = join(root, 'packages/group/app/src/core.ts')
    // Relative: the compiler resolves it and neither remap applies.
    expect(resolve('./leaf.ts', core)).toBe(join(root, 'packages/group/app/src/leaf.ts'))
    // A tsconfig `paths` entry — the repository's own workspace convention.
    expect(resolve('@fixture/mapped', core)).toBe(join(root, 'packages/group/mapped/src/index.ts'))
    // A `paths` entry pointing at emitted output: the artifact→source remap decides.
    expect(resolve('@fixture/built', core)).toBe(join(root, 'packages/group/built/src/index.ts'))
    // No `paths` entry and no node_modules link: the manifest index decides.
    expect(resolve('@fixture/unmapped', core)).toBe(join(root, 'packages/group/unmapped/src/index.ts'))
    // Neither the compiler nor the workspace knows it.
    expect(resolve('not-a-package-anywhere', core)).toBeUndefined()
  })
})

describe('import DAG', () => {
  it('walks forward from the suites and inverts the edges', () => {
    const root = workspace()
    const suites = discoverSuites(root, SUITE_PATTERNS)
    const graph = buildImportGraph(suites, resolverFor(root))
    const coreSpec = join(root, 'packages/group/app/tests/core.spec.ts')
    const core = join(root, 'packages/group/app/src/core.ts')
    const helper = join(root, 'packages/group/unmapped/src/helper.ts')

    expect(suites.map(suite => toRepoRelative(root, suite))).toEqual([
      'packages/group/app/tests/core.spec.ts',
      'packages/group/app/tests/standalone.spec.ts',
      'packages/group/app/tests/unrelated.spec.ts',
    ])
    expect([...graph.imports.get(coreSpec) ?? []]).toEqual([core])
    expect([...graph.importedBy.get(core) ?? []]).toEqual([coreSpec])
    // Reached only through @fixture/unmapped's own index — a transitive hop.
    expect(graph.importedBy.has(helper)).toBe(true)
    expect(graph.imports.get(join(root, 'packages/group/app/tests/standalone.spec.ts'))?.size).toBe(0)
  })

  it('skips a seed whose file cannot be read', () => {
    const root = workspace()
    const graph = buildImportGraph([join(root, 'packages/group/app/tests/absent.spec.ts')], resolverFor(root))
    expect(graph.imports.size).toBe(0)
  })

  it('records a second importer of a shared node without losing the first', () => {
    const root = workspace()
    writeFixtureFile(root, 'packages/group/app/tests/second.spec.ts', "import { leaf } from '../src/leaf.ts'\nexport default leaf\n")
    const graph = buildImportGraph(discoverSuites(root, SUITE_PATTERNS), resolverFor(root))
    const leaf = join(root, 'packages/group/app/src/leaf.ts')
    expect([...graph.importedBy.get(leaf) ?? []].sort()).toEqual([
      join(root, 'packages/group/app/src/core.ts'),
      join(root, 'packages/group/app/tests/second.spec.ts'),
    ])
  })
})

describe('reverse closure', () => {
  it('collects the changed file and every transitive importer', () => {
    const root = workspace()
    const graph = buildImportGraph(discoverSuites(root, SUITE_PATTERNS), resolverFor(root))
    const helper = join(root, 'packages/group/unmapped/src/helper.ts')
    const closure = reverseClosure(graph.importedBy, [helper])
    expect(closure).toContain(helper)
    expect(closure).toContain(join(root, 'packages/group/unmapped/src/index.ts'))
    expect(closure).toContain(join(root, 'packages/group/app/src/core.ts'))
    expect(closure).toContain(join(root, 'packages/group/app/tests/core.spec.ts'))
    expect(closure).not.toContain(join(root, 'packages/group/app/tests/unrelated.spec.ts'))
  })

  it('returns only the changed file when nothing imports it', () => {
    expect([...reverseClosure(new Map(), ['/a/orphan.ts'])]).toEqual(['/a/orphan.ts'])
  })

  it('terminates on an import cycle', () => {
    const importedBy = new Map([['/a.ts', new Set(['/b.ts'])], ['/b.ts', new Set(['/a.ts'])]])
    expect([...reverseClosure(importedBy, ['/a.ts'])].sort()).toEqual(['/a.ts', '/b.ts'])
  })
})

describe('git status parsing', () => {
  it('reads modified, staged, untracked, renamed, and quoted entries', () => {
    expect(parseGitStatus([
      ' M packages/group/app/src/core.ts',
      'A  packages/group/app/src/added.ts',
      '?? packages/group/app/src/new.ts',
      'R  packages/group/app/src/old.ts -> packages/group/app/src/new-name.ts',
      '?? "packages/group/app/src/quoted name.ts"',
      '',
      'M',
    ].join('\n'))).toEqual([
      'packages/group/app/src/core.ts',
      'packages/group/app/src/added.ts',
      'packages/group/app/src/new.ts',
      'packages/group/app/src/new-name.ts',
      'packages/group/app/src/quoted name.ts',
    ])
  })

  it('reads a clean tree as an empty change set', () => {
    expect(parseGitStatus('')).toEqual([])
  })
})

describe('impact selection', () => {
  it('selects only the suites reaching a changed source, and skips the rest', () => {
    const root = workspace()
    const analysis = analyze(root, ['packages/group/app/src/core.ts'])
    expect(analysis.selectedSuites).toEqual(['packages/group/app/tests/core.spec.ts'])
    expect(analysis.discoveredCount).toBe(3)
    expect(analysis.skippedCount).toBe(2)
  })

  it('follows the graph across a workspace package boundary', () => {
    const root = workspace()
    expect(analyze(root, ['packages/group/unmapped/src/helper.ts']).selectedSuites)
      .toEqual(['packages/group/app/tests/core.spec.ts'])
    expect(analyze(root, ['packages/group/built/src/index.ts']).selectedSuites)
      .toEqual(['packages/group/app/tests/core.spec.ts'])
    expect(analyze(root, ['packages/group/mapped/src/index.ts']).selectedSuites)
      .toEqual(['packages/group/app/tests/core.spec.ts'])
  })

  it('selects a changed suite itself', () => {
    const root = workspace()
    const analysis = analyze(root, ['packages/group/app/tests/standalone.spec.ts'])
    expect(analysis.selectedSuites).toEqual(['packages/group/app/tests/standalone.spec.ts'])
    expect(analysis.skippedCount).toBe(2)
  })

  it('selects nothing for a change outside the graph, in the same tree that selects a source', () => {
    const root = workspace()
    // The positive half proves the fixture and the path normalization work, so
    // the negative half below is an answer rather than a path-shape mismatch.
    expect(analyze(root, ['packages/group/app/src/core.ts']).selectedSuites).toHaveLength(1)
    const analysis = analyze(root, ['sample/notes.md'])
    expect(analysis.selectedSuites).toEqual([])
    expect(analysis.discoveredCount).toBe(3)
    expect(analysis.skippedCount).toBe(3)
  })

  it('selects nothing for a source no suite imports', () => {
    const root = workspace()
    writeFixtureFile(root, 'packages/group/app/src/island.ts', 'export const island = 0\n')
    expect(analyze(root, ['packages/group/app/src/island.ts']).selectedSuites).toEqual([])
  })

  it('selects nothing for an empty change set without building the graph', () => {
    const root = workspace()
    // A broken tsconfig would throw from loadCompilerOptions; reaching the
    // empty answer proves the analysis short-circuits before the graph walk.
    writeFixtureFile(root, 'tsconfig.json', '{ not json')
    const analysis = analyze(root, [])
    expect(analysis.selectedSuites).toEqual([])
    expect(analysis.discoveredCount).toBe(3)
    expect(analysis.skippedCount).toBe(3)
  })

  it('accepts absolute changed paths as well as repo-relative ones', () => {
    const root = workspace()
    expect(analyze(root, [join(root, 'packages/group/app/src/core.ts')]).selectedSuites)
      .toEqual(['packages/group/app/tests/core.spec.ts'])
  })
})
