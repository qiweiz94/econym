/**
 * Type-only declarations for `@deepseek-ai/dsh-plugin-doc-sync-automator`.
 * @module @deepseek-ai/dsh-plugin-doc-sync-automator/types
 */

/** Identifies which section of an English document changed. */
export interface UpdatedSection {
  /** Exact heading text (without leading `#`s), e.g. `"Configuration"`. */
  heading: string
}

/** `sync_bilingual_pair` input. */
export interface SyncBilingualPairInput {
  /** Repository-relative English Markdown path, e.g. `"docs/architecture.md"`. Must end in `.md` and not `.zh.md`. */
  docPath: string
  /** The section of `docPath` to propagate into its `.zh.md` mirror. */
  updatedSection: UpdatedSection
}

/** `sync_bilingual_pair` result. */
export interface SyncBilingualPairResult {
  /**
   * Whether `docPath`'s `.zh.md` mirror was located and (when found)
   * re-synced to a structurally consistent, hash-recorded pair. `false`
   * only when the mirror file does not exist.
   */
  paired: boolean
  /**
   * Repository-relative path of the mirror this call located or would have
   * written to (`docPath` with `.md` replaced by `.zh.md`), even when
   * `paired` is `false`.
   */
  mirrorPath: string
  /**
   * Whether every path in this pair that is governed by
   * `scripts/doc-budgets.manifest.json` (`docPath`, and the mirror when
   * `paired`) is within its ceiling. `true` for a pair with no budgeted path.
   */
  budgetOk: boolean
  /**
   * Whether the mirror now carries unresolved `NEEDS-TRANSLATION` debt from
   * this call. `true` whenever a splice happened; `false` when the mirror
   * could not be located.
   */
  pendingTranslation: boolean
}
