/**
 * Configuration types for `@deepseek-ai/dsh-budget-governor`. Ceilings
 * are per delegated child run; every ceiling is optional, but a governor with
 * no ceiling at all is misconfiguration and fails at load. `Config` itself is
 * declared in `./index.ts`, not here: it merges with the runtime schema
 * value exported under the same name, which a re-exported type-only binding
 * cannot do (TS2395/TS2323).
 *
 * @module @deepseek-ai/dsh-budget-governor/types
 */

/** One model-facing edit tool whose calls participate in churn detection. */
export interface EditToolSpec {
  /** Registered tool name exactly as it appears in `tool/call` events. */
  name: string
  /** Argument key whose string value is the edited file path (e.g. `file_path`). */
  pathArgument: string
}

/**
 * Same-file edit-churn ceiling over a bounded window of a child run's most
 * recent edit-tool calls. All three fields are required together: the governed
 * tool set is deployment vocabulary, so no tool list is assumed.
 */
export interface EditChurnConfig {
  /** Edits to one file within the window that terminate the run. Integer >= 2. */
  maxSameFileEdits: number
  /** How many recent edit calls the window retains. Integer >= `maxSameFileEdits`. */
  window: number
  /** Non-empty, duplicate-free edit tools tracked by the detector. */
  tools: EditToolSpec[]
}
