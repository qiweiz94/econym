/**
 * `get_file_outline` tool: parse a local TypeScript file and report its declared
 * symbols with 1-based line spans, so the model can orient before reading a
 * large file. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-ast-context
 */

import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AstSymbolExtractor } from './extractor.ts'
import type { FileOutlineResult, SymbolEntry } from './types.ts'

export const name = 'plugin-ast-context'
export const inject = ['tools']

const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'enum'] as const

/** Configuration for the outline tool. */
export interface Config {
  /** Refuse files larger than this many bytes (default 2 MiB). */
  maxBytes?: number
  /** Refuse outlines with more symbols than this (default 2,000). */
  maxSymbols?: number
}

/** Runtime configuration schema for the outline tool plugin. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).default(2_000_000),
  maxSymbols: z.number().step(1).min(1).default(2_000),
})

/** One outline line: `kind name (line N)` or `(lines N-M)` for multi-line symbols. */
function formatSymbol(symbol: SymbolEntry, indent: string): string {
  const span = symbol.endLine > symbol.line
    ? `lines ${symbol.line}-${symbol.endLine}`
    : `line ${symbol.line}`
  const members = symbol.children.map(child => formatSymbol(child, `${indent}  `))
  return [indent + `${symbol.kind} ${symbol.name} (${span})`, ...members].join('\n')
}

/**
 * Render the canonical outline as model-facing prose: one line per symbol in
 * source order, members indented under their owner.
 * @param result - the validated outline value.
 * @returns the text block describing the file.
 */
function formatOutline(result: FileOutlineResult): string {
  const lines = result.symbols.map(symbol => formatSymbol(symbol, ''))
  return `${result.symbols.length} symbol${result.symbols.length === 1 ? '' : 's'} in ${result.path}\n${lines.join('\n')}`
}

/**
 * Register the `get_file_outline` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(defineTool({
    name: 'get_file_outline',
    description: 'Parse a local TypeScript file and list its top-level declarations — functions, '
      + 'classes, interfaces, type aliases, and enums — with 1-based line spans, plus the declarations '
      + 'and methods declared in each symbol body. Use it to orient yourself before reading a large '
      + 'file. The path must exist and parse without syntax errors.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Repo-relative path to a TypeScript (.ts) file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'The repo-relative path that was outlined.' },
          symbols: {
            type: 'array',
            required: true,
            description: 'Top-level declarations in source order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: [...SYMBOL_KINDS], description: 'The declaration kind.' },
                name: { type: 'string', required: true, description: 'The declared name.' },
                line: { type: 'integer', required: true, description: '1-based line where the declaration starts.' },
                endLine: { type: 'integer', required: true, description: '1-based line where the declaration ends (inclusive).' },
                children: {
                  type: 'array',
                  required: true,
                  description: 'Declarations and methods declared in the symbol body.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, enum: [...SYMBOL_KINDS], description: 'The member kind.' },
                      name: { type: 'string', required: true, description: 'The member name.' },
                      line: { type: 'integer', required: true, description: '1-based line where the member starts.' },
                      endLine: { type: 'integer', required: true, description: '1-based line where the member ends (inclusive).' },
                      children: { type: 'array', required: true, description: 'Nested declarations; one body level deep.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatOutline(value) }],
    },
    async execute(args, exec) {
      const size = (await stat(args.path)).size
      if (config.maxBytes !== undefined && size > config.maxBytes) {
        throw new Error(`file is ${size} bytes, exceeding the ${config.maxBytes}-byte outline limit; read the file directly or narrow the path`)
      }
      const text = await readFile(args.path, { encoding: 'utf8', signal: exec.signal })
      const symbols = new AstSymbolExtractor().extract(text, config.maxSymbols)
      return { path: args.path, symbols }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Outline file',
      kind: 'read',
      rawInput: args.path,
      locations: [{ path: args.path }],
    }),
  }))
}

export type * from './types.ts'
