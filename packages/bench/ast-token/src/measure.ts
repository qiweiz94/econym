/**
 * Measured token-economy benchmark for the AST-guided read path.
 *
 * Compares two ways a model can understand a TypeScript file:
 *
 * 1. **Naive** — read the whole file into context.
 * 2. **Guided** — `get_file_outline` (a compact symbol index), then a targeted
 *    read of just the lines that matter (one symbol's span).
 *
 * Token counts are an ESTIMATE using a `chars / 4` proxy (roughly 4 characters
 * per token), applied to the exact text a model would receive from each tool.
 * This is a reproducible local yardstick, not a provider-billed figure — the
 * real number depends on the tokenizer and the conversation prefix, which a
 * harness benchmark cannot reproduce without live API calls. The measured
 * reduction is a stable lower bound: the outline is tiny relative to the file,
 * so the guided path dominates on any file with a meaningful symbol span.
 *
 * @module @econym/bench-ast-token/measure
 */

import { AstSymbolExtractor, grammarFor } from '@econym/dsh-plugin-ast-context/src/extractor.ts'
import type { SymbolEntry } from '@econym/dsh-plugin-ast-context/src/types.ts'

/** Rough token estimate: ~4 characters per token (English prose + code). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Render one symbol to the same prose the outline tool emits. */
function formatSymbol(symbol: SymbolEntry, indent: string): string {
  const span = symbol.endLine > symbol.line
    ? `lines ${symbol.line}-${symbol.endLine}`
    : `line ${symbol.line}`
  const members = symbol.children.map(child => formatSymbol(child, `${indent}  `))
  return [indent + `${symbol.kind} ${symbol.name} (${span})`, ...members].join('\n')
}

/** Render a whole outline exactly as `get_file_outline`'s renderer does. */
function formatOutline(path: string, symbols: SymbolEntry[]): string {
  const lines = symbols.map(symbol => formatSymbol(symbol, ''))
  return `${symbols.length} symbol${symbols.length === 1 ? '' : 's'} in ${path}\n${lines.join('\n')}`
}

/** The line-range text a targeted read would return for one symbol's span. */
function targetedRead(lines: string[], symbol: SymbolEntry): string {
  return lines.slice(symbol.line - 1, symbol.endLine).join('\n')
}

/** One file's measured result. */
export interface FileMeasure {
  path: string
  totalLines: number
  naiveTokens: number
  outlineTokens: number
  targetedTokens: number
  guidedTokens: number
  /** Percent of input tokens saved by the guided path (0-100). */
  reductionPct: number
  /** The symbol the targeted read used, for the report. */
  focused: string
}

/**
 * Choose the symbol a targeted read would fetch. The model reads ONE narrow
 * function/method after orienting, not the largest class — so prefer the widest
 * `function`/`method` symbol (top-level or nested), falling back to the widest
 * top-level symbol when a file has no function worth reading.
 */
function pickFocused(symbols: SymbolEntry[]): SymbolEntry {
  const functions: SymbolEntry[] = []
  const collect = (list: SymbolEntry[]): void => {
    for (const s of list) {
      if (s.kind === 'function') functions.push(s)
      collect(s.children)
    }
  }
  collect(symbols)
  const pool = functions.length > 0 ? functions : symbols
  const empty = { kind: 'type' as const, name: '<none>', line: 1, endLine: 1, children: [] }
  return pool.reduce((best, s) => (s.endLine - s.line > best.endLine - best.line ? s : best), empty)
}

/**
 * Measure the guided-vs-naive token delta for one TypeScript source string.
 * @param path - a display path for the report.
 * @param text - the file's full source text.
 * @returns the measured file result.
 */
export function measureFile(path: string, text: string): FileMeasure {
  const lines = text.split('\n')
  const symbols = new AstSymbolExtractor(grammarFor(path)).extract(text)
  const naiveTokens = estimateTokens(text)

  const outlineTokens = estimateTokens(formatOutline(path, symbols))
  const focused = pickFocused(symbols)
  const targetedTokens = estimateTokens(targetedRead(lines, focused))

  const guidedTokens = outlineTokens + targetedTokens
  const reductionPct = ((naiveTokens - guidedTokens) / naiveTokens) * 100
  return {
    path,
    totalLines: lines.length,
    naiveTokens,
    outlineTokens,
    targetedTokens,
    guidedTokens,
    reductionPct,
    focused: focused.name,
  }
}

/** Render one file's result as a report row. */
export function formatResult(result: FileMeasure): string {
  return [
    `${result.path} (${result.totalLines} lines, focused ${result.focused})`,
    `  naive   ${result.naiveTokens} tokens`,
    `  guided  ${result.guidedTokens} tokens (outline ${result.outlineTokens} + targeted ${result.targetedTokens})`,
    `  saved   ${result.reductionPct.toFixed(1)}%`,
  ].join('\n')
}
