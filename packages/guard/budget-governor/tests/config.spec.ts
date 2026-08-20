import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'
import type { Config } from '../src/index.ts'

describe('resolveConfig fail-loud validation', () => {
  it('rejects a config with no ceiling at all', () => {
    expect(() => resolveConfig({})).toThrow(/no ceiling is configured/)
  })

  it('accepts a config with exactly one ceiling', () => {
    expect(resolveConfig({ maxChildTokens: 100 })).toEqual({ maxChildTokens: 100 })
  })

  it.each([
    ['maxChildTokens', { maxChildTokens: 0 }],
    ['maxChildTokens', { maxChildTokens: 1.5 }],
    ['maxChildTokens', { maxChildTokens: -1 }],
    ['maxConsecutiveToolFailures', { maxConsecutiveToolFailures: 0 }],
    ['maxConsecutiveToolFailures', { maxConsecutiveToolFailures: 2.2 }],
  ] satisfies [string, Config][])('rejects an invalid %s ceiling', (field, config) => {
    expect(() => resolveConfig(config)).toThrow(new RegExp(`invalid ${field}`))
  })

  it('rejects editChurn.maxSameFileEdits below 2 (a run cannot re-edit the same file once and churn)', () => {
    expect(() => resolveConfig({
      editChurn: { maxSameFileEdits: 1, window: 5, tools: [{ name: 'edit', pathArgument: 'file_path' }] },
    })).toThrow(/invalid editChurn\.maxSameFileEdits/)
  })

  it('rejects editChurn.window below 2', () => {
    expect(() => resolveConfig({
      editChurn: { maxSameFileEdits: 2, window: 1, tools: [{ name: 'edit', pathArgument: 'file_path' }] },
    })).toThrow(/invalid editChurn\.window/)
  })

  it('rejects a window smaller than maxSameFileEdits (the ceiling could never trip)', () => {
    expect(() => resolveConfig({
      editChurn: { maxSameFileEdits: 5, window: 3, tools: [{ name: 'edit', pathArgument: 'file_path' }] },
    })).toThrow(/window 3 is smaller than.*maxSameFileEdits 5/)
  })

  it('rejects an empty editChurn.tools list', () => {
    expect(() => resolveConfig({
      editChurn: { maxSameFileEdits: 2, window: 4, tools: [] },
    })).toThrow(/at least one edit tool/)
  })

  it('rejects an editChurn tool with an empty name', () => {
    expect(() => resolveConfig({
      editChurn: { maxSameFileEdits: 2, window: 4, tools: [{ name: '', pathArgument: 'file_path' }] },
    })).toThrow(/non-empty `name` and `pathArgument`/)
  })

  it('rejects an editChurn tool with an empty pathArgument', () => {
    expect(() => resolveConfig({
      editChurn: { maxSameFileEdits: 2, window: 4, tools: [{ name: 'edit', pathArgument: '' }] },
    })).toThrow(/non-empty `name` and `pathArgument`/)
  })

  it('rejects duplicate editChurn tool names', () => {
    expect(() => resolveConfig({
      editChurn: {
        maxSameFileEdits: 2,
        window: 4,
        tools: [{ name: 'edit', pathArgument: 'file_path' }, { name: 'edit', pathArgument: 'other' }],
      },
    })).toThrow(/duplicate editChurn tool "edit"/)
  })

  it('accepts a fully populated multi-ceiling config and folds tools into a lookup map', () => {
    const resolved = resolveConfig({
      maxChildTokens: 1000,
      maxConsecutiveToolFailures: 3,
      editChurn: {
        maxSameFileEdits: 2,
        window: 4,
        tools: [{ name: 'edit', pathArgument: 'file_path' }, { name: 'write', pathArgument: 'path' }],
      },
    })
    expect(resolved.maxChildTokens).toBe(1000)
    expect(resolved.maxConsecutiveToolFailures).toBe(3)
    expect(resolved.editChurn?.maxSameFileEdits).toBe(2)
    expect(resolved.editChurn?.window).toBe(4)
    expect(resolved.editChurn?.tools.get('edit')).toBe('file_path')
    expect(resolved.editChurn?.tools.get('write')).toBe('path')
  })
})
