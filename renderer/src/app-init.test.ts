import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  changeLanguage: vi.fn(),
  getConfigState: vi.fn(() => ({ theme: 'lighting', language: 'zh' })),
  getSkin: vi.fn((): unknown => undefined),
  setSkinsState: vi.fn(),
  initActiveSkin: vi.fn(async () => undefined),
  loadSkins: vi.fn(async () => undefined),
  initAppearance: vi.fn(),
  loadAppearance: vi.fn(async () => undefined),
  initBrand: vi.fn(),
  loadBrand: vi.fn(async () => undefined)
}))

vi.mock('@/lang', () => ({ default: { changeLanguage: mocks.changeLanguage } }))
vi.mock('@/store/config', () => ({
  useConfigStore: { getState: mocks.getConfigState }
}))
vi.mock('@/store/skins', () => ({
  useSkinsStore: {
    getState: () => ({
      getSkin: mocks.getSkin,
      initActiveSkin: mocks.initActiveSkin,
      loadFromDisk: mocks.loadSkins,
      revision: 0
    }),
    setState: mocks.setSkinsState
  }
}))
vi.mock('@/store/brandAppearance', () => ({
  useBrandAppearanceStore: {
    getState: () => ({ initAppearance: mocks.initAppearance, loadFromDisk: mocks.loadAppearance }),
    setState: vi.fn()
  }
}))
vi.mock('@/store/brand', () => ({
  useBrandStore: { getState: () => ({ initBrand: mocks.initBrand, loadFromDisk: mocks.loadBrand }) }
}))
vi.mock('@/theme/skins/builtin', () => ({ DEFAULT_SKIN_ID: 'lighting' }))
vi.mock('@/theme/skins/scheme', () => ({ resolveInitialScheme: () => 'dark' }))
import { initApp } from './app-init'

beforeEach(() => {
  for (const value of Object.values(mocks)) value.mockClear()
  mocks.getConfigState.mockReturnValue({ theme: 'lighting', language: 'zh' })
  mocks.getSkin.mockReturnValue(undefined)
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  })
})

describe('app appearance startup', () => {
  it('always reapplies every appearance layer when one disk load rejects', async () => {
    mocks.loadSkins.mockRejectedValueOnce(new Error('skins.json corrupt'))

    await initApp()

    expect(mocks.loadSkins).toHaveBeenCalledOnce()
    expect(mocks.loadAppearance).toHaveBeenCalledOnce()
    expect(mocks.loadBrand).toHaveBeenCalledOnce()
    expect(mocks.initActiveSkin).toHaveBeenNthCalledWith(1, { finalizeMissing: false })
    expect(mocks.initActiveSkin).toHaveBeenNthCalledWith(2, { finalizeMissing: true })
    expect(mocks.initAppearance).toHaveBeenCalledTimes(2)
    expect(mocks.initBrand).toHaveBeenCalledTimes(2)
  })

  it('does not restore a retired legacy theme', async () => {
    mocks.getConfigState.mockReturnValue({ theme: 'china-red', language: 'zh' })

    await initApp()
    await initApp()

    const migrationCalls = mocks.setSkinsState.mock.calls.filter(([value]) => value?.activeSkinId === 'china-red')
    expect(migrationCalls).toHaveLength(0)
  })
})
