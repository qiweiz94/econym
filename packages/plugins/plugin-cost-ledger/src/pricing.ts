/**
 * Price resolution for the cost ledger: a built-in table seeded from the
 * pi-ai `opencode-go` catalog's published rates, layered under per-deployment
 * overrides. Rates are US dollars per million tokens.
 * @module @econym/dsh-plugin-cost-ledger/pricing
 */

import type { ModelPricing } from './types.ts'

/**
 * Built-in rates for the catalog models the DeepSeek-harness routes most.
 * Seeded from the pi-ai opencode-go catalog data shipped with
 * `@earendil-works/pi-ai`; a deployment serving different models or tariffs
 * overrides entries through the plugin's own `pricing` config.
 */
export const BUILTIN_PRICING: Readonly<Record<string, ModelPricing>> = {
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  'glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'grok-4.5': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  'hy3': { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
  'kimi-k2.6': { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  'minimax-m2.7': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  'minimax-m3': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  'mimo-v2.5': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  'mimo-v2.5-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  'qwen3.6-plus': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  'qwen3.7-max': { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
}

/**
 * Resolve the effective price entry for one model id: the deployment override
 * wins over the built-in rate; an id covered by neither is unpriced.
 * @param modelId - the model id as attributed on the assistant message source.
 * @param overrides - deployment-supplied price entries keyed by model id.
 * @returns the effective pricing, or `undefined` when the model is unpriced.
 */
export function resolveModelPricing(
  modelId: string,
  overrides: Readonly<Record<string, ModelPricing>> | undefined,
): ModelPricing | undefined {
  return overrides?.[modelId] ?? BUILTIN_PRICING[modelId]
}
