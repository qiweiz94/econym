/**
 * Pure unit tests for the sifting heuristics: real captured `tsc`/`vitest`
 * output for the parsing regexes (module fixtures under `tests/fixtures/`),
 * synthetic strings only for boundary branches a real capture cannot reliably
 * reproduce (dedupe, an unrecognized cascade target, byte-budget edges).
 *
 * Fixture provenance (`.txt` files can't carry JSDoc, so it lives here): each
 * was captured from a throwaway project by running this repository's own
 * `node_modules/.bin/tsc --pretty false -p tsconfig.json` (TypeScript 6.0.3)
 * or `node_modules/.bin/vitest run` (vitest 4.1.8) with `NO_COLOR=1` and
 * piped to a file (never a TTY), matching {@link runCheck}'s spawn contract
 * in `../src/spawn.ts`. `tsc-failing.txt` covers one project: `upstream.ts`
 * breaks (TS2322), `consumer.ts` imports its broken export (TS2724 cascade of
 * `upstream.ts`), `missing.ts` imports a module that does not exist (TS2307,
 * independent — not a cascade), and `elab.ts` fails with a multi-line
 * elaborated TS2345. `tsc-elaborated.txt` re-captures just `elab.ts` in
 * isolation. `tsc-global-error.txt` points `tsc -b` at a nonexistent project.
 * `vitest-failing.txt` is one failed assertion under a `describe`;
 * `vitest-multi-failing.txt` adds a no-suite failure resolved through a
 * helper function (`assertFive` in `helper.ts`) and a thrown (non-assertion)
 * failure. `vitest-clean.txt`/`tsc-clean.txt` are passing runs.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  boundRootCauses,
  CASCADE_CODES,
  retainRaw,
  siftTest,
  siftTypecheck,
} from '../src/sifter.ts'
import type { DiagnosticRootCause } from '../src/types.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Read one captured fixture file's exact bytes as text. */
function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

describe('siftTypecheck: real captured tsc output', () => {
  it('recognizes an empty (clean) run with no diagnostics', () => {
    const report = siftTypecheck(fixture('tsc-clean.txt'))
    expect(report).toEqual({ recognized: true, rootCauses: [], suppressedCascadeCount: 0, deduplicatedCount: 0 })
  })

  it('suppresses a TS2724 cascade that targets a file with its own retained diagnostic, keeps an independent TS2307 for a genuinely missing module, and merges multi-line elaboration into one root cause', () => {
    const report = siftTypecheck(fixture('tsc-failing.txt'))
    expect(report.recognized).toBe(true)
    expect(report.suppressedCascadeCount).toBe(1)
    expect(report.deduplicatedCount).toBe(0)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      {
        file: 'src/elab.ts',
        line: 4,
        code: 'TS2345',
        message: [
          "Argument of type '{ alpha: { beta: string; }; gamma: number; }' is not assignable to parameter of type 'Wide'.",
          "  The types of 'alpha.beta' are incompatible between these types.",
          "    Type 'string' is not assignable to type 'number'.",
        ].join('\n'),
      },
      {
        file: 'src/missing.ts',
        line: 1,
        code: 'TS2307',
        message: "Cannot find module './does-not-exist' or its corresponding type declarations.",
      },
      {
        file: 'src/upstream.ts',
        line: 1,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ])
    // The suppressed diagnostic is consumer.ts's TS2724, not counted among the roots.
    expect(report.rootCauses.some(cause => cause.file === 'src/consumer.ts')).toBe(false)
  })

  it('keeps an isolated multi-line elaboration as one root cause outside a cascade run', () => {
    const report = siftTypecheck(fixture('tsc-elaborated.txt'))
    expect(report.recognized).toBe(true)
    expect(report.suppressedCascadeCount).toBe(0)
    expect(report.rootCauses).toHaveLength(1)
    expect(report.rootCauses[0]?.message.split('\n')).toHaveLength(3)
  })

  it('parses a config-level (file-less) diagnostic via TSC_GLOBAL', () => {
    const report = siftTypecheck(fixture('tsc-global-error.txt'))
    expect(report.recognized).toBe(true)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: '', line: 0, code: 'TS5058', message: "The specified path does not exist: './tsconfig-nope.json'." },
    ])
  })
})

describe('siftTypecheck: synthetic boundary branches', () => {
  it('merges exact-duplicate diagnostic lines and counts them', () => {
    const dupe = 'src/a.ts(1,1): error TS2322: same.\nsrc/a.ts(1,1): error TS2322: same.\n'
    const report = siftTypecheck(dupe)
    expect(report.rootCauses).toHaveLength(1)
    expect(report.deduplicatedCount).toBe(1)
  })

  it('resets the current diagnostic on an unindented non-diagnostic line, so it does not swallow trailing summary text', () => {
    const withSummary = 'src/a.ts(1,1): error TS2322: broke.\nFound 1 error.\n'
    const report = siftTypecheck(withSummary)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: 'src/a.ts', line: 1, code: 'TS2322', message: 'broke.' },
    ])
  })

  it('suppresses ALL diagnostics when every one is a matched cascade of the same retained root, leaving no root causes but a positive suppressed count', () => {
    const allCascade = [
      'src/root.ts(1,1): error TS2322: broke.',
      'src/a.ts(1,1): error TS2307: Cannot find module \'./root\' or its corresponding type declarations.',
      'src/b.ts(1,1): error TS2307: Cannot find module \'./root\' or its corresponding type declarations.',
    ].join('\n')
    const report = siftTypecheck(allCascade)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: 'src/root.ts', line: 1, code: 'TS2322', message: 'broke.' },
    ])
    expect(report.suppressedCascadeCount).toBe(2)
  })

  it('collapses every echo of a genuinely missing module (no file of its own to retain a diagnostic) down to its first occurrence as the one root cause (bug #64)', () => {
    const missingCascade = [
      'src/a.ts(1,1): error TS2307: Cannot find module \'./ghost\' or its corresponding type declarations.',
      'src/b.ts(2,3): error TS2307: Cannot find module \'./ghost\' or its corresponding type declarations.',
      'src/c.ts(3,4): error TS2307: Cannot find module \'./ghost\' or its corresponding type declarations.',
    ].join('\n')
    const report = siftTypecheck(missingCascade)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      {
        file: 'src/a.ts',
        line: 1,
        code: 'TS2307',
        message: "Cannot find module './ghost' or its corresponding type declarations.",
      },
    ])
    expect(report.suppressedCascadeCount).toBe(2)
    expect(report.deduplicatedCount).toBe(0)
  })

  it('keeps a single genuinely-missing-module TS2307 as one root cause, never suppressing it to zero (known-healthy)', () => {
    const singleMissing =
      'src/only.ts(5,6): error TS2307: Cannot find module \'./ghost\' or its corresponding type declarations.\n'
    const report = siftTypecheck(singleMissing)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      {
        file: 'src/only.ts',
        line: 5,
        code: 'TS2307',
        message: "Cannot find module './ghost' or its corresponding type declarations.",
      },
    ])
    expect(report.suppressedCascadeCount).toBe(0)
  })

  it('keeps a TS2307/TS2724 diagnostic whose message names no recognizable module specifier', () => {
    const unparseable = 'src/root.ts(1,1): error TS2322: broke.\nsrc/a.ts(1,1): error TS2307: something odd happened.\n'
    const report = siftTypecheck(unparseable)
    expect(report.rootCauses.some(cause => cause.code === 'TS2307')).toBe(true)
    expect(report.suppressedCascadeCount).toBe(0)
  })

  it('does not recognize output with no parseable diagnostic and no blank clean run', () => {
    expect(siftTypecheck('some unrelated tool banner\nwith no diagnostic lines\n').recognized).toBe(false)
  })

  it('exposes the cascade code set as the documented TS2307/TS2724 pair', () => {
    expect(CASCADE_CODES).toEqual(new Set(['TS2307', 'TS2724']))
  })
})

describe('siftTest: real captured vitest output', () => {
  it('recognizes a clean (all-passing) run with no failed-test blocks', () => {
    const report = siftTest(fixture('vitest-clean.txt'))
    expect(report).toEqual({ recognized: true, rootCauses: [], suppressedCascadeCount: 0, deduplicatedCount: 0 })
  })

  it('sifts one failed assertion into a root cause carrying the label, message, and expected/received diff, dropping code-frame and passing-test noise', () => {
    const report = siftTest(fixture('vitest-failing.txt'))
    expect(report.recognized).toBe(true)
    expect(report.deduplicatedCount).toBe(0)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      {
        file: 'src/math.test.ts',
        line: 9,
        message: [
          'add > fails on purpose: AssertionError: expected 4 to be 5 // Object.is equality',
          '- Expected',
          '+ Received',
          '',
          '- 5',
          '+ 4',
        ].join('\n'),
      },
    ])
  })

  it('sifts three failed tests: a suite header, a no-suite header, and a helper-frame failure that resolves to the spec-file call site, plus a thrown error with no diff', () => {
    const report = siftTest(fixture('vitest-multi-failing.txt'))
    expect(report.recognized).toBe(true)
    expect(report.rootCauses).toHaveLength(3)

    const [suite, noSuite, thrown] = report.rootCauses
    expect(suite).toEqual({
      file: 'src/math.test.ts',
      line: 10,
      message: [
        'add > fails on purpose: AssertionError: expected 4 to be 5 // Object.is equality',
        '- Expected',
        '+ Received',
        '',
        '- 5',
        '+ 4',
      ].join('\n'),
    })
    // The assertion actually threw inside helper.ts, but the spec-file frame
    // (the call site) is preferred over the deeper helper frame.
    expect(noSuite).toEqual({
      file: 'src/math.test.ts',
      line: 15,
      message: [
        'fails via a helper with no suite: AssertionError: expected 2 to be 5 // Object.is equality',
        '- Expected',
        '+ Received',
        '',
        '- 5',
        '+ 2',
      ].join('\n'),
    })
    // A thrown (non-assertion) failure carries its message with no diff.
    expect(thrown).toEqual({
      file: 'src/math.test.ts',
      line: 19,
      message: 'throws instead of asserting: Error: boom: unexpected state',
    })
  })
})

describe('siftTest: synthetic boundary branches', () => {
  it('does not recognize output with no Test Files summary at all', () => {
    expect(siftTest('not vitest output\njust noise\n').recognized).toBe(false)
  })

  it('does not recognize a failing summary count with zero parsed failure blocks', () => {
    const unexplained = [
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n')
    expect(siftTest(unexplained).recognized).toBe(false)
  })

  it('merges exact-duplicate failed-test blocks and counts them', () => {
    const block = [
      ' FAIL  src/a.test.ts > dup',
      'boom',
      '',
      ' ❯ src/a.test.ts:1:1',
      '',
    ].join('\n')
    const doubled = `${block}\n${block}\n Test Files  1 failed (1)\n      Tests  2 failed (2)\n`
    const report = siftTest(doubled)
    expect(report.rootCauses).toHaveLength(1)
    expect(report.deduplicatedCount).toBe(1)
  })

  it('falls back to the deepest frame overall when no frame names the spec file', () => {
    const noSpecFrame = [
      ' FAIL  src/a.test.ts > only-helper-frame',
      'boom',
      ' ❯ src/helper.ts:7:1',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n')
    const report = siftTest(noSpecFrame)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: 'src/helper.ts', line: 7, message: 'only-helper-frame: boom' },
    ])
  })

  it('reports line 0 and the header file when a failure block carries no frame at all', () => {
    const noFrame = [
      ' FAIL  src/a.test.ts > no-frame',
      'boom, no stack captured',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n')
    const report = siftTest(noFrame)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: 'src/a.test.ts', line: 0, message: 'no-frame: boom, no stack captured' },
    ])
  })

  it('falls back to the literal "failed" message when a block has no plain message line', () => {
    const noMessage = [
      ' FAIL  src/a.test.ts > silent',
      ' ❯ src/a.test.ts:2:1',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n')
    const report = siftTest(noMessage)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: 'src/a.test.ts', line: 2, message: 'silent: failed' },
    ])
  })

  it('labels a header with no suite or test-name separator using the bare header text as the test path', () => {
    const bareHeader = [
      ' FAIL  standalone-failure',
      'boom',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n')
    const report = siftTest(bareHeader)
    expect(report.rootCauses).toEqual<DiagnosticRootCause[]>([
      { file: 'standalone-failure', line: 0, message: 'boom' },
    ])
  })
})

describe('boundRootCauses', () => {
  const cause = (file: string, line: number, message: string): DiagnosticRootCause => ({ file, line, message })

  it('includes the diagnostic code in the serialized prefix budget when present', () => {
    const causes: DiagnosticRootCause[] = [{ file: 'a.ts', line: 1, code: 'TS2322', message: 'x'.repeat(50) }]
    const result = boundRootCauses(causes, 30)
    expect(result.truncated).toBe(true)
    expect(result.rootCauses[0]?.code).toBe('TS2322')
  })

  it('keeps every cause and reports untruncated when the whole list fits', () => {
    const causes = [cause('a.ts', 1, 'short')]
    const result = boundRootCauses(causes, 1_000)
    expect(result).toEqual({ rootCauses: causes, truncated: false })
  })

  it('keeps a cause whose serialized form fits EXACTLY at the byte cap', () => {
    const causes = [cause('a.ts', 1, 'x')]
    const exact = Buffer.byteLength('a.ts:1 x', 'utf8') + 1
    const result = boundRootCauses(causes, exact)
    expect(result).toEqual({ rootCauses: causes, truncated: false })
  })

  it('drops everything and reports truncated when even the first prefix does not fit', () => {
    const causes = [cause('a.ts', 1, 'x'), cause('b.ts', 2, 'y')]
    const result = boundRootCauses(causes, 1)
    expect(result).toEqual({ rootCauses: [], truncated: true })
  })

  it('head-retains one oversized cause at the remaining budget and drops the rest', () => {
    const causes = [cause('a.ts', 1, 'x'.repeat(200)), cause('b.ts', 2, 'kept-out')]
    const result = boundRootCauses(causes, 20)
    expect(result.truncated).toBe(true)
    expect(result.rootCauses).toHaveLength(1)
    expect(result.rootCauses[0]?.file).toBe('a.ts')
    expect(result.rootCauses[0]?.message.length).toBeLessThan(200)
    expect(Buffer.byteLength(result.rootCauses[0]?.message ?? '', 'utf8')).toBeLessThanOrEqual(20)
  })

  it('cuts a multibyte message on a UTF-8 boundary rather than splitting a code point', () => {
    // Each '€' is 3 UTF-8 bytes; a byte cap that lands mid-character must back off.
    const causes = [cause('a.ts', 1, '€€€€€€€€€€')]
    const result = boundRootCauses(causes, 12)
    expect(result.truncated).toBe(true)
    const message = result.rootCauses[0]?.message ?? ''
    const bytes = Buffer.byteLength(message, 'utf8')
    expect(bytes % 3).toBe(0)
    expect(Buffer.from(message, 'utf8').toString('utf8')).toBe(message)
  })

  it('drops subsequent causes when the exact remainder after a kept cause is zero', () => {
    const exactFirst = Buffer.byteLength('a.ts:1 x', 'utf8') + 1
    const causes = [cause('a.ts', 1, 'x'), cause('b.ts', 2, 'y')]
    const result = boundRootCauses(causes, exactFirst)
    expect(result.rootCauses).toEqual([causes[0]])
    expect(result.truncated).toBe(true)
  })

  it('renders a file-less cause as "(project)" in its serialized prefix budget', () => {
    const causes = [cause('', 0, 'x'.repeat(50))]
    const result = boundRootCauses(causes, 15)
    expect(result.truncated).toBe(true)
    expect(result.rootCauses[0]?.file).toBe('')
  })
})

describe('retainRaw', () => {
  it('retains short text untruncated', () => {
    expect(retainRaw('hello', 1_000)).toEqual({ text: 'hello', truncated: false })
  })

  it('head-retains and marks truncated when the text exceeds the cap', () => {
    const result = retainRaw('x'.repeat(100), 10)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(10)
  })
})
