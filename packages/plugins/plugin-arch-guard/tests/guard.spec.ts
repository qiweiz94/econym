import { describe, expect, it } from 'vitest'
import { checkModuleBoundary, tierOf } from '../src/guard.ts'
import type { WorkspaceIndex, WorkspacePackage } from '../src/types.ts'

/** Build one fixture workspace package with sane defaults, overridable per test. */
function pkg(overrides: Pick<WorkspacePackage, 'name' | 'group' | 'dir'> & Partial<WorkspacePackage>): WorkspacePackage {
  return { exports: ['.'], dependsOn: [], ...overrides }
}

/** Build a fixture {@link WorkspaceIndex} from a package list, keyed by name. */
function workspace(...packages: WorkspacePackage[]): WorkspaceIndex {
  return { packages: new Map(packages.map(p => [p.name, p])) }
}

const CORDIS = pkg({
  name: '@deepseek-ai/cordis',
  group: 'vendor',
  dir: 'vendor/cordis',
  exports: ['.', './src/*', './package.json'],
})

const UTIL = pkg({
  name: '@deepseek-ai/dsh-util',
  group: 'util',
  dir: 'packages/util/util',
})

const INVARIANTS = pkg({
  name: '@deepseek-ai/dsh-invariants',
  group: 'runtime-diagnostics',
  dir: 'packages/runtime-diagnostics/invariants',
  exports: ['.', './invariant'],
  dependsOn: ['@deepseek-ai/cordis'],
})

const TOOLS = pkg({
  name: '@deepseek-ai/dsh-tools',
  group: 'core',
  dir: 'packages/core/tools',
  exports: ['.', './invariant', './src/*'],
  dependsOn: ['@deepseek-ai/dsh-invariants', '@deepseek-ai/cordis'],
})

const ARCH_GUARD = pkg({
  name: '@econym/dsh-plugin-arch-guard',
  group: 'plugins',
  dir: 'packages/plugins/plugin-arch-guard',
  exports: ['.', './invariant', './src/*'],
  dependsOn: ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-invariants', '@deepseek-ai/cordis'],
})

const AST_CONTEXT = pkg({
  name: '@econym/dsh-plugin-ast-context',
  group: 'plugins',
  dir: 'packages/plugins/plugin-ast-context',
  exports: ['.', './invariant', './src/*'],
  dependsOn: ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-invariants', '@deepseek-ai/cordis'],
})

const HOST = pkg({
  name: '@deepseek-ai/dsh-host',
  group: 'host',
  dir: 'packages/host/host',
})

const BASE_WORKSPACE = workspace(CORDIS, UTIL, INVARIANTS, TOOLS, ARCH_GUARD, AST_CONTEXT, HOST)

const GUARD_SOURCE = `${ARCH_GUARD.dir}/src/guard.ts`

describe('tierOf', () => {
  it('classifies vendor and util as foundation', () => {
    expect(tierOf('vendor')).toBe('foundation')
    expect(tierOf('util')).toBe('foundation')
  })

  it('classifies plugins, host, and client as surface', () => {
    expect(tierOf('plugins')).toBe('surface')
    expect(tierOf('host')).toBe('surface')
    expect(tierOf('client')).toBe('surface')
  })

  it('classifies everything else as capability', () => {
    expect(tierOf('core')).toBe('capability')
    expect(tierOf('runtime-diagnostics')).toBe('capability')
  })
})

describe('checkModuleBoundary: source resolution', () => {
  it('rejects a sourcePath outside every known package directory', () => {
    const result = checkModuleBoundary({ sourcePath: 'scripts/gen-tool-catalog.ts', targetImport: '@deepseek-ai/dsh-tools' }, BASE_WORKSPACE)
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('unknown-source-package')
    expect((result as { suggestion?: string }).suggestion).toContain('workspace package directory')
  })
})

describe('checkModuleBoundary: relative imports', () => {
  it('allows a relative import that stays inside the source package', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: './workspace-index.ts' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'same-package-relative-import' })
  })

  it('allows a relative import that resolves exactly to the package root', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '..' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'same-package-relative-import' })
  })

  it('collapses redundant path segments (literal "." and empty segments) while resolving', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: './/./workspace-index.ts' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'same-package-relative-import' })
  })

  it('rejects a relative import that escapes the source package directory', () => {
    const result = checkModuleBoundary(
      { sourcePath: GUARD_SOURCE, targetImport: '../../plugin-ast-context/src/extractor.ts' },
      BASE_WORKSPACE,
    )
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('relative-import-escapes-package')
    expect((result as { suggestion?: string }).suggestion).toContain('package name')
  })

  it('rejects a relative import that escapes the repository entirely (more ".." segments than the path has depth)', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '../../../../../outside.ts' }, BASE_WORKSPACE)
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('relative-import-escapes-package')
  })
})

describe('checkModuleBoundary: source resolution picks the longest matching package directory', () => {
  it('prefers a more deeply nested package dir encountered after a shallower match', () => {
    const outer = pkg({ name: '@deepseek-ai/dsh-outer', group: 'core', dir: 'packages/core/outer', exports: ['.'] })
    const inner = pkg({ name: '@deepseek-ai/dsh-inner', group: 'core', dir: 'packages/core/outer/inner', exports: ['.'] })
    const ws = workspace(outer, inner) // outer visited first
    const result = checkModuleBoundary({ sourcePath: 'packages/core/outer/inner/src/index.ts', targetImport: inner.name }, ws)
    expect(result).toEqual({ allowed: true, rule: 'self-package-import' })
  })

  it('keeps the already-longer match when a shallower package dir is encountered after it', () => {
    const outer = pkg({ name: '@deepseek-ai/dsh-outer2', group: 'core', dir: 'packages/core/outer2', exports: ['.'] })
    const inner = pkg({ name: '@deepseek-ai/dsh-inner2', group: 'core', dir: 'packages/core/outer2/inner', exports: ['.'] })
    const ws = workspace(inner, outer) // inner visited first this time
    const result = checkModuleBoundary({ sourcePath: 'packages/core/outer2/inner/src/index.ts', targetImport: inner.name }, ws)
    expect(result).toEqual({ allowed: true, rule: 'self-package-import' })
  })
})

describe('checkModuleBoundary: external dependencies', () => {
  it('allows a non-scoped external package unconditionally', () => {
    expect(checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: 'zod' }, BASE_WORKSPACE))
      .toEqual({ allowed: true, rule: 'external-dependency' })
  })

  it('allows a scoped external package outside the @deepseek-ai scope', () => {
    expect(checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@modelcontextprotocol/sdk' }, BASE_WORKSPACE))
      .toEqual({ allowed: true, rule: 'external-dependency' })
  })

  it('allows a node: builtin', () => {
    expect(checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: 'node:fs' }, BASE_WORKSPACE))
      .toEqual({ allowed: true, rule: 'external-dependency' })
  })
})

describe('checkModuleBoundary: unresolved workspace packages', () => {
  it('treats an @deepseek-ai package absent from the workspace index as external', () => {
    // Standalone semantics: the workspace index owns membership; a package
    // not scanned from packages/ or vendor/ (e.g. a registry @deepseek-ai/*
    // harness dependency) is external, not a workspace error.
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@deepseek-ai/dsh-does-not-exist' }, BASE_WORKSPACE)
    expect(result.allowed).toBe(true)
    expect(result.rule).toBe('external-dependency')
  })
})

describe('checkModuleBoundary: self-import', () => {
  it('allows a package importing its own subpath by name', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@econym/dsh-plugin-arch-guard/invariant' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'self-package-import' })
  })
})

describe('checkModuleBoundary: tier direction (layer violations)', () => {
  it('rejects a capability-tier package importing a surface-tier plugin', () => {
    const result = checkModuleBoundary(
      { sourcePath: `${TOOLS.dir}/src/index.ts`, targetImport: '@econym/dsh-plugin-arch-guard' },
      BASE_WORKSPACE,
    )
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('layer-violation')
    expect((result as { suggestion?: string }).suggestion).toContain('core (capability) may not depend on plugins (surface)')
  })

  it('rejects a capability-tier package importing the web (host) surface', () => {
    const result = checkModuleBoundary({ sourcePath: `${TOOLS.dir}/src/index.ts`, targetImport: '@deepseek-ai/dsh-host' }, BASE_WORKSPACE)
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('layer-violation')
  })

  it('rejects a foundation-tier vendor package importing a capability-tier package', () => {
    const cordisSelfDependingOnTools = workspace(
      pkg({ ...CORDIS, dependsOn: [] }),
      TOOLS,
      INVARIANTS,
    )
    const result = checkModuleBoundary(
      { sourcePath: `${CORDIS.dir}/src/index.ts`, targetImport: '@deepseek-ai/dsh-tools' },
      cordisSelfDependingOnTools,
    )
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('layer-violation')
    expect((result as { suggestion?: string }).suggestion).toContain('vendor (foundation) may not depend on core (capability)')
  })

  it('allows a surface-tier plugin importing a capability-tier package', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@deepseek-ai/dsh-tools' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })

  it('allows a capability-tier package importing a foundation-tier package', () => {
    const result = checkModuleBoundary({ sourcePath: `${TOOLS.dir}/src/index.ts`, targetImport: '@deepseek-ai/cordis' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })
})

describe('checkModuleBoundary: plugins-do-not-import-siblings', () => {
  it('rejects a plugin importing an undeclared sibling plugin', () => {
    const result = checkModuleBoundary(
      { sourcePath: GUARD_SOURCE, targetImport: '@econym/dsh-plugin-ast-context' },
      BASE_WORKSPACE,
    )
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('plugins-forbidden-sibling-import')
    expect((result as { suggestion?: string }).suggestion).toContain('does not declare')
  })

  it('allows a plugin importing a sibling plugin it declares as a dependency', () => {
    const guardDeclaringSibling = pkg({ ...ARCH_GUARD, dependsOn: [...ARCH_GUARD.dependsOn, AST_CONTEXT.name] })
    const ws = workspace(CORDIS, TOOLS, INVARIANTS, guardDeclaringSibling, AST_CONTEXT)
    const result = checkModuleBoundary(
      { sourcePath: GUARD_SOURCE, targetImport: '@econym/dsh-plugin-ast-context' },
      ws,
    )
    expect(result).toEqual({ allowed: true, rule: 'plugins-declared-sibling-import' })
  })
})

describe('checkModuleBoundary: circular-workspace dependency', () => {
  it('rejects an import that would create a direct cycle', () => {
    const a = pkg({ name: '@deepseek-ai/dsh-a', group: 'core', dir: 'packages/core/a', dependsOn: ['@deepseek-ai/dsh-b'] })
    const b = pkg({ name: '@deepseek-ai/dsh-b', group: 'core', dir: 'packages/core/b' })
    const ws = workspace(a, b)
    const result = checkModuleBoundary({ sourcePath: `${b.dir}/src/index.ts`, targetImport: a.name }, ws)
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('circular-workspace-dependency')
    expect((result as { suggestion?: string }).suggestion).toContain('cycle')
  })

  it('does not re-flag a dependency already visited when a second branch pushes it again before its first visit', () => {
    // T -> A -> [C, D]; D -> C. D is popped (LIFO) before C, and C is still only
    // PUSHED (not yet visited) when D re-lists it, so C is pushed a second time —
    // exercising the already-visited skip on C's second pop.
    const t = pkg({ name: '@deepseek-ai/dsh-dup-t', group: 'core', dir: 'packages/core/dup-t', dependsOn: ['@deepseek-ai/dsh-dup-a'] })
    const a = pkg({ name: '@deepseek-ai/dsh-dup-a', group: 'core', dir: 'packages/core/dup-a', dependsOn: ['@deepseek-ai/dsh-dup-c', '@deepseek-ai/dsh-dup-d'] })
    const c = pkg({ name: '@deepseek-ai/dsh-dup-c', group: 'core', dir: 'packages/core/dup-c' })
    const d = pkg({ name: '@deepseek-ai/dsh-dup-d', group: 'core', dir: 'packages/core/dup-d', dependsOn: ['@deepseek-ai/dsh-dup-c'] })
    const s = pkg({ name: '@deepseek-ai/dsh-dup-s', group: 'core', dir: 'packages/core/dup-s' })
    const ws = workspace(t, a, c, d, s)
    const result = checkModuleBoundary({ sourcePath: `${s.dir}/src/index.ts`, targetImport: t.name }, ws)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })

  it('skips a declared dependency name absent from the workspace index without crashing the walk', () => {
    const ghost = pkg({ name: '@deepseek-ai/dsh-ghost-t', group: 'core', dir: 'packages/core/ghost-t', dependsOn: ['@deepseek-ai/dsh-does-not-exist-either'] })
    const s = pkg({ name: '@deepseek-ai/dsh-ghost-s', group: 'core', dir: 'packages/core/ghost-s' })
    const ws = workspace(ghost, s)
    const result = checkModuleBoundary({ sourcePath: `${s.dir}/src/index.ts`, targetImport: ghost.name }, ws)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })

  it('does not flag a diamond-shaped (non-circular) dependency graph as circular', () => {
    // T depends on A and B; A also depends on B — B is reached twice while
    // walking from T, exercising the already-seen skip on the second visit.
    const t = pkg({ name: '@deepseek-ai/dsh-t', group: 'core', dir: 'packages/core/t', dependsOn: ['@deepseek-ai/dsh-a2', '@deepseek-ai/dsh-b2'] })
    const a2 = pkg({ name: '@deepseek-ai/dsh-a2', group: 'core', dir: 'packages/core/a2', dependsOn: ['@deepseek-ai/dsh-b2'] })
    const b2 = pkg({ name: '@deepseek-ai/dsh-b2', group: 'core', dir: 'packages/core/b2' })
    const c = pkg({ name: '@deepseek-ai/dsh-c', group: 'core', dir: 'packages/core/c' })
    const ws = workspace(t, a2, b2, c)
    const result = checkModuleBoundary({ sourcePath: `${c.dir}/src/index.ts`, targetImport: t.name }, ws)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })
})

describe('checkModuleBoundary: exports map validity', () => {
  it('rejects a subpath the target package does not export', () => {
    const result = checkModuleBoundary(
      { sourcePath: GUARD_SOURCE, targetImport: '@deepseek-ai/dsh-tools/internal/registry' },
      BASE_WORKSPACE,
    )
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('non-exported-subpath')
    expect((result as { suggestion?: string }).suggestion).toContain('does not export ./internal/registry')
  })

  it('allows a subpath matched by an exact exports key', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@deepseek-ai/dsh-tools/invariant' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })

  it('allows a subpath matched by a wildcard exports key', () => {
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@deepseek-ai/dsh-tools/src/schema.ts' }, BASE_WORKSPACE)
    expect(result).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })

  it('rejects a wildcard subpath with no remainder past the prefix and suffix', () => {
    const wildcardOnly = pkg({ name: '@deepseek-ai/dsh-wild', group: 'core', dir: 'packages/core/wild', exports: ['./src/*'] })
    const ws = workspace(ARCH_GUARD, wildcardOnly)
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: '@deepseek-ai/dsh-wild/src/' }, ws)
    expect(result.allowed).toBe(false)
    expect(result.rule).toBe('non-exported-subpath')
  })

  it('reports "(nothing)" when the target package exports nothing at all', () => {
    const noExports = pkg({ name: '@deepseek-ai/dsh-empty', group: 'core', dir: 'packages/core/empty', exports: [] })
    const ws = workspace(ARCH_GUARD, noExports)
    const result = checkModuleBoundary({ sourcePath: GUARD_SOURCE, targetImport: noExports.name }, ws)
    expect(result.suggestion).toContain('(nothing)')
  })
})
