/**
 * Word-count budget check that reuses `scripts/verify-doc-budgets.ts`'s
 * limits directly: the same `wc -w`-style counting function (ported by
 * value — see `pairing.ts`'s module doc for why `scripts/` cannot be
 * imported from a package), applied against the SAME manifest file
 * (`scripts/doc-budgets.manifest.json`) read at call time, so a ceiling
 * change made for the corpus-wide gate is honored here without drift.
 * @module @econym/dsh-plugin-doc-sync-automator/budgets
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * `wc -w` equivalent — identical to `scripts/verify-doc-budgets.ts#countWords`.
 * @param text - the text to count words in.
 * @returns the whitespace-delimited word count.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Result of checking one document against `doc-budgets.manifest.json`. */
export interface BudgetCheck {
  /** Whether this path carries a ceiling in the manifest at all. */
  budgeted: boolean
  /** Current `wc -w` word count; `0` when the file is unbudgeted or absent. */
  words: number
  /** The manifest's ceiling for this path, when budgeted. */
  ceiling?: number
  /** `true` for an unbudgeted path, or a budgeted path within its ceiling. */
  ok: boolean
}

/**
 * Check one repository-relative document against the budgets manifest's
 * ceiling for it, if any. A path absent from the manifest is not budgeted —
 * `doc-budgets.manifest.json` opts specific standing docs into the ceiling
 * gate; this plugin automates pairing propagation, not that opt-in list, so
 * an unbudgeted path (e.g. most package READMEs) reports `ok: true`.
 * @param root - Repository root the manifest and document path resolve against.
 * @param manifestPath - Repo-relative path to the budgets manifest.
 * @param docPath - Repo-relative document path to check.
 * @returns The budget state for `docPath`.
 */
export function checkDocBudget(root: string, manifestPath: string, docPath: string): BudgetCheck {
  const manifestAbs = resolve(root, manifestPath)
  if (!existsSync(manifestAbs)) return { budgeted: false, words: 0, ok: true }
  const manifest = JSON.parse(readFileSync(manifestAbs, 'utf8')) as Record<string, number>
  const ceiling = manifest[docPath]
  if (ceiling === undefined) return { budgeted: false, words: 0, ok: true }
  const docAbs = resolve(root, docPath)
  const words = existsSync(docAbs) ? countWords(readFileSync(docAbs, 'utf8')) : 0
  return { budgeted: true, words, ceiling, ok: words <= ceiling }
}
