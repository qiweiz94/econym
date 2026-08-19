/**
 * `get_file_outline` and `get_directory_outline` tools: parse local TypeScript
 * files and report their declared symbols with 1-based line spans, so the
 * model can orient before reading large files or trees. Named exports
 * preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-ast-context
 */

import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { collectTypeScriptFiles, outlineCollectedFile } from './directory.ts'
import { AstSymbolExtractor, grammarFor } from './extractor.ts'
import type { DirectoryOutlineResult, FileOutlineResult, SymbolEntry } from './types.ts'

export const name = 'plugin-ast-context'
export const inject = ['tools']

const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'enum'] as const

/** Author-facing schema for one declared symbol, shared by both output schemas. */
const SYMBOL_SCHEMA = {
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
} as const satisfies ValueSchemaSpec

/** Configuration for the outline tools. */
export interface Config {
  /** Refuse files larger than this many bytes (default 2 MiB). */
  maxBytes?: number
  /** Refuse outlines with more symbols than this (default 2,000). */
  maxSymbols?: number
  /** Refuse directory outlines with more files than this (default 200). */
  maxFiles?: number
}

/** Runtime configuration schema for the outline tool plugin. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).default(2_000_000),
  maxSymbols: z.number().step(1).min(1).default(2_000),
  maxFiles: z.number().step(1).min(1).default(200),
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
 * Render a directory outline as model-facing prose: one file block per file
 * in path order, preceded by an aggregate line naming the skip count.
 * @param result - the validated directory outline value.
 * @returns the text block describing the tree.
 */
function formatDirectoryOutline(result: DirectoryOutlineResult): string {
  const blocks = result.files.map(file => formatOutline(file))
  const files = `${result.files.length} file${result.files.length === 1 ? '' : 's'} outlined in ${result.path}`
  const skipped = result.skippedFiles > 0 ? `, ${result.skippedFiles} candidate file${result.skippedFiles === 1 ? '' : 's'} skipped` : ''
  return `${files}${skipped}\n${blocks.join('\n')}`
}

/**
 * Register the outline tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(defineTool({
    name: 'get_file_outline',
    description: 'Parse a local TypeScript (.ts or .tsx) file and list its top-level declarations — functions, '
      + 'classes, interfaces, type aliases, and enums — with 1-based line spans, plus the declarations '
      + 'and methods declared in each symbol body. Use it to orient yourself before reading a large '
      + 'file. The path must exist and parse without syntax errors.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Repo-relative path to a TypeScript (.ts or .tsx) file.',
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
            items: SYMBOL_SCHEMA,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatOutline(value) }],
      presentationMeta: (_args, value) => ({ outline: value }),
    },
    async execute(args, exec) {
      const size = (await stat(args.path)).size
      if (config.maxBytes !== undefined && size > config.maxBytes) {
        throw new Error(`file is ${size} bytes, exceeding the ${config.maxBytes}-byte outline limit; read the file directly or narrow the path`)
      }
      const text = await readFile(args.path, { encoding: 'utf8', signal: exec.signal })
      const symbols = new AstSymbolExtractor(grammarFor(args.path)).extract(text, config.maxSymbols)
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

  ctx.tools.register(defineTool({
    name: 'get_directory_outline',
    description: 'Parse every TypeScript (.ts or .tsx) file under a directory and list each file\'s top-level '
      + 'declarations — functions, classes, interfaces, type aliases, and enums — with 1-based line spans, '
      + 'plus the declarations and methods declared in each symbol body. Hidden entries, node_modules, and '
      + '.d.ts declaration files are ignored. Use it to orient yourself before reading a large directory tree. The path must exist and '
      + 'be a directory.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Repo-relative path to a directory containing TypeScript (.ts or .tsx) files.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'The repo-relative directory that was outlined.' },
          files: {
            type: 'array',
            required: true,
            description: 'One outline per outlined file, in path order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true, description: 'The repo-relative path that was outlined.' },
                symbols: {
                  type: 'array',
                  required: true,
                  description: 'Top-level declarations in source order.',
                  items: SYMBOL_SCHEMA,
                },
              },
            },
          },
          skippedFiles: {
            type: 'integer',
            required: true,
            description: 'Candidate files not outlined: the file cap or per-file limits were hit, or the file failed to parse.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDirectoryOutline(value) }],
      presentationMeta: (_args, value) => ({ outline: value }),
    },
    async execute(args, exec) {
      const { files, overLimit } = await collectTypeScriptFiles(args.path, config.maxFiles ?? 200, exec.signal)
      const outlined: FileOutlineResult[] = []
      let skipped = overLimit
      for (const file of files) {
        try {
          const result = await outlineCollectedFile(
            file,
            (path, text) => new AstSymbolExtractor(grammarFor(path)).extract(text, config.maxSymbols),
            config.maxBytes,
            exec.signal,
          )
          if (result !== undefined) outlined.push(result)
          else skipped += 1
        } catch (_error: unknown) {
          if (exec.signal.aborted) exec.signal.throwIfAborted()
          // A file that cannot be read or does not parse is counted and skipped,
          // so one bad file cannot fail the whole directory outline.
          skipped += 1
        }
      }
      return { path: args.path, files: outlined, skippedFiles: skipped }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Outline directory',
      kind: 'read',
      rawInput: args.path,
      locations: [{ path: args.path }],
    }),
  }))
}

export type * from './types.ts'
