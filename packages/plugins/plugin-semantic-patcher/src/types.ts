/**
 * Types shared by the symbol locator, the patch writer, and the
 * `patch_symbol_body` tool contract. This module contains only types; the
 * runtime implementation lives in patcher.ts.
 * @module @econym/dsh-plugin-semantic-patcher/types
 */

/** Kinds of TypeScript symbol whose body `patch_symbol_body` can replace. */
export type SymbolTargetKind = 'function' | 'method' | 'arrow'

/** One patchable symbol, reported when a request is ambiguous or unmatched. */
export interface SymbolCandidate {
  /** Fully qualified name: `name` at file scope, `Class.member` for members. */
  name: string
  /** The declaration kind whose body would be replaced. */
  kind: SymbolTargetKind
  /** 1-based line where the symbol's body starts. */
  line: number
  /** 1-based line where the symbol's body ends (inclusive). */
  endLine: number
}

/** Canonical result of one successful `patch_symbol_body` call. */
export interface PatchSymbolBodyResult {
  /** The path that was patched, as the caller supplied it. */
  path: string
  /** The fully qualified name of the symbol whose body was replaced. */
  symbol: string
  /** The declaration kind of the patched symbol. */
  kind: SymbolTargetKind
  /** 1-based line where the replaced body started in the original file. */
  line: number
  /** 1-based line where the replaced body ended in the original file. */
  endLine: number
}
