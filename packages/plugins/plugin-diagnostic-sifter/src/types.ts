/**
 * Type-only contracts for `@econym/dsh-plugin-diagnostic-sifter`: the
 * sifted diagnostic records and the tool's structured result value.
 * @module @econym/dsh-plugin-diagnostic-sifter/types
 */

/** The two checks the tool can run. */
export type DiagnosticCommand = 'typecheck' | 'test'

/** One bounded output record: retained text plus whether bytes were dropped. */
export interface RetainedOutput {
  readonly text: string
  readonly truncated: boolean
}

/** One retained root-cause diagnostic. */
export interface DiagnosticRootCause {
  /** Source path as the underlying tool printed it (usually cwd-relative). */
  readonly file: string
  /** 1-based line; 0 when the output carried no usable location. */
  readonly line: number
  /** Diagnostic code (e.g. `TS2322`); absent for test failures. */
  readonly code?: string
  /** The diagnostic message; for a test failure, the test path, assertion message, and retained expected/received diff. */
  readonly message: string
}

/** A parser's verdict over one check's complete captured output. */
export interface SiftReport {
  /**
   * Whether the output was recognized as this check's diagnostic format —
   * either a recognized-clean run or at least one parsed diagnostic. False
   * output must surface raw, never read as clean.
   */
  readonly recognized: boolean
  /** Diagnostics retained after cascade suppression and deduplication. */
  readonly rootCauses: readonly DiagnosticRootCause[]
  /** Cascade diagnostics (TS2307/TS2724 with an upstream root cause present) dropped from `rootCauses`. */
  readonly suppressedCascadeCount: number
  /** Exact-duplicate diagnostics merged away before cascade suppression. */
  readonly deduplicatedCount: number
}

/** The diagnostic tool's structured result value. */
export interface DiagnosticCheckResult {
  readonly kind: 'diagnostic'
  /** The check that ran. */
  readonly command: DiagnosticCommand
  /** The spawned check's exit code; null when it died from a signal. */
  readonly exitCode: number | null
  /** The terminating signal; null on normal exit. */
  readonly signal: string | null
  /** True iff the check exited 0. Never inferred from an absence of parsed diagnostics. */
  readonly success: boolean
  /**
   * True when the output was not recognized as the check's diagnostic format,
   * or when a failing exit produced no parsed diagnostics to explain it; `raw`
   * then carries the bounded output so the failure is never silent.
   */
  readonly parseFailure: boolean
  /** Root-cause diagnostics, bounded by the output envelope. */
  readonly rootCauses: DiagnosticRootCause[]
  /** Cascade diagnostics suppressed as downstream fallout of a retained root cause. */
  readonly suppressedCascadeCount: number
  /** Exact-duplicate diagnostics merged away. */
  readonly deduplicatedCount: number
  /** Whether the envelope dropped root causes or the capture itself was lossy. */
  readonly truncated: boolean
  /** Bounded raw output; present only when `parseFailure` is true. */
  readonly raw?: RetainedOutput
}
