import { describe, expect, it } from 'vitest'
import { ConsecutiveFailureCounter, EditChurnWindow } from '../src/detectors.ts'

describe('ConsecutiveFailureCounter', () => {
  it('trips exactly at the configured ceiling, not before', () => {
    const counter = new ConsecutiveFailureCounter(3)
    expect(counter.observe(true)).toBe(false)
    expect(counter.current).toBe(1)
    expect(counter.observe(true)).toBe(false)
    expect(counter.current).toBe(2)
    expect(counter.observe(true)).toBe(true)
    expect(counter.current).toBe(3)
  })

  it('stays tripped (>= ceiling) on further failures past the trip point', () => {
    const counter = new ConsecutiveFailureCounter(2)
    counter.observe(true)
    expect(counter.observe(true)).toBe(true)
    expect(counter.observe(true)).toBe(true)
    expect(counter.current).toBe(3)
  })

  it('CLEARS on a single success: a healthy history that recovers never trips', () => {
    const counter = new ConsecutiveFailureCounter(3)
    counter.observe(true)
    counter.observe(true)
    // One success before the ceiling resets the run to zero.
    expect(counter.observe(false)).toBe(false)
    expect(counter.current).toBe(0)
    // Two more failures alone (below ceiling) do not trip.
    expect(counter.observe(true)).toBe(false)
    expect(counter.observe(true)).toBe(false)
    expect(counter.current).toBe(2)
  })

  it('a known-HEALTHY alternating success/failure history never trips', () => {
    const counter = new ConsecutiveFailureCounter(2)
    for (let i = 0; i < 20; i++) {
      expect(counter.observe(i % 2 === 0)).toBe(false)
    }
    expect(counter.current).toBe(0)
  })
})

describe('EditChurnWindow', () => {
  it('trips when one path accounts for the ceiling within the window', () => {
    const window = new EditChurnWindow(3, 5)
    expect(window.observe('a.ts')).toBe(false)
    expect(window.observe('b.ts')).toBe(false)
    expect(window.observe('a.ts')).toBe(false)
    expect(window.current).toBe(2)
    expect(window.observe('a.ts')).toBe(true)
    expect(window.current).toBe(3)
  })

  it('CLEARS as older entries fall out of the bounded window', () => {
    const window = new EditChurnWindow(3, 3)
    window.observe('a.ts')
    window.observe('a.ts')
    // Window size 3: pushing distinct-file edits displaces the earlier 'a.ts' entries.
    expect(window.observe('b.ts')).toBe(false)
    expect(window.observe('c.ts')).toBe(false)
    expect(window.observe('d.ts')).toBe(false)
    // Window now holds exactly [b.ts, c.ts, d.ts]; no path repeats.
    expect(window.current).toBe(1)
  })

  it('a known-HEALTHY round-robin across many files never trips', () => {
    const window = new EditChurnWindow(3, 4)
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
    for (let i = 0; i < 40; i++) {
      expect(window.observe(files[i % files.length]!)).toBe(false)
    }
  })

  it('a known-BAD run that keeps re-editing one file trips and stays tripped', () => {
    const window = new EditChurnWindow(2, 4)
    expect(window.observe('hot.ts')).toBe(false)
    expect(window.observe('hot.ts')).toBe(true)
    expect(window.observe('hot.ts')).toBe(true)
    expect(window.current).toBe(3)
  })
})
