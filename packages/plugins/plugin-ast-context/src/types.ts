/**
 * Types shared by the AST extractor and the `get_file_outline` tool contract.
 * This module contains only types; the runtime implementation lives in extractor.ts.
 * @module @econym/dsh-plugin-ast-context/types
 */

/** Kinds of TypeScript declarations the outline reports. */
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum'

/** One declared symbol in the outlined file, with its source span. */
export interface SymbolEntry {
  /** The declaration kind. */
  kind: SymbolKind
  /** The declared name; empty for anonymous declarations. */
  name: string
  /** 1-based line where the declaration starts. */
  line: number
  /** 1-based line where the declaration ends (inclusive). */
  endLine: number
  /** Declarations nested in the symbol's body (class/interface members). */
  children: SymbolEntry[]
}

/** Canonical result of `get_file_outline` for one file. */
export interface FileOutlineResult {
  /** The absolute path the outline was produced from. */
  path: string
  /** Top-level declarations, in source order. */
  symbols: SymbolEntry[]
}

/** Canonical result of `get_directory_outline` for one directory tree. */
export interface DirectoryOutlineResult {
  /** The directory the outline was produced from. */
  path: string
  /** One file outline per outlined file, in path order. */
  files: FileOutlineResult[]
  /** Candidate files not outlined: hidden or non-TypeScript files are never counted. */
  skippedFiles: number
}
