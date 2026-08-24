/**
 * Config-owned provider resolution for the routing delegation tool: match the
 * delegated task label against the configured routes, derive the start-time
 * capabilities the request needs, and pick the first registered provider that
 * supports them — failing loud when none can serve the delegation.
 * @module @econym/dsh-plugin-subagent-router/resolver
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SubagentCapabilities } from '@deepseek-ai/dsh-subagent'
import type { Config, RoutePolicy } from './index.ts'
import type { NeededCapabilities } from './types.ts'

/**
 * Derive the capabilities a delegation imposes on its provider from the
 * configured request options. Each set option requires the matching provider
 * capability; unset options require nothing, so a provider without that
 * capability remains eligible.
 * @param config - the router configuration.
 * @returns a capability-need mask: true when the corresponding option is set.
 */
export function neededCapabilities(config: Pick<Config, 'persona' | 'toolFilter' | 'maxDepth'>): NeededCapabilities {
  return {
    persona: config.persona !== undefined,
    toolFilter: config.toolFilter !== undefined,
    depthLimit: typeof config.maxDepth === 'number',
  }
}

/**
 * Whether a provider's advertised capabilities cover every required capability.
 * @param capabilities - the provider's start-time capabilities.
 * @param needed - the capabilities the delegation requires.
 * @returns true when every required capability is supported.
 */
export function satisfiesCapabilities(capabilities: SubagentCapabilities, needed: NeededCapabilities): boolean {
  return (!needed.persona || capabilities.persona)
    && (!needed.toolFilter || capabilities.toolFilter)
    && (!needed.depthLimit || capabilities.depthLimit)
}

/**
 * Match a delegated task label against the configured label routes.
 * @param config - the router configuration.
 * @param label - the delegated task's short description.
 * @returns every matching route's ordered provider candidates, flattened in
 * config order (each route's providers stay ordered, and earlier routes stay
 * ahead of later ones) with duplicates removed, or undefined when no route
 * matches (the caller falls back to the default candidates).
 */
export function matchRouteCandidates(config: Config, label: string): readonly string[] | undefined {
  const candidates: string[] = []
  for (const route of matchingRoutes(config, label)) {
    for (const provider of route.providers) {
      if (!candidates.includes(provider)) candidates.push(provider)
    }
  }
  return candidates.length > 0 ? candidates : undefined
}

/**
 * Resolve the per-route child options for a delegation: the first matching
 * route (config order) that declares `agentOptions` wins, mirroring the
 * earlier-routes-first precedence of the candidate list.
 * @param config - the router configuration.
 * @param label - the delegated task's short description.
 * @returns the winning route's `agentOptions`, or undefined when no matching
 * route declares any (the caller falls back to the global `agentOptions`).
 */
export function matchRouteAgentOptions(config: Config, label: string): AgentOptions | undefined {
  for (const route of matchingRoutes(config, label)) {
    if (route.agentOptions !== undefined) return route.agentOptions
  }
  return undefined
}

/** Yield every configured route whose label matches the delegation, in config order. */
function* matchingRoutes(config: Config, label: string): Generator<RoutePolicy> {
  const needle = label.toLowerCase()
  for (const route of config.routes ?? []) {
    if (needle.includes(route.label.toLowerCase())) yield route
  }
}

/**
 * Resolve the first registered provider that can serve the delegation.
 * Providers may register later than the plugin (sibling load order and HMR),
 * so resolution runs at call time against the live registry.
 * @param ctx - the Cordis context carrying the subagent service.
 * @param candidates - ordered provider candidates.
 * @param needed - the capabilities the delegation requires.
 * @returns the resolved provider name.
 * @throws when no candidate is registered or none supports the required
 * capabilities, with the candidates tried and the missing capabilities.
 */
export function resolveProvider(ctx: Context, candidates: readonly string[], needed: NeededCapabilities): string {
  const registered: string[] = []
  for (const name of candidates) {
    const provider = ctx.subagents.getProvider(name)
    if (provider === undefined) continue
    registered.push(name)
    if (satisfiesCapabilities(provider.capabilities, needed)) return name
  }
  if (registered.length === 0) {
    throw new Error(
      `no subagent provider can serve this delegation: none of the configured providers (${candidates.join(', ')}) are currently registered`,
    )
  }
  const missing = requiredCapabilityNames(needed)
  throw new Error(
    `no subagent provider can serve this delegation: providers (${registered.join(', ')}) do not support the required `
    + `${missing.length === 1 ? 'capability' : 'capabilities'} (${missing.join(', ')})`,
  )
}

/** The names of the capabilities this delegation requires, in contract order. */
function requiredCapabilityNames(needed: NeededCapabilities): string[] {
  const names: string[] = []
  if (needed.persona) names.push('persona')
  if (needed.toolFilter) names.push('toolFilter')
  if (needed.depthLimit) names.push('depthLimit')
  return names
}
