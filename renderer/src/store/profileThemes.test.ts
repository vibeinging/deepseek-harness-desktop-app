import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })
})

vi.mock('@/api/plugins', () => ({ listPluginCatalogReq: vi.fn() }))

import { listPluginCatalogReq } from '@/api/plugins'
import { useSkinsStore } from '@/store/skins'
import {
  normalizeProfileThemeCatalog,
  refreshProfileThemes,
  resetProfileThemeRefreshForTests
} from './profileThemes'

const profileTheme = {
  id: 'profile:%40demo%2Ftheme-pack:ocean',
  manifest_id: 'ocean',
  name: 'Ocean',
  builtIn: false,
  source: 'profile' as const,
  base: 'lighting',
  vars: { '--el-color-primary': '#336699' },
  mantineColors: [
    '#eef5fb', '#dceaf5', '#bad5eb', '#98c0e0', '#76abd6',
    '#5496cc', '#336699', '#294f77', '#1f3c5a', '#15283c'
  ],
  source_bundle: { package_name: '@demo/theme-pack', name: 'Theme Pack' }
}

describe('Profile theme catalog projection', () => {
  beforeEach(() => {
    vi.mocked(listPluginCatalogReq).mockReset()
    resetProfileThemeRefreshForTests()
    useSkinsStore.setState({ setProfileThemes: vi.fn(async () => undefined) })
  })

  it('requires an explicit full Profile theme array', () => {
    expect(normalizeProfileThemeCatalog({ data: {
      profile_themes: [profileTheme],
      profile_theme_errors: [{ message: 'bad descriptor' }]
    } })).toEqual({
      authoritative: true,
      profile_themes: [profileTheme],
      profile_theme_errors: [{ message: 'bad descriptor' }]
    })
    expect(() => normalizeProfileThemeCatalog({ data: {} })).toThrow(/profile_themes/)
  })

  it('commits a successful empty snapshot as authoritative and forwards descriptor warnings', async () => {
    vi.mocked(listPluginCatalogReq).mockResolvedValueOnce({
      data: {
        profile_themes: [],
        profile_theme_errors: [{ message: 'broken Bundle descriptor' }]
      }
    } as never)

    await refreshProfileThemes()

    expect(useSkinsStore.getState().setProfileThemes).toHaveBeenCalledWith([], {
      authoritative: true,
      warnings: ['broken Bundle descriptor']
    })
  })

  it('does not replace the last snapshot when the catalog request fails', async () => {
    vi.mocked(listPluginCatalogReq).mockRejectedValueOnce(new Error('catalog unavailable'))

    await expect(refreshProfileThemes()).rejects.toThrow(/catalog unavailable/)
    expect(useSkinsStore.getState().setProfileThemes).not.toHaveBeenCalled()
  })

  it('lets a forced refresh supersede an older in-flight response', async () => {
    let resolveOld: (value: unknown) => void = () => undefined
    let resolveCurrent: (value: unknown) => void = () => undefined
    vi.mocked(listPluginCatalogReq)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }) as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCurrent = resolve }) as never)

    const oldRequest = refreshProfileThemes()
    const currentRequest = refreshProfileThemes(true)
    resolveOld({ data: { profile_themes: [profileTheme], profile_theme_errors: [] } })
    await oldRequest
    expect(useSkinsStore.getState().setProfileThemes).not.toHaveBeenCalled()

    resolveCurrent({ data: { profile_themes: [], profile_theme_errors: [] } })
    await currentRequest
    expect(useSkinsStore.getState().setProfileThemes).toHaveBeenCalledOnce()
    expect(useSkinsStore.getState().setProfileThemes).toHaveBeenCalledWith([], {
      authoritative: true,
      warnings: []
    })
  })
})
