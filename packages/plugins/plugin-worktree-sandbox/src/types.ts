/**
 * Type-only contracts for `@deepseek-ai/dsh-plugin-worktree-sandbox`: the
 * sandbox tool's bounded output records and its structured result value.
 * @module @deepseek-ai/dsh-plugin-worktree-sandbox/types
 */

/** One bounded output record: retained text plus whether bytes were dropped. */
export interface RetainedOutput {
  readonly text: string
  readonly truncated: boolean
}

/** The sandbox tool's structured result value. */
export interface SandboxExecResult {
  readonly kind: 'sandbox'
  /** Absolute path of the trial worktree (removed after the call by default). */
  readonly worktree: string
  /** The base ref the trial worktree was detached from. */
  readonly baseRef: string
  /** Whether this call created the worktree (false when reusing an existing trial). */
  readonly created: boolean
  /** The sandboxed command's exit code; null when it died from a signal. */
  readonly exitCode: number | null
  /** The terminating signal; null on normal exit. */
  readonly signal: string | null
  /** The command's retained stdout (15 KB envelope). */
  readonly stdout: RetainedOutput
  /** The command's retained stderr (15 KB envelope). */
  readonly stderr: RetainedOutput
  /** The trial's retained `git diff` vs the base commit (15 KB envelope). */
  readonly diff: RetainedOutput
  /** The trial's retained `git diff --stat` vs the base commit. */
  readonly diffStat: RetainedOutput
  /** The files the trial changed or added, in `git status --porcelain` order. */
  readonly changedFiles: string[]
  /** Present only when removing the trial worktree failed. */
  readonly cleanupError?: string
}
