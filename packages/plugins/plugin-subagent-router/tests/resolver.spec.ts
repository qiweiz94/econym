import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { Config } from '../src/index.ts'
import { matchRouteAgentOptions, matchRouteCandidates, neededCapabilities, resolveProvider, satisfiesCapabilities } from '../src/resolver.ts'

const FULL: SubagentProvider = {
  name: 'full',
  capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  inheritsParentContext: false,
  start: async () => { throw new Error('unused in resolver tests') },
}

const MINIMAL: SubagentProvider = {
  name: 'minimal',
  capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  start: async () => { throw new Error('unused in resolver tests') },
}

function fakeContext(providers: Record<string, SubagentProvider>): Context {
  return { subagents: { getProvider: (name: string) => providers[name] } } as unknown as Context
}

describe('plugin-subagent-router resolver', () => {
  it('derives capability needs from the configured request options', () => {
    expect(neededCapabilities({})).toEqual({ persona: false, toolFilter: false, depthLimit: false })
    expect(neededCapabilities({ persona: 'x' })).toEqual({ persona: true, toolFilter: false, depthLimit: false })
    expect(neededCapabilities({ toolFilter: { allow: ['a'] } })).toEqual({ persona: false, toolFilter: true, depthLimit: false })
    expect(neededCapabilities({ maxDepth: 3 })).toEqual({ persona: false, toolFilter: false, depthLimit: true })
    // A provider-managed depth cap imposes no depthLimit requirement.
    expect(neededCapabilities({ maxDepth: 'provider-managed' })).toEqual({ persona: false, toolFilter: false, depthLimit: false })
  })

  it('checks provider capabilities against the required mask', () => {
    expect(satisfiesCapabilities(FULL.capabilities, { persona: true, toolFilter: true, depthLimit: true })).toBe(true)
    expect(satisfiesCapabilities(MINIMAL.capabilities, { persona: true, toolFilter: false, depthLimit: false })).toBe(false)
    // A provider need not advertise capabilities the request never uses.
    expect(satisfiesCapabilities(MINIMAL.capabilities, { persona: false, toolFilter: false, depthLimit: false })).toBe(true)
  })

  it('matches a delegated task label to the configured routes, case-insensitively', () => {
    const config: Config = {
      providers: ['spawn'],
      routes: [{ label: 'summarize', providers: ['codex'] }],
    }
    expect(matchRouteCandidates(config, 'Summarize the meeting notes')).toEqual(['codex'])
    expect(matchRouteCandidates(config, 'refactor the module')).toBeUndefined()
  })

  it('flattens every matching route in config order', () => {
    const config: Config = {
      providers: ['spawn'],
      routes: [
        { label: 'summarize', providers: ['codex', 'claude'] },
        { label: 'meeting', providers: ['opus'] },
        { label: 'unrelated', providers: ['gemini'] },
      ],
    }
    // Both routes match; the non-matching route is skipped; per-route order holds.
    expect(matchRouteCandidates(config, 'Summarize the meeting notes')).toEqual(['codex', 'claude', 'opus'])
  })

  it('deduplicates a provider listed by several matching routes', () => {
    const config: Config = {
      providers: ['spawn'],
      routes: [
        { label: 'summarize', providers: ['codex', 'claude'] },
        { label: 'meeting', providers: ['codex'] },
        { label: 'notes', providers: ['opus', 'claude'] },
      ],
    }
    expect(matchRouteCandidates(config, 'Summarize the meeting notes')).toEqual(['codex', 'claude', 'opus'])
  })

  it('resolves the first registered provider that satisfies the needs', () => {
    const ctx = fakeContext({ full: FULL, minimal: MINIMAL })
    expect(resolveProvider(ctx, ['minimal', 'full'], { persona: true, toolFilter: false, depthLimit: false })).toBe('full')
    expect(resolveProvider(ctx, ['missing', 'minimal'], { persona: false, toolFilter: false, depthLimit: false })).toBe('minimal')
  })

  it('fails loud when none of the configured providers are registered', () => {
    const ctx = fakeContext({})
    expect(() => resolveProvider(ctx, ['ghost', 'void'], { persona: false, toolFilter: false, depthLimit: false }))
      .toThrow(/none of the configured providers \(ghost, void\) are currently registered/)
  })

  it('fails loud naming the missing capabilities when no registered provider is capable', () => {
    const ctx = fakeContext({ minimal: MINIMAL })
    expect(() => resolveProvider(ctx, ['minimal'], { persona: true, toolFilter: true, depthLimit: true }))
      .toThrow(/providers \(minimal\) do not support the required capabilities \(persona, toolFilter, depthLimit\)/)
  })

  it('matches nothing when the config carries no routes key at all', () => {
    expect(matchRouteCandidates({ providers: ['solo'] }, 'any label'))
      .toBeUndefined()
  })

  it('resolves per-route agentOptions from the first matching route that declares any', () => {
    const options = { provider: 'p', model: 'm', maxTokens: 8 }
    const config = {
      providers: ['solo'],
      routes: [
        { label: 'probe', providers: ['a'] },
        { label: 'probe', providers: ['b'], agentOptions: options },
        { label: 'probe', providers: ['c'], agentOptions: { provider: 'x', model: 'y', maxTokens: 9 } },
      ],
    }
    expect(matchRouteAgentOptions(config, 'run the probe')).toEqual(options)
    expect(matchRouteAgentOptions(config, 'no match here')).toBeUndefined()
    expect(matchRouteAgentOptions({ providers: ['solo'] }, 'run the probe')).toBeUndefined()
  })
})
