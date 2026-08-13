import { describe, expect, it } from 'vitest'
import { featureEnabled } from './settings'

describe('renderer feature parameters', () => {
  it('enables custom themes by default and accepts explicit off values', () => {
    expect(featureEnabled(undefined)).toBe(true)
    expect(featureEnabled('')).toBe(true)
    expect(featureEnabled('true')).toBe(true)
    expect(featureEnabled('1')).toBe(true)
    expect(featureEnabled('false')).toBe(false)
    expect(featureEnabled('0')).toBe(false)
    expect(featureEnabled('OFF')).toBe(false)
  })
})
