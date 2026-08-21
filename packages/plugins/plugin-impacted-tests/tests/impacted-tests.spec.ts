import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as tool from '../src/index.ts'
import { canonicalPath } from '../src/analyzer.ts'
import type { ImpactedTestsResult } from '../src/types.ts'
import { createWorkspace, removeWorkspace, writeFixtureFile } from './workspace-fixture.ts'

const testToolSignal = new AbortController().signal
const roots: string[] = []

/**
 * The stubbed runner seam: `echo` prints the argv it receives, so the recorded
 * stdout IS the suite list the tool would have handed a real runner. No test
 * runner is ever spawned by these suites.
 */
const RECORDING_RUNNER = ['echo', 'ran'] as const

/** Narrow a successful execution's untyped result value to the tool's contract. */
function impactValue(result: ToolExecutionResult): ImpactedTestsResult {
  if (result.isError) throw new Error(`expected a selection, got an error result: ${text(result)}`)
  return result.value as unknown as ImpactedTestsResult
}

/** A fixture workspace registered for teardown. */
function workspace(): string {
  const root = createWorkspace()
  roots.push(root)
  return canonicalPath(root)
}

/** A fixture workspace that is also a git repository with one commit. */
function gitWorkspace(): string {
  const root = workspace()
  for (const args of [
    ['init'],
    ['config', 'user.email', 'impacted-test@example.com'],
    ['config', 'user.name', 'Impacted Test'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  return root
}

async function setup(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

function call(ctx: Context, args: unknown, name = 'run_impacted_tests'): ReturnType<typeof ctx.tools.execute> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`impacted-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Config shared by the fixture-driven cases. */
function fixtureConfig(root: string, overrides: tool.Config = {}): tool.Config {
  return Object.assign({
    cwd: root,
    tsconfigPath: 'tsconfig.json',
    testPatterns: ['packages/*/*/tests/**/*.spec.ts'],
    runnerCommand: [...RECORDING_RUNNER],
  }, overrides)
}

afterEach(() => {
  for (const root of roots) removeWorkspace(root)
  roots.length = 0
})

describe('plugin-impacted-tests', () => {
  it('registers a model-facing tool taking an optional file list', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root))
    const schema = ctx.tools.schemas().find(definition => definition.name === 'run_impacted_tests')
    expect(schema).toBeDefined()
    expect(schema?.parameters).toMatchObject({ properties: { files: { type: 'array' } } })
    expect(schema?.parameters).not.toHaveProperty('required')
  })

  it('honours a configured tool name', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { toolName: 'impacted' }))
    expect(ctx.tools.schemas().map(definition => definition.name)).toContain('impacted')
  })

  it('runs strictly the suites that import the changed file', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root))
    const result = await call(ctx, { files: ['packages/group/app/src/core.ts'] })
    expect(result.isError).toBe(false)
    const value = impactValue(result)
    expect(value.selectedSuites).toEqual(['packages/group/app/tests/core.spec.ts'])
    expect(value.skippedCount).toBe(2)
    expect(value.results.executed).toBe(true)
    expect(value.results.exitCode).toBe(0)
    // The runner received exactly the selected suites, and nothing else.
    expect(value.results.stdout.text.trim()).toBe('ran packages/group/app/tests/core.spec.ts')
    expect(text(result)).toContain('all selected suites passed')
  })

  it('runs nothing when a changed file is imported by no suite', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root))
    // The positive case above shares this fixture, so an empty selection here
    // is the analyzer's answer rather than a path-shape mismatch.
    const result = await call(ctx, { files: ['sample/notes.md'] })
    const value = impactValue(result)
    expect(value.selectedSuites).toEqual([])
    expect(value.skippedCount).toBe(3)
    expect(value.results.executed).toBe(false)
    expect(value.results.exitCode).toBeNull()
    expect(value.results.signal).toBeNull()
    // The runner never ran, so it recorded nothing.
    expect(value.results.stdout.text).toBe('')
    expect(text(result)).toContain('no test suite imports them')
  })

  it('runs nothing when there are no uncommitted changes', async () => {
    const root = gitWorkspace()
    const ctx = await setup(fixtureConfig(root))
    const value = impactValue(await call(ctx, {}))
    expect(value.changedFiles).toEqual([])
    expect(value.selectedSuites).toEqual([])
    expect(value.results.executed).toBe(false)
    expect(value.results.stdout.text).toBe('')
  })

  it('defaults the change set to the working tree and selects from it', async () => {
    const root = gitWorkspace()
    writeFixtureFile(root, 'packages/group/app/src/core.ts', "import { leaf } from './leaf.ts'\nexport const core = leaf\n")
    const ctx = await setup(fixtureConfig(root))
    const value = impactValue(await call(ctx, {}))
    expect(value.changedFiles).toEqual(['packages/group/app/src/core.ts'])
    expect(value.selectedSuites).toEqual(['packages/group/app/tests/core.spec.ts'])
    expect(value.results.executed).toBe(true)
  })

  it('selects a changed suite itself', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root))
    const value = impactValue(await call(ctx, { files: ['packages/group/app/tests/standalone.spec.ts'] }))
    expect(value.selectedSuites).toEqual(['packages/group/app/tests/standalone.spec.ts'])
    expect(value.results.stdout.text.trim()).toBe('ran packages/group/app/tests/standalone.spec.ts')
  })

  it('reports a failing runner without masking its output', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'echo boom >&2; exit 3'] }))
    const result = await call(ctx, { files: ['packages/group/app/src/core.ts'] })
    const value = impactValue(result)
    expect(value.results.exitCode).toBe(3)
    expect(value.results.stderr.text.trim()).toBe('boom')
    expect(text(result)).toContain('the runner exited 3')
  })

  it('reports several selected suites and one skipped suite in the plural and singular', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root))
    const result = await call(ctx, {
      files: ['packages/group/app/src/core.ts', 'packages/group/app/src/unrelated.ts'],
    })
    const value = impactValue(result)
    expect(value.selectedSuites).toEqual([
      'packages/group/app/tests/core.spec.ts',
      'packages/group/app/tests/unrelated.spec.ts',
    ])
    expect(value.skippedCount).toBe(1)
    expect(text(result)).toContain('2 changed files select 2 suites (1 skipped)')
  })

  it('names the skipped suite in the singular when nothing is selected', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { testPatterns: ['packages/*/*/tests/**/core.spec.ts'] }))
    const result = await call(ctx, { files: ['sample/notes.md'] })
    expect(impactValue(result).skippedCount).toBe(1)
    expect(text(result)).toContain('1 changed file; no test suite imports them — 1 suite skipped')
  })

  it('reports a runner killed by a signal', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'kill -TERM $$'] }))
    const result = await call(ctx, { files: ['packages/group/app/src/core.ts'] })
    const value = impactValue(result)
    expect(value.results.exitCode).toBeNull()
    expect(value.results.signal).toBe('SIGTERM')
    expect(text(result)).toContain('killed by signal SIGTERM')
  })

  it('marks truncated runner stderr in the rendered text', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'echo boom >&2'], maxOutputBytes: 2 }))
    const result = await call(ctx, { files: ['packages/group/app/src/core.ts'] })
    expect(impactValue(result).results.stderr.truncated).toBe(true)
    expect(text(result)).toContain('[stderr truncated to the tail by the output envelope]')
  })

  it('stops a runner that outlives the configured timeout', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'sleep 30'], timeoutMs: 1 }))
    const value = impactValue(await call(ctx, { files: ['packages/group/app/src/core.ts'] }))
    expect(value.results.executed).toBe(true)
    expect(value.results.exitCode).toBeNull()
    expect(value.results.signal).not.toBeNull()
  }, 30_000)

  it('fails loud when the working tree is not a git repository', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { gitBinary: 'git' }))
    const result = await call(ctx, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('git status --porcelain failed')
  })

  it('refuses a selection larger than the configured suite bound', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root, { maxSuites: 1 }))
    const result = await call(ctx, {
      files: ['packages/group/app/src/core.ts', 'packages/group/app/src/unrelated.ts'],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeding the 1-suite limit')
  })

  it('retains the tail of runner output at a tiny envelope and keeps an exact fit whole', async () => {
    const root = workspace()
    const tiny = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'echo abcdefgh'], maxOutputBytes: 3 }))
    const clipped = impactValue(await call(tiny, { files: ['packages/group/app/src/core.ts'] }))
    expect(clipped.results.stdout.truncated).toBe(true)
    expect(clipped.results.stdout.text).toBe('gh\n')

    // `echo abcdefgh` emits exactly 9 bytes; at the exact limit nothing drops.
    const exact = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'echo abcdefgh'], maxOutputBytes: 9 }))
    const whole = impactValue(await call(exact, { files: ['packages/group/app/src/core.ts'] }))
    expect(whole.results.stdout.truncated).toBe(false)
    expect(whole.results.stdout.text).toBe('abcdefgh\n')
  })

  it('retains whole code points when a multibyte character straddles the byte limit', async () => {
    const root = workspace()
    // `oké` is four bytes; a 3-byte tail budget drops the `o` and must keep
    // the two-byte `é` whole rather than emitting half of it.
    const ctx = await setup(fixtureConfig(root, { runnerCommand: ['sh', '-c', 'printf %s oké'], maxOutputBytes: 3 }))
    const result = await call(ctx, { files: ['packages/group/app/src/core.ts'] })
    const value = impactValue(result)
    expect(value.results.stdout.truncated).toBe(true)
    expect(value.results.stdout.text).toBe('ké')
    expect(text(result)).toContain('truncated to the tail')
  })

  it('applies every default when applied with no configuration', async () => {
    // Mounted through the schema every field is filled, so the shipped
    // defaults are only reachable by applying the plugin directly.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    tool.apply(ctx, {})
    expect(ctx.tools.schemas().map(definition => definition.name)).toContain('run_impacted_tests')
  })

  it('presents the call as a generic execute card in both argument forms', async () => {
    const root = workspace()
    const ctx = await setup(fixtureConfig(root))
    const definition = ctx.tools.get('run_impacted_tests')
    expect(definition?.presentCall?.({ files: ['a.ts', 'b.ts'] })).toEqual({
      card: 'generic',
      title: 'Run impacted tests',
      kind: 'execute',
      rawInput: 'a.ts b.ts',
    })
    expect(definition?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Run impacted tests',
      kind: 'execute',
      rawInput: 'uncommitted changes',
    })
  })

  it('removes the tool when the fiber is disposed', async () => {
    const root = workspace()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(tool, fixtureConfig(root))
    expect(ctx.tools.schemas().map(definition => definition.name)).toContain('run_impacted_tests')
    await fiber.dispose()
    expect(ctx.tools.schemas().map(definition => definition.name)).not.toContain('run_impacted_tests')
  })
})
