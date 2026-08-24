/**
 * Type-only contracts for `@econym/dsh-plugin-impacted-tests`: the import
 * DAG, the impact analysis it answers, the suite-runner seam, and the tool's
 * structured result value.
 * @module @econym/dsh-plugin-impacted-tests/types
 */

/** One bounded output record: retained text plus whether bytes were dropped. */
export interface RetainedOutput {
  readonly text: string
  readonly truncated: boolean
}

/**
 * The workspace import DAG over absolute, symlink-free source paths. `imports`
 * holds the forward edges discovered from the test seeds; `importedBy` is the
 * inverted view the impact walk consumes.
 */
export interface ImportGraph {
  /** Source file → the source files it imports. */
  readonly imports: ReadonlyMap<string, ReadonlySet<string>>
  /** Source file → the source files that import it directly. */
  readonly importedBy: ReadonlyMap<string, ReadonlySet<string>>
}

/** One impact analysis: which discovered suites a change set can reach. */
export interface ImpactAnalysis {
  /** Repo-relative suite paths that transitively import a changed file, sorted. */
  readonly selectedSuites: string[]
  /** Discovered suites that no changed file reaches. */
  readonly skippedCount: number
  /** Total suites the test patterns matched. */
  readonly discoveredCount: number
}

/** One suite run's captured outcome. */
export interface SuiteRunOutcome {
  /** The runner's exit code; null when it died from a signal. */
  readonly exitCode: number | null
  /** The terminating signal; null on normal exit. */
  readonly signal: string | null
  /** The runner's retained stdout. */
  readonly stdout: RetainedOutput
  /** The runner's retained stderr. */
  readonly stderr: RetainedOutput
}

/**
 * The runner seam: execute exactly the given repo-relative suites and report
 * the bounded outcome. Unit tests replace the shipped subprocess runner with a
 * recording stub so no real test runner is spawned.
 */
export type SuiteRunner = (suites: readonly string[], signal: AbortSignal) => Promise<SuiteRunOutcome>

/** The `run_impacted_tests` tool's structured result value. */
export interface ImpactedTestsResult {
  readonly kind: 'impacted-tests'
  /** The change set the selection ran against, repo-relative. */
  readonly changedFiles: string[]
  /** The suites selected by the reverse import walk, repo-relative and sorted. */
  readonly selectedSuites: string[]
  /** Discovered suites left unrun because no changed file reaches them. */
  readonly skippedCount: number
  /** The runner's summary; `executed` is false when nothing was selected. */
  readonly results: {
    readonly executed: boolean
    readonly exitCode: number | null
    readonly signal: string | null
    readonly stdout: RetainedOutput
    readonly stderr: RetainedOutput
  }
}
