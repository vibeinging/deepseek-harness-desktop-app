import { describe, expect, it } from 'vitest'
import {
  LONG_TURN_LOCATOR_HEIGHT,
  MAX_TURN_LOCATOR_TICKS,
  TURN_LOCATOR_TICK_PITCH,
  turnLocatorIndexAtPosition,
  turnLocatorMode,
  turnLocatorScrollTopForIndex,
  turnLocatorVisibleRange,
  type TurnLocatorMarker,
} from './TurnLocator'

const markers: TurnLocatorMarker[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `question-${index}`,
  title: `第 ${index + 1} 问`,
  excerpt: `问题 ${index + 1}`,
}))

describe('TurnLocator long conversation bounds', () => {
  it('keeps short conversations static and makes long conversations scrollable', () => {
    expect(turnLocatorMode(MAX_TURN_LOCATOR_TICKS)).toBe('ticks')
    expect(turnLocatorMode(MAX_TURN_LOCATOR_TICKS + 1)).toBe('scroll')
    expect(LONG_TURN_LOCATOR_HEIGHT).toBe(MAX_TURN_LOCATOR_TICKS * TURN_LOCATOR_TICK_PITCH)
  })

  it('keeps exactly MAX ticks in the virtual window at the start, middle, and end', () => {
    expect(turnLocatorVisibleRange(0, markers.length)).toEqual({ start: 0, end: 20 })
    expect(turnLocatorVisibleRange(5_000, markers.length)).toEqual({ start: 500, end: 520 })
    expect(turnLocatorVisibleRange(99_999, markers.length)).toEqual({ start: 980, end: 1_000 })
  })

  it('maps pointer position to the full marker collection without scanning rendered ticks', () => {
    expect(turnLocatorIndexAtPosition(12, 100, markers.length)).toBe(0)
    expect(turnLocatorIndexAtPosition(50, 100, markers.length)).toBe(500)
    expect(turnLocatorIndexAtPosition(88, 100, markers.length)).toBe(999)
  })

  it('centers the active tick while keeping scroll position inside the rail', () => {
    expect(turnLocatorScrollTopForIndex(0, markers.length)).toBe(0)
    expect(turnLocatorScrollTopForIndex(617, markers.length)).toBe(6_075)
    expect(turnLocatorScrollTopForIndex(999, markers.length)).toBe(9_800)
  })
})
