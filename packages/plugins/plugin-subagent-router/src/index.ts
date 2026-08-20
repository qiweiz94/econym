/**
 * `subagent` tool: a single model-facing delegation entry that routes to a
 * subagent provider by config-owned policy. The model names only the task (a
 * short description and the full prompt); the router resolves the first
 * registered provider — from the default candidates or every label-matching
 * route in config order — whose start-time capabilities satisfy the
 * configured request options, and dispatches via `ctx.subagents.start`.
 * A delegation that matches a route never falls back to the default
 * candidates: routes are policy, and an unroutable delegation fails loud.
 * Provider selection is policy, not model transport vocabulary. Named
 * exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-plugin-subagent-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { outputValueText, settleForegroundRun } from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { matchRouteAgentOptions, matchRouteCandidates, neededCapabilities, resolveProvider } from './resolver.ts'

export const name = 'plugin-subagent-router'
export const inject = ['tools', 'subagents']

/** Ordered provider candidates for one label-routed delegation. */
export interface RoutePolicy {
  /** Case-insensitive substring matched against the delegated task label. */
  label: string
  /** Ordered provider candidates tried in sequence. */
  providers: string[]
  /**
   * Per-route child model/provider override forwarded to the provider for
   * delegations this route matches; the first matching route that declares one
   * wins over the global `agentOptions`.
   */
  agentOptions?: AgentOptions
}

/** Runtime configuration for the routing delegation tool. */
export interface Config {
  /** Ordered provider candidates used when no route matches. */
  providers: string[]
  /** Label-routed provider overrides; every matching route is tried in order. */
  routes?: RoutePolicy[]
  /** The model-facing tool name. */
  toolName?: string
  /** Per-child model/provider override forwarded to the provider. */
  agentOptions?: AgentOptions
  /** Per-child persona (requires the `persona` provider capability). */
  persona?: string
  /** Child tool scoping (requires the `toolFilter` provider capability). */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /** Absolute delegation-depth cap (requires the `depthLimit` capability). */
  maxDepth?: number | 'provider-managed'
}

// Prevent Schemastery from materializing an omitted agentOptions as `{}`;
// shared by the global field and each route's per-route override.
/* jscpd:ignore-start -- deliberate parallel of dsh-tool-subagent's inline
   agentOptions schema; the two tools evolve these independently. */
const agentOptionsSchema = (): z<AgentOptions> => z.object({
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
}).default(undefined as unknown as { provider: string; model: string; maxTokens: number })
/* jscpd:ignore-end */

/** Runtime configuration schema for the routing delegation tool. */
export const Config: z<Config> = z.object({
  providers: z.array(z.string()).min(1).required(),
  routes: z.array(z.object({
    label: z.string().min(1).required(),
    providers: z.array(z.string()).min(1).required(),
    agentOptions: agentOptionsSchema(),
  })).default([]),
  toolName: z.string().default('subagent'),
  /* jscpd:ignore-start -- deliberate parallel of dsh-tool-subagent's delegation
     option fields; the two tools evolve these independently (tool-subagent
     defaults maxDepth to 3, this router leaves it unset). */
  agentOptions: agentOptionsSchema(),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
  /* jscpd:ignore-end */
})

/**
 * Register the routing delegation tool.
 * @param ctx - Cordis context carrying the tool registry and subagent service.
 * @param config - router configuration; `providers` must be non-empty.
 */
export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's constraints; the loader validates the
  // z Config schema (including a non-empty `providers` list) before apply runs.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('plugin-subagent-router: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }

  const toolName = config.toolName ?? 'subagent'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delegate a self-contained task to a subagent and wait for its result. The runtime routes the delegation to a capable subagent provider selected by policy; the tool returns the subagent\'s final output. Use it to offload work whose result your next step depends on.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display and routing.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The full task for the subagent.',
      },
    },
    output: {
      /* jscpd:ignore-start -- tool schemas are consumer-owned (capability-seam
         rule); this block states dsh-subagent's ForegroundToolResult in tool
         schema form, the same statement dsh-tool-subagent makes. */
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          runId: { type: 'string', required: true },
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: outputValueText(value.output) }],
      /* jscpd:ignore-end */
    },
    // Children never mutate the parent session; the run is one foreground
    // delegation with no parent-owned durable write beyond the tool/result.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
      }
      // Providers may register later than this plugin (sibling load order and
      // HMR), so resolve against the live registry at call time.
      const candidates = matchRouteCandidates(config, args.description) ?? config.providers
      const needed = neededCapabilities(config)
      const provider = resolveProvider(ctx, candidates, needed)
      const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
      const agentOptions = matchRouteAgentOptions(config, args.description) ?? config.agentOptions
      /* jscpd:ignore-start -- forwards the parallel option fields above into
         the start request; the fragment tracks this tool's own Config, not
         dsh-tool-subagent's. */
      const request: SubagentStartRequest = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
        parent,
        signal: exec.signal,
        ...agentOptions !== undefined ? { agentOptions } : {},
        ...config.persona !== undefined ? { persona: config.persona } : {},
        ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
        ...maxDepth !== undefined ? { maxDepth } : {},
      }
      /* jscpd:ignore-end */
      const run = await ctx.subagents.start(provider, request)
      return settleForegroundRun(run)
    },
  }))
}
