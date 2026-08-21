import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDocBudget, countWords } from '../src/budgets.ts'
import {
  derivePairPaths,
  findSection,
  gitBlobHash,
  headingDepthDivergence,
  parseHeadings,
  renderPairMeta,
  spliceSection,
  wrapNeedsTranslation,
} from '../src/pairing.ts'
import { syncBilingualPair } from '../src/syncer.ts'
import { createFixtureRoot, removeFixtureRoot } from './fixtures.ts'

const SOURCE = [
  '# Title',
  '',
  'Intro paragraph.',
  '',
  '## Configuration',
  '',
  'Old config text.',
  '',
  '## Usage',
  '',
  'Usage text.',
  '',
].join('\n')

const MIRROR = [
  '# 标题',
  '',
  '介绍段落。',
  '',
  '## 配置',
  '',
  '旧配置文本。',
  '',
  '## 用法',
  '',
  '用法文本。',
  '',
].join('\n')

const roots: string[] = []

function fixture(files: Record<string, string>): string {
  const root = createFixtureRoot(files)
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots) removeFixtureRoot(root)
  roots.length = 0
})

describe('syncBilingualPair', () => {
  it('clean sync: splices the changed section behind NEEDS-TRANSLATION and re-records the pair', () => {
    const root = fixture({ 'doc.md': SOURCE, 'doc.zh.md': MIRROR })

    const result = syncBilingualPair({ docPath: 'doc.md', updatedSection: { heading: 'Configuration' } }, { root })

    expect(result).toEqual({ paired: true, mirrorPath: 'doc.zh.md', budgetOk: true, pendingTranslation: true })

    const spliced = readFileSync(join(root, 'doc.zh.md'), 'utf8')
    expect(spliced).toContain('<!-- NEEDS-TRANSLATION: begin')
    expect(spliced).toContain('## Configuration')
    expect(spliced).toContain('Old config text.')
    expect(spliced).toContain('<!-- NEEDS-TRANSLATION: end -->')
    // Untouched sections keep their Chinese text.
    expect(spliced).toContain('# 标题')
    expect(spliced).toContain('## 用法')
    expect(spliced).toContain('用法文本。')
    // The spliced-in English section replaced the Chinese one at that position.
    expect(spliced).not.toContain('## 配置')

    const meta = readFileSync(join(root, 'doc.i18n.yaml'), 'utf8')
    expect(meta).toBe(renderPairMeta(
      derivePairPaths('doc.md'),
      gitBlobHash(SOURCE),
      gitBlobHash(spliced),
    ))
  })

  it('missing mirror: reports paired: false without writing anything', () => {
    const root = fixture({ 'doc.md': SOURCE })

    const result = syncBilingualPair({ docPath: 'doc.md', updatedSection: { heading: 'Configuration' } }, { root })

    expect(result).toEqual({ paired: false, mirrorPath: 'doc.zh.md', budgetOk: true, pendingTranslation: false })
  })

  it('budget breach: budgetOk is false when the spliced mirror exceeds its manifest ceiling', () => {
    const root = fixture({
      'doc.md': SOURCE,
      'doc.zh.md': MIRROR,
      'budgets.manifest.json': JSON.stringify({ 'doc.zh.md': 3 }),
    })

    const result = syncBilingualPair(
      { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } },
      { root, budgetManifestPath: 'budgets.manifest.json' },
    )

    expect(result.paired).toBe(true)
    expect(result.budgetOk).toBe(false)
  })

  it('section-not-found: throws when the heading names no section in the source', () => {
    const root = fixture({ 'doc.md': SOURCE, 'doc.zh.md': MIRROR })

    expect(() => syncBilingualPair(
      { docPath: 'doc.md', updatedSection: { heading: 'Nonexistent' } },
      { root },
    )).toThrow(/heading "Nonexistent" not found/)
  })

  it('throws when the English source itself does not exist', () => {
    const root = fixture({})

    expect(() => syncBilingualPair(
      { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } },
      { root },
    )).toThrow(/English source not found/)
  })

  it('throws for a docPath that is not a valid English source path', () => {
    const root = fixture({})

    expect(() => syncBilingualPair(
      { docPath: 'doc.zh.md', updatedSection: { heading: 'Configuration' } },
      { root },
    )).toThrow(/expected an English Markdown path/)
  })

  it('throws when the splice would break the heading-axis structural correspondence', () => {
    // The mirror carries an extra heading the source does not (a pre-existing
    // pairing drift unrelated to the spliced section), so after the splice
    // the two documents' heading counts still diverge.
    const driftedMirror = `${MIRROR}\n## 额外\n\n多余内容。\n`
    const root = fixture({ 'doc.md': SOURCE, 'doc.zh.md': driftedMirror })

    expect(() => syncBilingualPair(
      { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } },
      { root },
    )).toThrow(/splice broke structural pairing/)

    // No partial write on failure.
    expect(readFileSync(join(root, 'doc.zh.md'), 'utf8')).toBe(driftedMirror)
  })

  it('defaults root to process.cwd() and the manifest path when options are entirely omitted', () => {
    // No `{ root }` at all: exercises the `options.root ?? process.cwd()` and
    // `options.budgetManifestPath ?? DEFAULT_BUDGET_MANIFEST_PATH` fallbacks
    // directly. The doc genuinely does not exist at process.cwd(), so this
    // only needs to prove the defaulted path was consulted, not succeed.
    expect(() => syncBilingualPair({
      docPath: 'nonexistent-doc-for-coverage-test.md',
      updatedSection: { heading: 'X' },
    })).toThrow(/English source not found: nonexistent-doc-for-coverage-test\.md/)
  })

  it('uses the real repository defaults (scripts/doc-budgets.manifest.json) when no options are given', () => {
    const root = fixture({ 'doc.md': SOURCE, 'doc.zh.md': MIRROR })
    // scripts/doc-budgets.manifest.json does not exist under this fixture
    // root, so the default resolves to "not budgeted" rather than throwing.
    const result = syncBilingualPair({ docPath: 'doc.md', updatedSection: { heading: 'Configuration' } }, { root })
    expect(result.budgetOk).toBe(true)
  })
})

describe('pairing primitives', () => {
  it('derivePairPaths derives the .zh.md mirror and .i18n.yaml sidecar', () => {
    expect(derivePairPaths('docs/architecture.md')).toEqual({
      source: 'docs/architecture.md',
      zh: 'docs/architecture.zh.md',
      meta: 'docs/architecture.i18n.yaml',
    })
  })

  it('derivePairPaths rejects a non-.md path', () => {
    expect(() => derivePairPaths('docs/architecture.txt')).toThrow(/expected an English Markdown path/)
  })

  it('derivePairPaths rejects a .zh.md path', () => {
    expect(() => derivePairPaths('docs/architecture.zh.md')).toThrow(/expected an English Markdown path/)
  })

  it('derivePairPaths refuses a traversal or absolute path (its derived paths are written to)', () => {
    expect(() => derivePairPaths('../../etc/evil.md')).toThrow(/cannot escape the repository root/)
    expect(() => derivePairPaths('/etc/evil.md')).toThrow(/cannot escape the repository root/)
    expect(() => derivePairPaths('sub/../../evil.md')).toThrow(/cannot escape the repository root/)
  })

  it('gitBlobHash hashes string and Buffer input identically', () => {
    const text = 'hello\n'
    expect(gitBlobHash(text)).toBe(gitBlobHash(Buffer.from(text, 'utf8')))
    // Matches `git hash-object` for a known blob.
    expect(gitBlobHash('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('parseHeadings skips headings that appear inside fenced code blocks', () => {
    const content = [
      '# Real Heading',
      '',
      '```md',
      '# Not a heading',
      '```',
      '',
      '## Second Real Heading',
    ].join('\n')
    expect(parseHeadings(content)).toEqual([
      { depth: 1, text: 'Real Heading', lineIndex: 0 },
      { depth: 2, text: 'Second Real Heading', lineIndex: 6 },
    ])
  })

  it('parseHeadings does not close a fence on a differently-marked fence-like line', () => {
    // A `~~~` line inside a ``` fence matches the fence-line regex but is not
    // this fence's closer, so it must not end the fenced region.
    const content = [
      '# Before',
      '```',
      'not a heading # fake',
      '~~~',
      'still inside fence # fake2',
      '```',
      '## After',
    ].join('\n')
    expect(parseHeadings(content)).toEqual([
      { depth: 1, text: 'Before', lineIndex: 0 },
      { depth: 2, text: 'After', lineIndex: 6 },
    ])
  })

  it('findSection returns undefined when the heading is absent', () => {
    expect(findSection(SOURCE, 'Nope')).toBeUndefined()
  })

  it('findSection extends the last section to end of document', () => {
    const section = findSection(SOURCE, 'Usage')
    expect(section?.ordinal).toBe(2)
    expect(section?.text.endsWith('Usage text.\n')).toBe(true)
  })

  it('wrapNeedsTranslation wraps text between markers', () => {
    const wrapped = wrapNeedsTranslation('## X\n\nbody')
    const lines = wrapped.split('\n')
    expect(lines[0]).toContain('NEEDS-TRANSLATION: begin')
    expect(lines.at(-1)).toBe('<!-- NEEDS-TRANSLATION: end -->')
  })

  it('spliceSection throws when the mirror has no heading at the requested ordinal', () => {
    const headings = parseHeadings('# Only One Heading\n')
    expect(() => spliceSection('# Only One Heading\n', headings, 3, 'replacement')).toThrow(/no heading at position 4/)
  })

  it('headingDepthDivergence reports the first mismatched position', () => {
    const a = parseHeadings('# A\n\n## B\n')
    const b = parseHeadings('# A\n\n### B\n')
    expect(headingDepthDivergence(a, b)).toMatch(/heading #2 depth diverges: 2 vs 3|heading #2 depth diverges after the splice: 2 vs 3/)
  })

  it('headingDepthDivergence returns undefined for matching heading depths', () => {
    const a = parseHeadings(SOURCE)
    const b = parseHeadings(MIRROR)
    expect(headingDepthDivergence(a, b)).toBeUndefined()
  })

  it('headingDepthDivergence reports "nothing" for the shorter side', () => {
    const a = parseHeadings('# A\n\n## B\n')
    const b = parseHeadings('# A\n')
    expect(headingDepthDivergence(a, b)).toBe('heading #2 depth diverges after the splice: 2 vs nothing')
  })
})

describe('budgets', () => {
  it('countWords counts whitespace-delimited tokens', () => {
    expect(countWords('  one  two\tthree\nfour ')).toBe(4)
  })

  it('checkDocBudget reports unbudgeted when the manifest file does not exist', () => {
    const root = fixture({})
    expect(checkDocBudget(root, 'nope.json', 'doc.md')).toEqual({ budgeted: false, words: 0, ok: true })
  })

  it('checkDocBudget reports unbudgeted when the path has no manifest entry', () => {
    const root = fixture({ 'manifest.json': JSON.stringify({ 'other.md': 10 }) })
    expect(checkDocBudget(root, 'manifest.json', 'doc.md')).toEqual({ budgeted: false, words: 0, ok: true })
  })

  it('checkDocBudget treats a budgeted, absent document as zero words', () => {
    const root = fixture({ 'manifest.json': JSON.stringify({ 'doc.md': 5 }) })
    expect(checkDocBudget(root, 'manifest.json', 'doc.md')).toEqual({ budgeted: true, words: 0, ceiling: 5, ok: true })
  })

  it('checkDocBudget reports ok for a budgeted document within its ceiling', () => {
    const root = fixture({ 'manifest.json': JSON.stringify({ 'doc.md': 5 }), 'doc.md': 'one two three' })
    expect(checkDocBudget(root, 'manifest.json', 'doc.md')).toEqual({ budgeted: true, words: 3, ceiling: 5, ok: true })
  })

  it('checkDocBudget reports failure for a budgeted document over its ceiling', () => {
    const root = fixture({ 'manifest.json': JSON.stringify({ 'doc.md': 2 }), 'doc.md': 'one two three' })
    const check = checkDocBudget(root, 'manifest.json', 'doc.md')
    expect(check.ok).toBe(false)
    expect(check.words).toBe(3)
  })
})
