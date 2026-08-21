/**
 * `check_module_boundary` tool: validate a proposed import against the
 * monorepo's package-layering rules — architectural tier direction, the
 * plugins-do-not-import-each-other-undeclared rule, package-graph
 * acyclicity, and the target package's `exports` map — before it is written.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-arch-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { checkModuleBoundary } from './guard.ts'
import { buildWorkspaceIndex } from './workspace-index.ts'
import type { CheckModuleBoundaryResult } from './types.ts'

export const name = 'plugin-arch-guard'
export const inject = ['tools']

/** Runtime configuration for the module-boundary guard. */
export interface Config {
  /** Repository root the workspace package graph is scanned from; defaults to the process cwd. */
  root?: string
}

/** Runtime configuration schema for the guard tool. */
export const Config: z<Config> = z.object({
  root: z.string().default(process.cwd()),
})

/**
 * Render the verdict as model-facing prose.
 * @param result - the boundary check outcome.
 * @returns a one-line `allowed`/`blocked` verdict naming the rule and any suggestion.
 */
export function formatVerdict(result: CheckModuleBoundaryResult): string {
  if (result.allowed) return `allowed (${result.rule})`
  const suggestion = result.suggestion !== undefined ? `: ${result.suggestion}` : ''
  return `blocked (${result.rule})${suggestion}`
}

/**
 * Register `check_module_boundary` on `ctx.tools`. The workspace package
 * graph is scanned once from `config.root` at mount time, not re-read per call.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const workspace = buildWorkspaceIndex(config.root ?? process.cwd())

  ctx.tools.register(defineTool({
    name: 'check_module_boundary',
    description: 'Check whether importing targetImport from sourcePath is legal under the monorepo\'s package-layering '
      + 'rules: architectural tier direction (foundation packages < capability packages < surface/plugin packages), '
      + 'the plugins-may-not-import-each-other-unless-declared rule, package-graph acyclicity, and the target '
      + 'package\'s exports map. Use it before adding a new cross-package import.',
    parameters: {
      sourcePath: {
        type: 'string',
        required: true,
        description: 'Repo-relative path of the file the import would be written in (e.g. packages/plugins/plugin-arch-guard/src/guard.ts).',
      },
      targetImport: {
        type: 'string',
        required: true,
        description: 'The import specifier as it would be written at the source site (e.g. "@deepseek-ai/dsh-tools" or "./helpers.ts").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true, description: 'Whether the import is legal.' },
          rule: { type: 'string', required: true, description: 'The rule name that decided the verdict.' },
          suggestion: { type: 'string', description: 'A corrective suggestion, present when the import is disallowed.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatVerdict(value) }],
      presentationMeta: (_args, value) => ({ verdict: value }),
    },
    execute: args => Promise.resolve(checkModuleBoundary({ sourcePath: args.sourcePath, targetImport: args.targetImport }, workspace)),
    presentCall: args => ({
      card: 'generic',
      title: 'Check module boundary',
      kind: 'read',
      rawInput: `${args.sourcePath} -> ${args.targetImport}`,
      locations: [{ path: args.sourcePath }],
    }),
  }))
}
