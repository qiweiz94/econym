/**
 * `get_file_outline` tool: parse a local TypeScript file and report its declared
 * symbols with 1-based line spans, so the model can orient before reading a
 * large file. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-ast-context
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AstSymbolExtractor } from './extractor.ts'
import type { FileOutlineResult, SymbolEntry } from './types.ts'

export const name = 'plugin-ast-context'
export const inject = ['tools']

const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'enum'] as const

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
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'get_file_outline',
    description: 'Parse a local TypeScript file and list its top-level declarations — functions, '
      + 'classes, interfaces, type aliases, and enums — with 1-based line spans, plus the methods '
      + 'declared in each class or interface body. Use it to orient yourself before reading a large '
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
                  description: 'Methods declared in the symbol body.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: { type: 'string', required: true, enum: [...SYMBOL_KINDS], description: 'The member kind.' },
                      name: { type: 'string', required: true, description: 'The member name.' },
                      line: { type: 'integer', required: true, description: '1-based line where the member starts.' },
                      endLine: { type: 'integer', required: true, description: '1-based line where the member ends (inclusive).' },
                      children: { type: 'array', required: true, description: 'Nested members; always empty in the current outline.' },
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
      const text = await readFile(args.path, { encoding: 'utf8', signal: exec.signal })
      const symbols = new AstSymbolExtractor().extract(text)
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
