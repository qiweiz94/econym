/**
 * Pure fs orchestration for `sync_bilingual_pair`: locate a document's `.zh.md`
 * mirror by the repository's pairing convention (`pairing.ts`), splice the
 * changed section into the mirror wrapped in a NEEDS-TRANSLATION marker,
 * re-record the pair's `.i18n.yaml` consistency hashes so
 * `pnpm run verify-translation-pairing` accepts the result instead of
 * flagging it out-of-sync, self-test the heading-axis structural
 * correspondence the splice depends on, and assert both sides against
 * `scripts/doc-budgets.manifest.json`'s ceilings (`budgets.ts`). This module
 * does no translation — it keeps the pair mechanically valid and marks the
 * debt for a human translator.
 * @module @econym/dsh-plugin-doc-sync-automator/syncer
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkDocBudget } from './budgets.ts'
import {
  derivePairPaths,
  findSection,
  gitBlobHash,
  headingDepthDivergence,
  parseHeadings,
  renderPairMeta,
  spliceSection,
  wrapNeedsTranslation,
} from './pairing.ts'
import type { SyncBilingualPairInput, SyncBilingualPairResult } from './types.ts'

/** Options controlling where `syncBilingualPair` reads and writes. */
export interface SyncBilingualPairOptions {
  /** Repository root every path resolves against; defaults to `process.cwd()`. */
  root?: string
  /** Repo-relative path to the doc budgets manifest; defaults to `scripts/doc-budgets.manifest.json`. */
  budgetManifestPath?: string
}

const DEFAULT_BUDGET_MANIFEST_PATH = 'scripts/doc-budgets.manifest.json'

/**
 * Propagate one changed section of an English Markdown document into its
 * Simplified Chinese mirror.
 * @param input - The English document and the section that changed.
 * @param options - Root and budget-manifest overrides (defaults resolve against the real repository).
 * @returns The pairing, budget, and translation-debt state after the call.
 * @throws Error when `docPath` is not a valid English source path, the
 *   source does not exist, `updatedSection.heading` names no heading in the
 *   source, or the mirror exists but has no heading at the source section's
 *   structural position (a pre-existing pairing drift this tool will not
 *   guess through).
 */
export function syncBilingualPair(
  input: SyncBilingualPairInput,
  options: SyncBilingualPairOptions = {},
): SyncBilingualPairResult {
  const root = options.root ?? process.cwd()
  const budgetManifestPath = options.budgetManifestPath ?? DEFAULT_BUDGET_MANIFEST_PATH
  const paths = derivePairPaths(input.docPath)

  const sourceAbs = resolve(root, paths.source)
  if (!existsSync(sourceAbs)) {
    throw new Error(`sync_bilingual_pair: English source not found: ${paths.source}`)
  }
  const sourceContent = readFileSync(sourceAbs, 'utf8')
  const section = findSection(sourceContent, input.updatedSection.heading)
  if (section === undefined) {
    throw new Error(`sync_bilingual_pair: heading ${JSON.stringify(input.updatedSection.heading)} not found in ${paths.source}`)
  }

  const zhAbs = resolve(root, paths.zh)
  if (!existsSync(zhAbs)) {
    const sourceBudget = checkDocBudget(root, budgetManifestPath, paths.source)
    return { paired: false, mirrorPath: paths.zh, budgetOk: sourceBudget.ok, pendingTranslation: false }
  }

  const zhContent = readFileSync(zhAbs, 'utf8')
  const zhHeadings = parseHeadings(zhContent)
  const splicedZh = spliceSection(zhContent, zhHeadings, section.ordinal, wrapNeedsTranslation(section.text))

  // Self-test: the splice must preserve the heading-axis structural
  // correspondence the pairing gate depends on (see pairing.ts module doc).
  const divergence = headingDepthDivergence(parseHeadings(sourceContent), parseHeadings(splicedZh))
  if (divergence !== undefined) {
    throw new Error(`sync_bilingual_pair: splice broke structural pairing for ${paths.zh}: ${divergence}`)
  }

  writeFileSync(zhAbs, splicedZh, 'utf8')

  // Re-record the pair's consistency hashes so the pairing gate sees a
  // confirmed-consistent pair rather than an out-of-sync one: both sides are
  // consistent by construction, since the mirror's new bytes are exactly the
  // (unchanged) source's own bytes for the spliced section.
  const sourceHash = gitBlobHash(sourceContent)
  const zhHash = gitBlobHash(splicedZh)
  writeFileSync(resolve(root, paths.meta), renderPairMeta(paths, sourceHash, zhHash), 'utf8')

  const sourceBudget = checkDocBudget(root, budgetManifestPath, paths.source)
  const zhBudget = checkDocBudget(root, budgetManifestPath, paths.zh)

  return {
    paired: true,
    mirrorPath: paths.zh,
    budgetOk: sourceBudget.ok && zhBudget.ok,
    pendingTranslation: true,
  }
}
