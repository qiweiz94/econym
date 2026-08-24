/**
 * `sync_bilingual_pair` tool: splice a changed section of an English
 * Markdown document into its paired `.zh.md` mirror behind a
 * NEEDS-TRANSLATION marker, keeping the bilingual pair structurally valid
 * and its `.i18n.yaml` consistency record current without machine
 * translating anything. Named exports preserve loader injection metadata.
 * @module @econym/dsh-plugin-doc-sync-automator
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { syncBilingualPair } from './syncer.ts'
import type { SyncBilingualPairResult } from './types.ts'

export const name = 'plugin-doc-sync-automator'
export const inject = ['tools']

/** Runtime configuration for the doc-sync tool. */
export interface Config {
  /** Repository root every path resolves against; defaults to the process cwd. */
  root?: string
  /** Repo-relative path to the doc budgets manifest; defaults to `scripts/doc-budgets.manifest.json`. */
  budgetManifestPath?: string
  /** Model-facing tool name; defaults to `sync_bilingual_pair`. */
  toolName?: string
}

/** Runtime configuration schema for the doc-sync tool. */
export const Config: z<Config> = z.object({
  root: z.string(),
  budgetManifestPath: z.string().default('scripts/doc-budgets.manifest.json'),
  toolName: z.string().default('sync_bilingual_pair'),
})

/** Render the structured sync result as model-facing text. */
function renderSyncResult(result: SyncBilingualPairResult): string {
  if (!result.paired) {
    return `sync_bilingual_pair: no mirror at ${result.mirrorPath} — nothing to splice into. Create the counterpart before syncing (see docs/i18n/README.md).`
  }
  const budget = result.budgetOk ? 'within budget' : 'OVER a budgeted ceiling (see scripts/doc-budgets.manifest.json)'
  // paired: true always carries fresh NEEDS-TRANSLATION debt (see syncer.ts):
  // a splice never translates, so this branch is the only reachable one.
  return `sync_bilingual_pair: spliced into ${result.mirrorPath}, consistency record updated, ${budget}; the mirror now carries NEEDS-TRANSLATION debt for the spliced section.`
}

/**
 * Register the doc-sync tool.
 * @param ctx - Cordis context carrying the tool registry.
 * @param config - doc-sync configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const toolName = config.toolName ?? 'sync_bilingual_pair'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Propagate a changed section of an English Markdown document into its paired Simplified Chinese mirror (the .zh.md counterpart), keeping the bilingual pair structurally valid. This tool does NOT translate: the spliced content is the exact English text wrapped in NEEDS-TRANSLATION markers, and the pair\'s .i18n.yaml consistency record is rewritten so `pnpm run verify-translation-pairing` accepts the result instead of flagging it out-of-sync. Call it right after editing an English doc (docs/, .agents/notes/, or a package README) so the mirror stops silently drifting; a human translator later replaces the marked English text.',
    parameters: {
      docPath: {
        type: 'string',
        required: true,
        description: 'Repository-relative path to the English Markdown source, e.g. "docs/architecture.md" or "packages/plugins/plugin-foo/README.md". Must end in .md and not .zh.md.',
      },
      updatedSection: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Identifies which section of docPath changed.',
        properties: {
          heading: {
            type: 'string',
            required: true,
            description: 'Exact heading text (without leading #s) of the changed section in docPath, e.g. "Configuration".',
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paired: { type: 'boolean', required: true },
          mirrorPath: { type: 'string', required: true },
          budgetOk: { type: 'boolean', required: true },
          pendingTranslation: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSyncResult(value) }],
    },
    execute(args) {
      // syncBilingualPair is synchronous; the tool contract wants a Promise.
      return Promise.resolve(syncBilingualPair(
        { docPath: args.docPath, updatedSection: { heading: args.updatedSection.heading } },
        {
          root: config.root ?? process.cwd(),
          budgetManifestPath: config.budgetManifestPath ?? 'scripts/doc-budgets.manifest.json',
        },
      ))
    },
  }))
}
