import { describe, expect, it } from 'vitest'
import settings, { featureEnabled } from './settings'

describe('renderer feature parameters', () => {
  it('uses the Profile-owned professional theme as the product default', () => {
    expect(settings.defaultTheme).toBe('profile:%40deepseek-ai%2Fdsh-theme-pack:professional-blue')
    expect(settings.enableCustomThemes).toBe(true)
  })

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
