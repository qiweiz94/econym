/**
 * `patch_symbol_body` tool: replace the body of one named TypeScript symbol in
 * place. The symbol is located by tree-sitter rather than by matching text, so
 * an edit lands on the declaration the model named even when its body text
 * appears elsewhere in the file. Named exports preserve loader injection
 * metadata.
 * @module @deepseek-ai/dsh-plugin-semantic-patcher
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { patchSymbolBody } from './patcher.ts'
import type { PatchSymbolBodyResult } from './types.ts'

export const name = 'plugin-semantic-patcher'
export const inject = ['tools']

const TARGET_KINDS = ['function', 'method', 'arrow'] as const

/** Configuration for the semantic patch tool. */
export interface Config {
  /** Repository root; a path resolving outside it is refused (default `process.cwd()`). */
  cwd?: string
  /** Refuse files larger than this many bytes (default 2 MiB). */
  maxBytes?: number
}

/** Runtime configuration schema for the semantic patcher plugin. */
export const Config: z<Config> = z.object({
  cwd: z.string(),
  maxBytes: z.number().step(1).min(1).default(2_000_000),
})

/**
 * Render the patch outcome as model-facing prose naming the symbol and the
 * span that was replaced.
 * @param result - the validated patch result.
 * @returns the text block confirming the edit.
 */
function formatPatch(result: PatchSymbolBodyResult): string {
  const span = result.endLine > result.line
    ? `lines ${result.line}-${result.endLine}`
    : `line ${result.line}`
  return `Replaced the body of ${result.kind} ${result.symbol} in ${result.path} (${span})`
}

/**
 * Register the `patch_symbol_body` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(defineTool({
    name: 'patch_symbol_body',
    description: 'Replace the body of one named symbol in a local TypeScript (.ts or .tsx) file. The symbol is '
      + 'located in the parsed syntax tree, not by matching text, so the edit lands on the declaration you '
      + 'named. Supports top-level functions, function-valued bindings (arrow functions), and class members; '
      + 'name a member as Class.method to disambiguate. If the name matches no symbol or more than one, the '
      + 'call fails and lists the candidates instead of guessing. The replacement is parsed before anything is '
      + 'written: if the result would not parse, the file is left byte-for-byte unchanged.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Repo-relative path to a TypeScript (.ts or .tsx) file inside the repository root.',
      },
      symbol: {
        type: 'string',
        required: true,
        description: 'The symbol whose body to replace: a top-level name, or Class.method for a class member.',
      },
      newBody: {
        type: 'string',
        required: true,
        description: 'The replacement body source. Include the surrounding braces for a block body '
          + '(for example "{ return 1 }"); for a concise arrow body, pass the expression alone.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'The path that was patched.' },
          symbol: { type: 'string', required: true, description: 'The fully qualified name of the patched symbol.' },
          kind: {
            type: 'string',
            required: true,
            enum: [...TARGET_KINDS],
            description: 'The declaration kind of the patched symbol.',
          },
          line: { type: 'integer', required: true, description: '1-based line where the replaced body started.' },
          endLine: { type: 'integer', required: true, description: '1-based line where the replaced body ended (inclusive).' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatPatch(value) }],
      presentationMeta: (_args, value) => ({ patch: value }),
    },
    async execute(args, exec) {
      return await patchSymbolBody({
        root: config.cwd ?? process.cwd(),
        path: args.path,
        symbol: args.symbol,
        newBody: args.newBody,
        maxBytes: config.maxBytes,
        signal: exec.signal,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Patch symbol body',
      kind: 'edit',
      rawInput: `${args.symbol} in ${args.path}`,
      locations: [{ path: args.path }],
    }),
  }))
}

export type * from './types.ts'
