// Drives the REAL fork-in-process provider through a REAL AgentLoop with a
// scripted mock MODEL (packages/core/agent-loop/tests/mock-adapter.ts), so
// every session/event the governor observes (tool/call, tool/result,
// assistant/message) is produced by the real driver, not hand-built. Mirrors
// the mount order `subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts`
// uses to drive that same real backend.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime, { SubagentRunId, type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as governor from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** A test edit tool: `outcome: 'fail'` throws (→ an `isError` tool/result); otherwise it succeeds. */
function registerEditTool(context: Context): () => void {
  return context.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'test-only edit tool for churn/failure detector fixtures',
    parameters: {
      file_path: { type: 'string', required: true },
      outcome: { type: 'string' },
    },
    async execute(args) {
      if (args.outcome === 'fail') throw new Error(`edit failed: ${args.file_path}`)
      return [{ type: 'text', text: `edited ${args.file_path}` }]
    },
  }))
}

/** A test tool NOT named in any `editChurn.tools` fixture, to exercise the unrelated-tool skip. */
function registerNoopTool(context: Context): () => void {
  return context.tools.register(defineContentToolFixture({
    name: 'noop',
    description: 'test-only tool never tracked by editChurn config',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'noop done' }]
    },
  }))
}

/** Like `toolCallResponse`, but injects a raw (possibly non-JSON) arguments string. */
function rawToolCallResponse(rawCallId: string, name: string, rawArguments: string): StreamChunk[] {
  const callId = CallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: rawArguments },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: rawArguments } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function setup(script: Script, config: governor.Config) {
  const context = new Context()
  ctx = context
  await mountAgentLoopTestDependencies(context)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(SubagentRuntime)
  await context.plugin(fork, { providerName: 'fork' })
  await context.plugin(TokenMeter)
  await context.plugin(governor, config)
  registerEditTool(context)
  context.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = context.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { context, parent }
}

function start(context: Context, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return context.subagents.start('fork', { signal: request.signal ?? new AbortController().signal, ...request })
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

/**
 * `Agent.inject` only queues content for the parent's NEXT step — it does not
 * wake the driver (`send(input, 'next-step', false)`). Drive one ordinary
 * parent turn so the driver claims the queued termination report into the
 * session log, exactly as the real deployment's next parent step would.
 */
async function driveParentForward(parent: Agent): Promise<void> {
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await parent.whenIdle()
}

/** The plugin-sourced termination notice claimed into the parent's log, if any. */
function terminationNotices(parent: Agent): string[] {
  return parent.session.events
    .filter(e => e.type === 'user/message')
    .map(e => text(e.data.content))
    .filter(t => t.includes('terminated by the budget governor'))
}

describe('plugin-budget-governor real in-process termination', () => {
  it('terminates a run whose consecutive tool failures reach the ceiling and reports it to the parent', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
        toolCallResponse('c2', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
        textResponse('unreachable'),
        textResponse('ack'),
      ],
      { maxConsecutiveToolFailures: 2 },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await driveParentForward(parent)
    const notices = terminationNotices(parent)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('consecutive tool failures')
    await run.dispose()
  })

  it('does NOT terminate a run whose failures clear via an intervening success (real-composition clearing)', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
        toolCallResponse('c2', 'edit', { file_path: 'a.ts', outcome: 'ok' }),
        toolCallResponse('c3', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
        textResponse('done'),
      ],
      { maxConsecutiveToolFailures: 2 },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('done')
    expect(terminationNotices(parent)).toHaveLength(0)
    await run.dispose()
  })

  it('terminates a run whose same-file edit churn reaches the ceiling', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'hot.ts', outcome: 'ok' }),
        toolCallResponse('c2', 'edit', { file_path: 'hot.ts', outcome: 'ok' }),
        toolCallResponse('c3', 'edit', { file_path: 'hot.ts', outcome: 'ok' }),
        textResponse('unreachable'),
        textResponse('ack'),
      ],
      { editChurn: { maxSameFileEdits: 3, window: 5, tools: [{ name: 'edit', pathArgument: 'file_path' }] } },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await driveParentForward(parent)
    const notices = terminationNotices(parent)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('edits to hot.ts within the last 5 edit-tool calls (ceiling 3)')
    await run.dispose()
  })

  it('does NOT terminate a churn-healthy run that edits many distinct files (real-composition clearing)', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'ok' }),
        toolCallResponse('c2', 'edit', { file_path: 'b.ts', outcome: 'ok' }),
        toolCallResponse('c3', 'edit', { file_path: 'c.ts', outcome: 'ok' }),
        toolCallResponse('c4', 'edit', { file_path: 'd.ts', outcome: 'ok' }),
        textResponse('done'),
      ],
      { editChurn: { maxSameFileEdits: 3, window: 4, tools: [{ name: 'edit', pathArgument: 'file_path' }] } },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(terminationNotices(parent)).toHaveLength(0)
    await run.dispose()
  })

  it('terminates a run whose measured token surface exceeds the ceiling before its next step', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'x.ts', outcome: 'ok' }, 'thinking about it'),
        textResponse('unreachable'),
        textResponse('ack'),
      ],
      { maxChildTokens: 1 },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await driveParentForward(parent)
    const notices = terminationNotices(parent)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/context grew to ~\d+ tokens \(ceiling 1\)/)
    await run.dispose()
  })

  it('terminates a run only ONCE even when two ceilings trip on the very same tool call', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
        toolCallResponse('c2', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
        textResponse('unreachable'),
        textResponse('ack'),
      ],
      {
        maxConsecutiveToolFailures: 2,
        editChurn: { maxSameFileEdits: 2, window: 2, tools: [{ name: 'edit', pathArgument: 'file_path' }] },
      },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await driveParentForward(parent)
    // The second call's `tool/call` trips the churn ceiling first and marks
    // the run terminated; that same call's later `tool/result` — which would
    // otherwise also trip the failure ceiling — is never even evaluated,
    // because the run's terminated flag short-circuits the outer listener
    // before it reaches the failure detector. Only one termination fires.
    expect(terminationNotices(parent)).toHaveLength(1)
    await run.dispose()
  })

  it('HMR safety: disposing the governor fiber removes its listeners — a would-be trip no longer fires', async () => {
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    await context.plugin(SubagentRuntime)
    await context.plugin(fork, { providerName: 'fork' })
    await context.plugin(TokenMeter)
    const fiber = await context.plugin(governor, { maxConsecutiveToolFailures: 1 })
    registerEditTool(context)
    context.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
      textResponse('done'),
    ]))
    const parent = context.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })

    await fiber.dispose()

    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    // The ceiling would have tripped at the very first failure had the
    // listener survived disposal; instead the run completes normally.
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('done')
    expect(terminationNotices(parent)).toHaveLength(0)
    await run.dispose()
  })

  it('does NOT terminate a token-healthy run whose surface stays under a generous ceiling', async () => {
    const { context, parent } = await setup(
      [textResponse('a modestly sized reply')],
      { maxChildTokens: 1_000_000 },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(terminationNotices(parent)).toHaveLength(0)
    await run.dispose()
  })

  it('extractPath tolerates malformed JSON, a non-object root, and a non-string path value; unrelated tool calls are skipped', async () => {
    const { context, parent } = await setup(
      [
        // Malformed JSON: caught internally, contributes nothing to churn.
        rawToolCallResponse('c1', 'edit', 'not-json{'),
        // Valid JSON, but the root is an array, not an object.
        rawToolCallResponse('c2', 'edit', '[1,2,3]'),
        // Valid object, but the path argument is not a string.
        toolCallResponse('c3', 'edit', { file_path: 42 }),
        // A tool call to a tool NOT named in editChurn.tools — skipped outright.
        toolCallResponse('c4', 'noop', {}),
        textResponse('done'),
      ],
      { editChurn: { maxSameFileEdits: 5, window: 10, tools: [{ name: 'edit', pathArgument: 'file_path' }] } },
    )
    registerNoopTool(context)
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    // None of the four calls contributed a valid churn observation, so the
    // (unreachable at ceiling 5) churn ceiling never trips.
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('done')
    expect(terminationNotices(parent)).toHaveLength(0)
    await run.dispose()
  })

  it('does not deliver a parent report for a run whose child session carries no parent lineage', async () => {
    const context = new Context()
    ctx = context
    await mountAgentLoopTestDependencies(context)
    await context.plugin(AgentLoop, { agents: [] })
    await context.plugin(SubagentRuntime)
    await context.plugin(TokenMeter)
    await context.plugin(governor, { maxConsecutiveToolFailures: 1 })
    registerEditTool(context)
    context.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'fail' }),
      textResponse('unreachable'),
    ]))
    const warnSpy = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    // A freestanding agent, created directly rather than via a subagent
    // provider, carries no `parentSession` header — the same shape a
    // provider bug or a lineage-less test double would produce.
    const child = context.agentLoop.create(SessionId('orphan-child'), { provider: 'mock', model: 'mock' })
    expect(child.session.header.parentSession).toBeUndefined()
    context.emit('subagent/start', { runId: SubagentRunId('test-run'), provider: 'test', id: child.id, local: true })

    child.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await child.whenIdle()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('but its parent agent is not live; no termination report was delivered'),
    )
  })

  it('detector evaluation failures are caught, logged once per run, and never break session dispatch', async () => {
    const { context, parent } = await setup(
      [
        toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'ok' }),
        toolCallResponse('c2', 'edit', { file_path: 'a.ts', outcome: 'ok' }),
        textResponse('done'),
      ],
      // High enough that it never trips through the legitimate calls below —
      // the run's survival to `completed` proves dispatch kept going.
      { maxConsecutiveToolFailures: 100 },
    )
    const warnSpy = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const child = context.agents.get(run.id)!

    // Simulate a malformed session event reaching the listener directly (a
    // defensive fault the real driver never legitimately produces, but the
    // catch/warn-once discipline must contain regardless).
    const malformed = { type: 'tool/result', seq: 999, time: Date.now(), data: { turn: 0, step: 0, message: { content: [] } } } as unknown as SessionEvent
    context.emit('session/event', child.session, malformed)
    context.emit('session/event', child.session, malformed)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('detector evaluation failed for child'))

    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('done')
    await run.dispose()
  })

  it('a caught fault that is not an Error instance is still logged via String(error)', async () => {
    const { context, parent } = await setup(
      [textResponse('irrelevant')],
      { maxConsecutiveToolFailures: 100 },
    )
    const warnSpy = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const child = context.agents.get(run.id)!
    const nonErrorFault = {
      type: 'tool/result',
      seq: 999,
      time: Date.now(),
      get data(): never { throw 'boom (non-Error fault)' },
    } as unknown as SessionEvent
    context.emit('session/event', child.session, nonErrorFault)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom (non-Error fault)'))
    await run.result
    await run.dispose()
  })

  it('reports a consecutive-failure termination with no "last failing tool" detail when the call was never observed', async () => {
    const { context, parent } = await setup(
      [textResponse('irrelevant')],
      { maxConsecutiveToolFailures: 1 },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const child = context.agents.get(run.id)!
    // A tool/result for a callId that was never announced via `tool/call` on
    // this run (e.g. events arriving out of order): the failure ceiling
    // still trips, but with no tool name to attribute it to.
    const orphanResult = {
      type: 'tool/result',
      seq: 999,
      time: Date.now(),
      data: { turn: 0, step: 0, message: { content: [{ toolCallId: CallId('unseen-call'), isError: true }] } },
    } as unknown as SessionEvent
    context.emit('session/event', child.session, orphanResult)
    await driveParentForward(parent)
    const notices = terminationNotices(parent)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('1 consecutive tool failures (ceiling 1)')
    expect(notices[0]).not.toContain('last failing tool')
    await run.result
    await run.dispose()
  })

  it('subagent/end releases the run state — a settled child is no longer governed', async () => {
    const { context, parent } = await setup(
      [toolCallResponse('c1', 'edit', { file_path: 'a.ts', outcome: 'ok' }), textResponse('done')],
      { maxConsecutiveToolFailures: 1 },
    )
    const run = await start(context, { prompt: [{ type: 'text', text: 'child q' }], parent })
    const child = context.agents.get(run.id)!
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    await run.dispose()

    const warnSpy = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    // The run settled and `subagent/end` fired, deleting its tracked state.
    // Feeding the exact fault that would trip `maxConsecutiveToolFailures: 1`
    // on a still-tracked run must now produce nothing at all: no notice, no
    // detector-evaluation warning — the session/event listener's `runs.get`
    // lookup misses entirely.
    const lateFailure = {
      type: 'tool/result',
      seq: 999,
      time: Date.now(),
      data: { turn: 0, step: 0, message: { content: [{ toolCallId: CallId('late-call'), isError: true }] } },
    } as unknown as SessionEvent
    context.emit('session/event', child.session, lateFailure)
    await driveParentForward(parent)
    expect(terminationNotices(parent)).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
