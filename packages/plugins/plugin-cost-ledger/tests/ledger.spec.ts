import { describe, expect, it } from 'vitest'
import { CallId, createMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { foldLedger } from '../src/ledger.ts'

/** Append one assistant step carrying the given usage to the session. */
function appendAssistantUsage(
  session: Session,
  turn: number,
  provider: string,
  model: string,
  usage: SessionEvent<'assistant/message'>['data']['usage'],
): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider, model },
    }),
    ...(usage === undefined ? {} : { usage }),
  }, { surfaceOp: 'append' })
}

describe('foldLedger', () => {
  it('aggregates two models with built-in pricing and sums a whole-ledger total', () => {
    const session = Session.create(SessionId('ledger-two-models'))
    appendAssistantUsage(session, 1, 'opencode-go', 'deepseek-v4-flash',
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })
    appendAssistantUsage(session, 2, 'opencode-go', 'kimi-k2.6',
      { inputTokens: 500_000, outputTokens: 100_000 })

    const snapshot = foldLedger(session.events, undefined, [])

    expect(snapshot.unpricedModels).toEqual([])
    expect(snapshot.totals.estimatedCostUsd).not.toBeNull()
    // deepseek-v4-flash at builtin off-peak rates (peakHours disabled): (1M×0.22 + 1M×0.66 + 1M×0.007) / 1M = $0.887
    const flash = snapshot.models.find(m => m.model === 'deepseek-v4-flash')
    expect(flash?.estimatedCostUsd).toBe(0.887)
    // kimi-k2.6: (0.5M×0.95 + 0.1M×4) / 1M = $0.875
    const kimi = snapshot.models.find(m => m.model === 'kimi-k2.6')
    expect(kimi?.estimatedCostUsd).toBe(0.875)
    expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(0.887 + 0.875, 6)
    expect(snapshot.totals.requests).toBe(2)
  })

  it('lets a config override replace a built-in rate', () => {
    const session = Session.create(SessionId('ledger-override'))
    appendAssistantUsage(session, 1, 'opencode-go', 'deepseek-v4-flash',
      { inputTokens: 1_000_000, outputTokens: 0 })

    const snapshot = foldLedger(session.events, {
      'deepseek-v4-flash': { input: 1, output: 2 },
    })

    expect(snapshot.models[0]?.estimatedCostUsd).toBe(1)
  })

  it('prices a hand-declared model through a config entry and leaves unknown models unpriced', () => {
    const session = Session.create(SessionId('ledger-hand-declared'))
    appendAssistantUsage(session, 1, 'opencode-go', 'ox-alpha-free',
      { inputTokens: 250_000, outputTokens: 40_000 })
    appendAssistantUsage(session, 2, 'opencode-go', 'totally-unknown-model',
      { inputTokens: 999, outputTokens: 10 })

    const snapshot = foldLedger(session.events, {
      'ox-alpha-free': { input: 0.2, output: 1.2 },
    })

    expect(snapshot.unpricedModels).toEqual(['totally-unknown-model'])
    const alpha = snapshot.models.find(m => m.model === 'ox-alpha-free')
    // (0.25M×0.2 + 0.04M×1.2) / 1M = $0.098
    expect(alpha?.estimatedCostUsd).toBe(0.098)
    const unknown = snapshot.models.find(m => m.model === 'totally-unknown-model')
    expect(unknown?.estimatedCostUsd).toBeNull()
    // A partial total is reported as null rather than presented as whole.
    expect(snapshot.totals.estimatedCostUsd).toBeNull()
  })

  it('counts steps without reported usage as requests but never as cost', () => {
    const session = Session.create(SessionId('ledger-no-usage'))
    appendAssistantUsage(session, 1, 'opencode-go', 'deepseek-v4-flash', undefined)

    const snapshot = foldLedger(session.events, undefined)

    expect(snapshot.models).toHaveLength(0)
    expect(snapshot.totals.requests).toBe(0)
  })

  it('ignores user and tool messages entirely', () => {
    const session = Session.create(SessionId('ledger-non-assistant'))
    session.append('user/message', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'prompt' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 't1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'out' }] }],
        source: { kind: 'tool', callId: 'c1' },
      },
    }, { surfaceOp: 'append' })

    const snapshot = foldLedger(session.events, undefined)

    expect(snapshot.models).toHaveLength(0)
    expect(snapshot.totals.inputTokens).toBe(0)
  })

  it('prices a peak-hour event at the peak block and an off-peak event at the base rates', () => {
    // DeepSeek peak windows are 01:00-04:00 and 06:00-10:00 UTC. Anchor a fixed
    // timestamp so the fold's time selection is deterministic.
    const base = Date.UTC(2026, 7, 20, 0, 0, 0)
    const offPeakTime = base + 2 * 3_600_000 // 02:00 UTC — inside the first peak window
    const offHoursTime = base + 12 * 3_600_000 // 12:00 UTC — outside every window

    const snapshot = foldLedger([
      usageEvent(0, offPeakTime, 'deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
      usageEvent(1, offHoursTime, 'deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
    ], undefined)

    const flash = snapshot.models.find(m => m.model === 'deepseek-v4-flash')
    // Peak: (1M×0.44 + 1M×1.32 + 1M×0.014) / 1M = $1.774
    // Off-peak: (1M×0.22 + 1M×0.66 + 1M×0.007) / 1M = $0.887
    expect(flash?.estimatedCostUsd).toBeCloseTo(1.774 + 0.887, 6)
    expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(1.774 + 0.887, 6)
  })

  it('honors a custom peakHours override for deployments on another schedule', () => {
    const base = Date.UTC(2026, 7, 20, 0, 0, 0)
    const event = usageEvent(0, base + 14 * 3_600_000, 'deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 0 })

    // 14:00 UTC is outside DeepSeek's default windows, but inside the custom [13,16) window.
    const snapshot = foldLedger([event], undefined, [[13, 16]])

    // DeepSeek V4 Pro peak input: $1.32/M
    expect(snapshot.models[0]?.estimatedCostUsd).toBe(1.32)
  })

  it('prices an overridden model without a peak block at base rates in every window', () => {
    const base = Date.UTC(2026, 7, 20, 0, 0, 0)
    const event = usageEvent(0, base + 2 * 3_600_000, 'ox-alpha-free', { inputTokens: 1_000_000, outputTokens: 0 })

    const snapshot = foldLedger([event], { 'ox-alpha-free': { input: 0.2, output: 1.2 } })

    // The override declares no peak block, so the 02:00 UTC event prices at base input.
    expect(snapshot.models[0]?.estimatedCostUsd).toBe(0.2)
  })
})

/** Build one `assistant/message` usage event with a fixed timestamp. */
function usageEvent(
  seq: number,
  time: number,
  model: string,
  usage: NonNullable<SessionEvent<'assistant/message'>['data']['usage']>,
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: seq + 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'opencode-go', model },
      }),
      usage,
    },
  }
}
