import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureFile } from '../src/measure.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

describe('AST-guided read token economy', () => {
  it('the guided path saves at least 85% of input tokens on the large fixture', async () => {
    const text = await readFile(join(fixturesDir, 'large-service.ts'), 'utf8')
    const result = measureFile('large-service.ts', text)
    expect(result.reductionPct).toBeGreaterThan(85)
  })

  it('the guided path always costs fewer tokens than a full read', async () => {
    const text = await readFile(join(fixturesDir, 'geometry.ts'), 'utf8')
    const result = measureFile('geometry.ts', text)
    expect(result.guidedTokens).toBeLessThan(result.naiveTokens)
    expect(result.reductionPct).toBeGreaterThan(0)
  })

  it('the focused read targets a real function span', async () => {
    const text = await readFile(join(fixturesDir, 'auth-service.ts'), 'utf8')
    const result = measureFile('auth-service.ts', text)
    expect(result.focused).not.toBe('<none>')
    // The guided path (outline + one focused read) still beats a full read.
    expect(result.guidedTokens).toBeLessThan(result.naiveTokens)
  })

  it('savings grow with file size — the outline is a fixed cost, the read is narrow', async () => {
    const large = await readFile(join(fixturesDir, 'large-service.ts'), 'utf8')
    const small = await readFile(join(fixturesDir, 'geometry.ts'), 'utf8')
    const largeResult = measureFile('large-service.ts', large)
    const smallResult = measureFile('geometry.ts', small)
    expect(largeResult.reductionPct).toBeGreaterThan(smallResult.reductionPct)
  })
})
