import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolResult } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as tool from '../src/index.ts'
import type { DiagnosticCheckResult } from '../src/types.ts'
import { createFixtureProject, removeFixtureProject } from './fixture-project.ts'

const testToolSignal = new AbortController().signal
const projects: string[] = []

/** Narrow the registry's untyped result value to the diagnostic contract. */
function diagnosticValue(result: { value: unknown }): DiagnosticCheckResult {
  return result.value as DiagnosticCheckResult
}

afterEach(() => {
  for (const project of projects) removeFixtureProject(project)
  projects.length = 0
})

function fixture(files: Record<string, string> = {}): string {
  const root = createFixtureProject(files)
  projects.push(root)
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

function callCheck(ctx: Context, args: unknown): ReturnType<typeof ctx.tools.execute> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`diagnostic-${Math.random().toString(16).slice(2)}`),
    name: 'run_diagnostic_check',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Write an executable shell shim: real content plus `set -e`-safe fixed behavior. */
function writeShim(root: string, name: string, script: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('plugin-diagnostic-sifter', () => {
  it('registers a model-facing `run_diagnostic_check` tool exposing command + targetPath', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const schema = ctx.tools.schemas().find(s => s.name === 'run_diagnostic_check')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['command', 'targetPath'])
    await ctx.fiber.dispose()
  })

  it('runs a clean typecheck and reports success with zero root causes', async () => {
    const root = fixture({ 'src/ok.ts': 'export const ok = 1\n' })
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected typecheck success')
    const value = diagnosticValue(result)
    expect(value.success).toBe(true)
    expect(value.parseFailure).toBe(false)
    expect(value.rootCauses).toEqual([])
    expect(text(result)).toContain('typecheck clean: exit 0, no diagnostics')
    await ctx.fiber.dispose()
  }, 30_000)

  it('runs a failing typecheck, suppresses the downstream cascade, and parses a specific root cause', async () => {
    const root = fixture({
      'src/upstream.ts': "export const goodName: number = 'nope'\n",
      'src/consumer.ts': "import { goodNam } from './upstream'\nconsole.log(goodNam)\n",
    })
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected typecheck to complete (not tool-error) on a failing build')
    const value = diagnosticValue(result)
    expect(value.success).toBe(false)
    expect(value.parseFailure).toBe(false)
    expect(value.suppressedCascadeCount).toBe(1)
    expect(value.rootCauses).toHaveLength(1)
    expect(value.rootCauses[0]?.file).toBe('src/upstream.ts')
    expect(value.rootCauses[0]?.line).toBe(1)
    expect(value.rootCauses[0]?.code).toBe('TS2322')
    expect(value.rootCauses[0]?.message).toContain('not assignable')
    expect(text(result)).toContain('1 root cause')
    expect(text(result)).toContain('1 cascade error suppressed')
    expect(text(result)).toContain('src/upstream.ts:1 [TS2322]')
    await ctx.fiber.dispose()
  }, 30_000)

  it('reports a config-level tsc error with no file location', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root, tscArgs: [join(root, 'node_modules/.bin/tsc'), '-b', '--pretty', 'false', 'nonexistent-project'] })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected typecheck to complete on a config-level error')
    const value = diagnosticValue(result)
    expect(value.parseFailure).toBe(false)
    expect(value.rootCauses).toHaveLength(1)
    expect(value.rootCauses[0]?.file).toBe('')
    expect(value.rootCauses[0]?.line).toBe(0)
    expect(text(result)).toContain('(project)')
    await ctx.fiber.dispose()
  }, 30_000)

  it('runs a clean test check', async () => {
    const root = fixture({
      'src/math.ts': 'export function add(a: number, b: number): number { return a + b }\n',
      'src/math.test.ts': [
        "import { describe, expect, it } from 'vitest'",
        "import { add } from './math.ts'",
        "describe('add', () => { it('adds', () => { expect(add(2, 3)).toBe(5) }) })",
        '',
      ].join('\n'),
    })
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'test' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected test success')
    const value = diagnosticValue(result)
    expect(value.success).toBe(true)
    expect(value.parseFailure).toBe(false)
    expect(value.rootCauses).toEqual([])
    await ctx.fiber.dispose()
  }, 30_000)

  it('runs a failing test check and reports the assertion diff as a root cause', async () => {
    const root = fixture({
      'src/math.ts': 'export function add(a: number, b: number): number { return a + b }\n',
      'src/math.test.ts': [
        "import { describe, expect, it } from 'vitest'",
        "import { add } from './math.ts'",
        "describe('add', () => { it('is wrong on purpose', () => { expect(add(2, 2)).toBe(5) }) })",
        '',
      ].join('\n'),
    })
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'test' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected test run to complete (not tool-error) on a failing assertion')
    const value = diagnosticValue(result)
    expect(value.success).toBe(false)
    expect(value.parseFailure).toBe(false)
    expect(value.rootCauses).toHaveLength(1)
    expect(value.rootCauses[0]?.file).toBe('src/math.test.ts')
    expect(value.rootCauses[0]?.message).toContain('is wrong on purpose')
    expect(value.rootCauses[0]?.message).toContain('- Expected')
    await ctx.fiber.dispose()
  }, 30_000)

  it('scopes a test run to targetPath', async () => {
    const root = fixture({
      'src/a.test.ts': "import { expect, it } from 'vitest'\nit('a passes', () => { expect(1).toBe(1) })\n",
      'src/b.test.ts': "import { expect, it } from 'vitest'\nit('b fails', () => { expect(1).toBe(2) })\n",
    })
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'test', targetPath: 'src/a.test.ts' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the scoped run to complete')
    const value = diagnosticValue(result)
    expect(value.success).toBe(true)
    await ctx.fiber.dispose()
  }, 30_000)

  it('scopes a typecheck to targetPath', async () => {
    const root = fixture({ 'src/ok.ts': 'export const ok = 1\n' })
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'typecheck', targetPath: '.' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the scoped typecheck to complete')
    expect(diagnosticValue(result).success).toBe(true)
    await ctx.fiber.dispose()
  }, 30_000)

  it('rejects an empty or option-injecting targetPath before spawning', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const empty = await callCheck(ctx, { command: 'typecheck', targetPath: '' })
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('invalid targetPath')
    const injected = await callCheck(ctx, { command: 'typecheck', targetPath: '--outDir=/tmp/evil' })
    expect(injected.isError).toBe(true)
    expect(text(injected)).toContain('invalid targetPath')
    await ctx.fiber.dispose()
  })

  it('rejects an unrecognized command at the schema before spawning', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const result = await callCheck(ctx, { command: 'lint' })
    expect(result.isError).toBe(true)
    await ctx.fiber.dispose()
  })

  it('fails loud when the configured binary does not exist (spawn failure)', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root, tscArgs: [join(root, 'does-not-exist-binary')] })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('ENOENT')
    await ctx.fiber.dispose()
  })

  it('reports a timeout as a killed process with the partial output still explained', async () => {
    const root = fixture()
    const slow = writeShim(root, 'slow-tsc.sh', 'sleep 5\nexit 0')
    const ctx = await setup({ cwd: root, tscArgs: [slow], timeoutMs: 200 })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the timed-out run to complete as a tool result')
    const value = diagnosticValue(result)
    expect(value.exitCode).toBeNull()
    expect(value.signal).not.toBeNull()
    expect(text(result)).toContain('killed by signal')
    await ctx.fiber.dispose()
  }, 15_000)

  it('reports a failing exit with no parseable diagnostics as a parse failure carrying the raw output', async () => {
    const root = fixture()
    const garbage = writeShim(root, 'garbage-tsc.sh', "echo 'a completely unrelated crash banner'\nexit 2")
    const ctx = await setup({ cwd: root, tscArgs: [garbage] })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the garbage run to complete as a tool result')
    const value = diagnosticValue(result)
    expect(value.parseFailure).toBe(true)
    expect(value.raw?.text).toContain('unrelated crash banner')
    expect(text(result)).toContain('parse failure — do not read this as a clean run')
    await ctx.fiber.dispose()
  })

  it('marks the raw output truncated in a parse failure when it exceeds the envelope', async () => {
    const root = fixture()
    // Both streams individually fit the 20-byte-per-stream capture envelope,
    // but their COMBINED text (stdout + '\n' + stderr) exceeds it again, so
    // the parse-failure path's own `retainRaw(combined, envelope)` truncates.
    const garbage = writeShim(root, 'garbage-tsc.sh', "echo 'unrelated stdout banner text'\necho 'unrelated stderr banner text' >&2\nexit 2")
    const ctx = await setup({ cwd: root, tscArgs: [garbage], maxOutputBytes: 20 })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the garbage run to complete as a tool result')
    const value = diagnosticValue(result)
    expect(value.parseFailure).toBe(true)
    expect(value.raw?.truncated).toBe(true)
    expect(text(result)).toContain('[raw output truncated by the output envelope]')
    await ctx.fiber.dispose()
  })

  it('reports a failing exit with EMPTY output as a parse failure, not a silent clean run', async () => {
    const root = fixture()
    const silent = writeShim(root, 'silent-tsc.sh', 'exit 2')
    const ctx = await setup({ cwd: root, tscArgs: [silent] })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the silent-failure run to complete as a tool result')
    const value = diagnosticValue(result)
    expect(value.success).toBe(false)
    expect(value.parseFailure).toBe(true)
    await ctx.fiber.dispose()
  })

  it('truncates root causes under a tiny output envelope WITHOUT misreporting a parse failure', async () => {
    const root = fixture({
      'src/upstream.ts': "export const goodName: number = 'nope'\n",
      'src/consumer.ts': "import { goodNam } from './upstream'\nconsole.log(goodNam)\n",
    })
    const ctx = await setup({ cwd: root, maxOutputBytes: 45 })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the tiny-envelope run to complete as a tool result')
    const value = diagnosticValue(result)
    // A tiny envelope MUST NOT be conflated with an unrecognized/unparseable run.
    expect(value.parseFailure).toBe(false)
    expect(value.truncated).toBe(true)
    await ctx.fiber.dispose()
  }, 30_000)

  it('pluralizes root causes and suppressed cascades, and reports a singular merged duplicate', async () => {
    const root = fixture()
    const scripted = writeShim(root, 'scripted-tsc.sh', [
      'cat <<\'DIAG\'',
      'src/root.ts(1,1): error TS2322: err root.',
      'src/other.ts(2,2): error TS2345: err other.',
      'src/a.ts(3,3): error TS2307: Cannot find module \'./root\' or its corresponding type declarations.',
      'src/b.ts(4,4): error TS2307: Cannot find module \'./root\' or its corresponding type declarations.',
      'src/root.ts(1,1): error TS2322: err root.',
      'DIAG',
      'exit 1',
    ].join('\n'))
    const ctx = await setup({ cwd: root, tscArgs: [scripted] })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the scripted run to complete as a tool result')
    const value = diagnosticValue(result)
    expect(value.parseFailure).toBe(false)
    expect(value.rootCauses).toHaveLength(2)
    expect(value.suppressedCascadeCount).toBe(2)
    expect(value.deduplicatedCount).toBe(1)
    expect(text(result)).toContain('2 root causes')
    expect(text(result)).toContain('2 cascade errors suppressed')
    expect(text(result)).toContain('1 duplicate merged')
    await ctx.fiber.dispose()
  })

  it('pluralizes a merged-duplicate count above one', async () => {
    const root = fixture()
    const scripted = writeShim(root, 'scripted-tsc.sh', [
      'cat <<\'DIAG\'',
      'src/root.ts(1,1): error TS2322: err root.',
      'src/other.ts(2,2): error TS2345: err other.',
      'src/root.ts(1,1): error TS2322: err root.',
      'src/other.ts(2,2): error TS2345: err other.',
      'DIAG',
      'exit 1',
    ].join('\n'))
    const ctx = await setup({ cwd: root, tscArgs: [scripted] })
    const result = await callCheck(ctx, { command: 'typecheck' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the scripted run to complete as a tool result')
    const value = diagnosticValue(result)
    expect(value.deduplicatedCount).toBe(2)
    expect(text(result)).toContain('2 duplicates merged')
    await ctx.fiber.dispose()
  })

  it('throws at apply when tscArgs is an empty array', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    expect(() => { tool.apply(ctx, { tscArgs: [] }) }).toThrow(/tscArgs must name an executable/)
    await ctx.fiber.dispose()
  })

  it('applies documented defaults when apply runs without loader-filled config', async () => {
    const root = fixture({
      'src/ok.ts': 'export const ok = 1\n',
      'src/ok.test.ts': "import { expect, it } from 'vitest'\nit('passes', () => { expect(1).toBe(1) })\n",
    })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const previousCwd = process.cwd()
    process.chdir(root)
    try {
      tool.apply(ctx, {})
      const typecheck = await callCheck(ctx, { command: 'typecheck' })
      expect(typecheck.isError).toBe(false)
      if (typecheck.isError) throw new Error('expected the default-config typecheck run to complete')
      expect(diagnosticValue(typecheck).success).toBe(true)
      // Also exercises the `vitestBin` default (`node_modules/.bin/vitest`),
      // reached only when apply runs without the loader's schema defaults.
      const test = await callCheck(ctx, { command: 'test' })
      expect(test.isError).toBe(false)
      if (test.isError) throw new Error('expected the default-config test run to complete')
      expect(diagnosticValue(test).success).toBe(true)
    } finally {
      process.chdir(previousCwd)
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const root = fixture()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(tool, { cwd: root })
    expect(ctx.tools.schemas().some(s => s.name === 'run_diagnostic_check')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'run_diagnostic_check')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('plugin-diagnostic-sifter')
    expect(tool.inject).toEqual(['tools', 'subprocess'])
  })
})

describe('run_diagnostic_check presentation', () => {
  it('presents the call as a generic execute card, with the target location when scoped', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const def = ctx.tools.get('run_diagnostic_check')!
    expect(def.presentCall?.({ command: 'typecheck' })).toEqual({
      card: 'generic',
      title: 'Diagnose typecheck',
      kind: 'execute',
    })
    expect(def.presentCall?.({ command: 'test', targetPath: 'src/a.test.ts' })).toEqual({
      card: 'generic',
      title: 'Diagnose test src/a.test.ts',
      kind: 'execute',
      locations: [{ path: 'src/a.test.ts' }],
    })
    await ctx.fiber.dispose()
  })

  it('presents a replayed clean result', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const def = ctx.tools.get('run_diagnostic_check')!
    const clean: ToolResult = {
      content: [],
      isError: false,
      meta: { command: 'typecheck', success: true, parseFailure: false, rootCauseCount: 0, top: [] },
    }
    expect(def.presentResult?.({ command: 'typecheck' }, clean)).toEqual({ card: 'generic', title: 'typecheck: clean' })
    await ctx.fiber.dispose()
  })

  it('presents a replayed result with root causes, including the top locations', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const def = ctx.tools.get('run_diagnostic_check')!
    const failing: ToolResult = {
      content: [],
      isError: false,
      meta: { command: 'typecheck', success: false, parseFailure: false, rootCauseCount: 2, top: ['a.ts:1', 'b.ts:2'] },
    }
    expect(def.presentResult?.({ command: 'typecheck' }, failing)).toEqual({
      card: 'generic',
      title: 'typecheck: 2 root causes',
      content: [{ type: 'text', text: 'a.ts:1\nb.ts:2' }],
    })
    await ctx.fiber.dispose()
  })

  it('presents a replayed result with a single (singular) root cause', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const def = ctx.tools.get('run_diagnostic_check')!
    const failing: ToolResult = {
      content: [],
      isError: false,
      meta: { command: 'typecheck', success: false, parseFailure: false, rootCauseCount: 1, top: ['a.ts:1'] },
    }
    expect(def.presentResult?.({ command: 'typecheck' }, failing)).toEqual({
      card: 'generic',
      title: 'typecheck: 1 root cause',
      content: [{ type: 'text', text: 'a.ts:1' }],
    })
    await ctx.fiber.dispose()
  })

  it('presents a replayed parse-failure result', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const def = ctx.tools.get('run_diagnostic_check')!
    const failure: ToolResult = {
      content: [],
      isError: false,
      meta: { command: 'test', success: false, parseFailure: true, rootCauseCount: 0, top: [] },
    }
    expect(def.presentResult?.({ command: 'test' }, failure)).toEqual({ card: 'generic', title: 'test: parse failure' })
    await ctx.fiber.dispose()
  })

  it('falls back to the generic presentation for malformed replayed meta', async () => {
    const root = fixture()
    const ctx = await setup({ cwd: root })
    const def = ctx.tools.get('run_diagnostic_check')!
    for (const meta of [undefined, null, 'nope', { command: 'typecheck' }, { command: 1, success: true, parseFailure: false, rootCauseCount: 0, top: [] }, { command: 'typecheck', success: true, parseFailure: false, rootCauseCount: 0, top: [1] }]) {
      expect(def.presentResult?.({ command: 'typecheck' }, { content: [], isError: false, meta: meta as never })).toBeUndefined()
    }
    await ctx.fiber.dispose()
  })
})
