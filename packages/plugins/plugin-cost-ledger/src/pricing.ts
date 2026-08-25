/**
 * Price resolution for the cost ledger: a built-in table seeded from the
 * pi-ai `opencode-go` catalog's published rates, layered under per-deployment
 * overrides. Rates are US dollars per million tokens, with optional peak-hour
 * blocks for providers that bill time-of-day (DeepSeek's peak schedule).
 * @module @econym/dsh-plugin-cost-ledger/pricing
 */

import type { ModelPricing } from './types.ts'

/**
 * UTC hour windows during which a provider bills peak rates. Ranges are
 * [startHour, endHour) — a request at exactly `endHour` is off-peak. DeepSeek's
 * published peak windows are 01:00-04:00 and 06:00-10:00 UTC; a deployment on a
 * different schedule overrides via the plugin's `peakHours` config.
 */
export const DEEPSEEK_PEAK_HOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
]

/**
 * Built-in rates for the catalog models the DeepSeek-harness routes most.
 * Seeded from the pi-ai opencode-go catalog data shipped with
 * `@earendil-works/pi-ai`, refreshed against DeepSeek's published
 * peak/off-peak schedule (2026-08-16: peak is exactly double off-peak on every
 * token type, and a cache hit bills at ~3% of the uncached input rate). A
 * deployment serving different models or tariffs overrides entries through the
 * plugin's own `pricing` config.
 */
export const BUILTIN_PRICING: Readonly<Record<string, ModelPricing>> = {
  'deepseek-v4-flash': {
    input: 0.22,
    output: 0.66,
    cacheRead: 0.007,
    peak: { input: 0.44, output: 1.32, cacheRead: 0.014 },
  },
  'deepseek-v4-pro': {
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
  },
  'glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  'grok-4.5': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  'hy3': { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
  'kimi-k2.6': { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  'minimax-m2.7': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  'minimax-m3': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  'mimo-v2.5': {
    input: 0.22,
    output: 0.66,
    cacheRead: 0.007,
    peak: { input: 0.44, output: 1.32, cacheRead: 0.014 },
  },
  'mimo-v2.5-pro': {
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
  },
  'qwen3.6-plus': { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  'qwen3.7-max': { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
}

/**
 * Whether an epoch-millisecond timestamp falls inside any configured peak
 * window. Windows are UTC hour ranges `[start, end)`; a timestamp's UTC hour
 * landing in a window counts as peak.
 * @param time - the event timestamp in epoch milliseconds.
 * @param peakHours - the deployment's peak-hour windows; defaults to DeepSeek's.
 * @returns `true` when the timestamp's UTC hour lies in a peak window.
 */
export function isPeakHour(
  time: number,
  peakHours: ReadonlyArray<readonly [number, number]> = DEEPSEEK_PEAK_HOURS,
): boolean {
  const hour = new Date(time).getUTCHours()
  return peakHours.some(([start, end]) => hour >= start && hour < end)
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

/**
 * Resolve the pricing that applies to one event at one instant: the peak block
 * during a peak hour, otherwise the base (off-peak) rates. Models without a
 * `peak` block bill at base rates regardless of the hour. The returned entry
 * carries its own `peak` (for recursive callers) — consumers price tokens
 * against this entry directly.
 * @param entry - the resolved model pricing (base or overridden).
 * @param time - the event timestamp in epoch milliseconds.
 * @param peakHours - the deployment's peak-hour windows; defaults to DeepSeek's.
 * @returns the entry to price this event's tokens against.
 */
export function pricingForTime(
  entry: ModelPricing,
  time: number,
  peakHours: ReadonlyArray<readonly [number, number]> = DEEPSEEK_PEAK_HOURS,
): ModelPricing {
  if (entry.peak === undefined) return entry
  return isPeakHour(time, peakHours) ? { ...entry, ...entry.peak } : entry
}
