import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveInitialScheme, systemScheme } from './scheme'

function mockTheme(mode: string | null, systemDark: boolean) {
  vi.stubGlobal('localStorage', {
    getItem: () => mode
  })
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: systemDark })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('initial skin scheme', () => {
  it('uses the persisted explicit scheme instead of the OS preference', () => {
    mockTheme('light', true)
    expect(resolveInitialScheme()).toBe('light')
  })

  it('resolves system mode from prefers-color-scheme', () => {
    mockTheme('system', true)
    expect(resolveInitialScheme()).toBe('dark')
    expect(systemScheme()).toBe('dark')
  })

  it('keeps the existing dark default when no preference was saved', () => {
    mockTheme(null, false)
    expect(resolveInitialScheme()).toBe('dark')
  })
})
