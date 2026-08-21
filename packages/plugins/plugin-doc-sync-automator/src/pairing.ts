/**
 * Bilingual-pairing primitives that interoperate with the repository's
 * translation-pairing gate (`scripts/verify-translation-pairing.ts`, backed
 * by `scripts/translation-pairing.ts` and `scripts/translation-pairing-record.ts`;
 * convention documented at `docs/i18n/README.md`). `scripts/` sits outside
 * every workspace package's `rootDir` and is run directly by `tsx`, not
 * built or published as a library, so no package imports it (repo-wide
 * search confirms zero consumers under `packages/`) and this package cannot
 * either without breaking `tsc -b`'s composite declaration emit. This module
 * therefore ports the pairing convention BY VALUE instead of reinventing it:
 * the same `.md` → `.zh.md` / `.i18n.yaml` path rule, the same git-blob hash
 * algorithm, and the same consistency-record text, so a record this module
 * writes is byte-for-byte what `translationPairingRecord`'s renderer would
 * produce and validates clean under `pnpm run verify-translation-pairing`.
 *
 * Full structural pairing (heading depths, code blocks, tables, lists, and
 * link targets, in order) is `scripts/translation-pairing.ts`'s
 * `translationStructureDiff`, built on an `mdast`/`gfm` parse. Depending on
 * that parser here would add dependencies outside this package's declared
 * workspace-trio budget (`dsh-invariants` / `dsh-tools` / `@deepseek-ai/cordis`), so this
 * module re-derives only the heading axis — the axis a section splice can
 * disturb — from plain-text ATX heading scanning, as a self-test of the
 * splice. It is not a substitute for the full corpus gate; callers still run
 * `pnpm run verify-translation-pairing` for the complete check.
 * @module @deepseek-ai/dsh-plugin-doc-sync-automator/pairing
 */

import { createHash } from 'node:crypto'
import { basename, isAbsolute, normalize } from 'node:path'

/**
 * The three repository-relative paths that form one bilingual pair. Same
 * shape as `scripts/translation-pairing-record.ts`'s `TranslationPairPaths`.
 */
export interface BilingualPairPaths {
  /** English document path. */
  source: string
  /** Simplified Chinese mirror path. */
  zh: string
  /** Consistency-record sidecar path. */
  meta: string
}

/**
 * Derive a pair's mirror and sidecar paths from its English source. Mirrors
 * `scripts/translation-pairing-record.ts#translationPairPaths`'s rule.
 * @param source - Repository-relative English Markdown path.
 * @returns The complete three-path pair.
 * @throws Error when `source` does not end in `.md`, ends in `.zh.md`, or is
 *   absolute or escapes the repository root — the derived paths are written to,
 *   so a traversal path must be refused before any resolve.
 */
export function derivePairPaths(source: string): BilingualPairPaths {
  if (!source.endsWith('.md') || source.endsWith('.zh.md')) {
    throw new Error(`sync_bilingual_pair: expected an English Markdown path, received ${JSON.stringify(source)}`)
  }
  if (isAbsolute(source) || normalize(source).split(/[\\/]/).includes('..')) {
    throw new Error(`sync_bilingual_pair: refusing ${JSON.stringify(source)} — the path must be repository-relative and cannot escape the repository root`)
  }
  return {
    source,
    zh: source.replace(/\.md$/, '.zh.md'),
    meta: source.replace(/\.md$/, '.i18n.yaml'),
  }
}

/**
 * Git blob hash of file content (what `git hash-object` prints). Identical
 * algorithm to `scripts/translation-pairing.ts#blobHash`, so a record this
 * module writes matches what the pairing gate recomputes from the worktree.
 * @param content - Exact bytes (or UTF-8 text) of the file.
 * @returns The 40-hex-digit SHA-1 blob hash.
 */
export function gitBlobHash(content: Buffer | string): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const hash = createHash('sha1')
  hash.update(`blob ${bytes.byteLength}\0`)
  hash.update(bytes)
  return hash.digest('hex')
}

/**
 * Render the canonical `.i18n.yaml` consistency record. Byte-identical to
 * `scripts/translation-pairing-record.ts#renderTranslationPairingRecord`'s
 * output for the same inputs.
 * @param paths - Pair paths written into the record and its recovery command.
 * @param sourceHash - Confirmed git blob hash of the English side.
 * @param zhHash - Confirmed git blob hash of the Chinese side.
 * @returns Canonical YAML text with exactly one trailing newline.
 */
export function renderPairMeta(paths: BilingualPairPaths, sourceHash: string, zhHash: string): string {
  return [
    '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    `#   pnpm run verify-translation-pairing --write ${paths.source}`,
    `${basename(paths.source)}: ${sourceHash}`,
    `${basename(paths.zh)}: ${zhHash}`,
    '',
  ].join('\n')
}

/** One ATX heading found by `parseHeadings`. */
export interface DocumentHeading {
  /** Heading depth: `#` is 1, `######` is 6. */
  depth: number
  /** Trimmed heading text, without the leading `#`s. */
  text: string
  /** 0-based index of the heading's line in the document. */
  lineIndex: number
}

const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*$/
const FENCE_LINE = /^(`{3,}|~{3,})/

/**
 * Parse ATX heading lines (`#` through `######`) in document order, skipping
 * fenced code blocks so a `#` inside a code sample is never mistaken for a
 * heading — the one condition the repository's `mdast`-based structural
 * signature gets for free that a plain-text scan must reproduce explicitly.
 * @param content - Full Markdown document text.
 * @returns Headings in document order.
 */
export function parseHeadings(content: string): DocumentHeading[] {
  const lines = content.split('\n')
  const headings: DocumentHeading[] = []
  let fenceMarker = ''
  for (let index = 0; index < lines.length; index++) {
    /* v8 ignore next -- `index < lines.length` from `content.split('\n')` always yields a defined element. */
    const line = lines[index] ?? ''
    const fence = FENCE_LINE.exec(line)
    if (fence?.[1] !== undefined) {
      if (fenceMarker === '') fenceMarker = fence[1]
      else if (line.startsWith(fenceMarker)) fenceMarker = ''
      continue
    }
    if (fenceMarker !== '') continue
    const match = HEADING_LINE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      headings.push({ depth: match[1].length, text: match[2], lineIndex: index })
    }
  }
  return headings
}

/** One located section: its heading, position among all headings, and exact span. */
export interface DocumentSection {
  /** The section's own heading. */
  heading: DocumentHeading
  /** 0-based position of `heading` among every heading in the document, in order. */
  ordinal: number
  /**
   * Exact section text: the heading line through the line before the next
   * heading at `heading.depth` or shallower, or through end of document.
   */
  text: string
}

/**
 * Locate one section by its exact heading text.
 * @param content - Full Markdown document text.
 * @param headingText - Exact heading text to match (leading/trailing whitespace ignored).
 * @returns The located section, or `undefined` when no heading matches.
 */
export function findSection(content: string, headingText: string): DocumentSection | undefined {
  const headings = parseHeadings(content)
  const target = headingText.trim()
  const index = headings.findIndex(h => h.text === target)
  if (index === -1) return undefined
  const heading = headings[index]
  /* v8 ignore next -- findIndex >= 0 guarantees an element at that index. */
  if (heading === undefined) return undefined
  const lines = content.split('\n')
  const next = headings.slice(index + 1).find(h => h.depth <= heading.depth)
  const end = next !== undefined ? next.lineIndex : lines.length
  return { heading, ordinal: index, text: lines.slice(heading.lineIndex, end).join('\n') }
}

/**
 * Replace the section at heading position `ordinal` in a mirror document
 * with `replacement`, preserving every other line unchanged. The mirror's
 * heading order corresponds 1:1 with the source's (the pairing gate's own
 * invariant), so `ordinal` — the source section's position among ALL
 * headings — names the same logical section in the mirror even though the
 * heading text differs by language.
 * @param mirrorContent - Full mirror document text before the splice.
 * @param mirrorHeadings - `parseHeadings(mirrorContent)`, passed in so callers reuse one parse.
 * @param ordinal - 0-based heading position to replace.
 * @param replacement - Exact text to splice in, replacing the heading line through the section's end.
 * @returns The spliced document text.
 * @throws Error when the mirror has no heading at `ordinal` — a structural
 *   drift the pairing gate should catch before this tool ever runs, so this
 *   caller fails loud rather than guessing a splice point.
 */
export function spliceSection(
  mirrorContent: string,
  mirrorHeadings: readonly DocumentHeading[],
  ordinal: number,
  replacement: string,
): string {
  const heading = mirrorHeadings[ordinal]
  if (heading === undefined) {
    throw new Error(
      `sync_bilingual_pair: mirror has no heading at position ${ordinal + 1} to receive the spliced section `
      + `(${mirrorHeadings.length} heading(s) found) — the pair is structurally out of sync; `
      + 'resolve with pnpm run verify-translation-pairing before syncing',
    )
  }
  const lines = mirrorContent.split('\n')
  const next = mirrorHeadings.slice(ordinal + 1).find(h => h.depth <= heading.depth)
  const end = next !== undefined ? next.lineIndex : lines.length
  return [...lines.slice(0, heading.lineIndex), ...replacement.split('\n'), ...lines.slice(end)].join('\n')
}

const NEEDS_TRANSLATION_BEGIN = '<!-- NEEDS-TRANSLATION: begin (synced from the English source; the text below is untranslated English) -->'
const NEEDS_TRANSLATION_END = '<!-- NEEDS-TRANSLATION: end -->'

/**
 * Wrap spliced English section text in NEEDS-TRANSLATION markers. The
 * markers are plain HTML comments, distinct from
 * `scripts/translation-pairing.ts`'s `BEGIN GENERATED …` / `END GENERATED …`
 * grammar, so they are never mistaken for a generated region by the pairing
 * gate.
 * @param sectionText - Exact English section text (heading line included).
 * @returns The section wrapped between the begin/end markers.
 */
export function wrapNeedsTranslation(sectionText: string): string {
  return [NEEDS_TRANSLATION_BEGIN, sectionText, NEEDS_TRANSLATION_END].join('\n')
}

/**
 * Compare two documents' heading DEPTHS in order — the one structural axis a
 * section splice can disturb — as a self-test that a splice preserved the
 * pairing gate's per-heading correspondence. This mirrors the heading axis
 * of `scripts/translation-pairing.ts#translationStructureDiff`; it does not
 * replace that function's code/table/list/link checks (see module doc).
 * @param source - Headings of the English document.
 * @param zh - Headings of the Chinese mirror.
 * @returns A description of the first divergence, or `undefined` when every position matches.
 */
export function headingDepthDivergence(
  source: readonly DocumentHeading[],
  zh: readonly DocumentHeading[],
): string | undefined {
  const length = Math.max(source.length, zh.length)
  for (let index = 0; index < length; index++) {
    const a = source[index]?.depth
    const b = zh[index]?.depth
    if (a !== b) {
      return `heading #${index + 1} depth diverges after the splice: ${a ?? 'nothing'} vs ${b ?? 'nothing'}`
    }
  }
  return undefined
}
