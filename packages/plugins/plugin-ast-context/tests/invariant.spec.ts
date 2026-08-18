import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as Invariant from '../src/invariant.ts'

describe('plugin-ast-context invariant companion', () => {
  it('mounts and disposes without throwing (the installer owns no relations)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(Invariant)
    expect(fiber).toBeDefined()
    await fiber.dispose()
  })

  it('exposes the companion export shape with no stray default', () => {
    expect(Invariant.name).toBe('plugin-ast-context-invariant')
    expect(Invariant.inject).toEqual(['invariants'])
    expect(typeof Invariant.apply).toBe('function')
    expect('default' in Invariant).toBe(false)
  })
})
