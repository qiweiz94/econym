# @deepseek-ai/dsh-plugin-doc-sync-automator

English | [中文](README.zh.md)

The model-facing `sync_bilingual_pair` tool: splice a changed section of an English Markdown document into its paired `.zh.md` mirror behind a NEEDS-TRANSLATION marker, keeping the bilingual pair structurally valid and its `.i18n.yaml` consistency record current. This tool never machine-translates; it keeps the pair mechanically valid and flags the debt for a human translator.

## What it does

Registers one tool on `ctx.tools`:

- `sync_bilingual_pair(docPath, updatedSection)` locates `docPath`'s Simplified Chinese mirror by the repository's `.md` → `.zh.md` pairing convention (`docs/i18n/README.md`), finds the section named by `updatedSection.heading` in the English source, and splices that exact section into the mirror at the structurally corresponding heading position, wrapped in `<!-- NEEDS-TRANSLATION: begin -->` / `<!-- NEEDS-TRANSLATION: end -->` markers.

After a successful splice the pair's `.i18n.yaml` consistency record is rewritten with fresh git-blob hashes of both sides, so `pnpm run verify-translation-pairing` sees a confirmed-consistent pair rather than an out-of-sync one. Both sides' word counts are then checked against `scripts/doc-budgets.manifest.json`'s ceilings, for whichever of the two paths that manifest budgets.

## Pairing and validation machinery reused

`scripts/` is run directly by `tsx` and is not built or published as a workspace package — no package under `packages/` imports it, and doing so here would put a source file outside this package's `rootDir`, breaking `tsc -b`'s composite declaration emit. `src/pairing.ts` and `src/budgets.ts` therefore port the repository's own conventions BY VALUE instead of inventing a parallel one:

- **Path derivation** (`derivePairPaths`) is the same `.md` → `.zh.md` / `.i18n.yaml` rule as `scripts/translation-pairing-record.ts#translationPairPaths`.
- **The `.i18n.yaml` record** (`gitBlobHash`, `renderPairMeta`) uses the identical git-blob-hash algorithm and record text as `scripts/translation-pairing.ts#blobHash` / `scripts/translation-pairing-record.ts#renderTranslationPairingRecord`, so a record this tool writes is byte-for-byte what that renderer would produce and validates clean under `pnpm run verify-translation-pairing`.
- **Doc budgets** (`checkDocBudget`) reads `scripts/doc-budgets.manifest.json` directly and counts words with the identical `wc -w`-style function as `scripts/verify-doc-budgets.ts#countWords`, so a ceiling change made for the corpus-wide gate is honored here without drift.
- **Structural correspondence** (`headingDepthDivergence`) mirrors the heading axis of `scripts/translation-pairing.ts#translationStructureDiff` — the one axis a section splice can disturb — as a self-test after every splice. It intentionally does not replicate that function's code-block/table/list/link checks: those require an `mdast`/`gfm` parse, which would add dependencies outside this package's declared workspace-trio budget. `pnpm run verify-translation-pairing` remains the authority for the complete structural check.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`sync_bilingual_pair` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-doc-sync-automator): a required `docPath` string and a required `updatedSection` object carrying a `heading` string. Plugin config (repository root, budget-manifest path, tool name) is validated at load; it changes no schema field, only where the tool reads and writes.

#### Token effect

Fixed schema cost on every request where the tool is visible; the call result is a small, fixed-shape JSON object (`paired`, `mirrorPath`, `budgetOk`, `pendingTranslation`).

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the splice itself happens inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **No machine translation** — by design. The spliced content is the exact English text, wrapped in NEEDS-TRANSLATION markers; a human replaces it later.
- **Structural self-test covers headings only** — code blocks, tables, lists, and link targets are not re-checked after a splice (see "Pairing and validation machinery reused" above); run `pnpm run verify-translation-pairing` for the complete corpus-wide check.
- **One section per call** — a document with several changed sections needs one call per `updatedSection.heading`.
- **Ordinal correspondence, not semantic matching** — the mirror section replaced is the one at the same heading POSITION as the source section, which assumes the pair's heading count and depths already matched before this call. A mirror that was already out of sync elsewhere fails loud rather than guessing a splice point.
- **No mirror creation** — when `docPath` has no `.zh.md` counterpart at all, the tool reports `paired: false` and writes nothing; authoring a brand-new translation pair is a human/reviewed step (see `docs/i18n/README.md`).
- **Local filesystem only** — pure `node:fs` reads and writes against the configured `root`; no git operations run (the `.i18n.yaml` hashes are computed from file content, not `git hash-object` invocations).
