import { beforeEach, describe, expect, it, vi } from 'vitest'

const testStorage = vi.hoisted(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })
  return values
})
import { BrandNameError, DEFAULT_APP_NAME, useBrandStore } from './brand'
import { BrandAppearanceError, useBrandAppearanceStore } from './brandAppearance'

function ok(value: unknown) {
  return Promise.resolve({ ok: true, value })
}

beforeEach(() => {
  testStorage.clear()
  vi.restoreAllMocks()
  vi.stubGlobal('window', {
    electronAPI: {
      saveBrand: vi.fn((value) => ok(value)),
      loadBrand: vi.fn(),
      setBrandName: vi.fn(async (value) => value),
      saveBrandAppearance: vi.fn((value) => ok(value)),
      loadBrandAppearance: vi.fn()
    }
  })
  useBrandStore.setState({
    name: DEFAULT_APP_NAME,
    skinName: null,
    revision: 0,
    updatedAt: 0,
    persistenceError: null
  })
  useBrandAppearanceStore.setState({
    appearance: {},
    skinAppearance: null,
    scheme: 'light',
    revision: 0,
    updatedAt: 0,
    persistenceError: null
  })
})

describe('brand name layers', () => {
  it('migrates the former default name to dsh-work and rewrites the disk value', async () => {
    ;(window as any).electronAPI.loadBrand = vi.fn(async () => ({
      status: 'valid',
      value: {
        schema_version: 1,
        revision: 4,
        updated_at: 40,
        name: 'DeepSeek Harness'
      }
    }))

    await useBrandStore.getState().loadFromDisk()

    expect(useBrandStore.getState().name).toBe('dsh-work')
    expect(useBrandStore.getState().revision).toBe(5)
    expect((window as any).electronAPI.saveBrand).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'dsh-work',
      revision: 5
    }))
  })

  it('never persists a temporary skin name and restores the saved user name', async () => {
    useBrandStore.getState().setSkinName('皮肤名称')
    expect(useBrandStore.getState().effectiveName()).toBe('皮肤名称')

    await useBrandStore.getState().setName('用户名称')
    expect(useBrandStore.getState().effectiveName()).toBe('用户名称')
    expect((window as any).electronAPI.saveBrand).toHaveBeenLastCalledWith(expect.objectContaining({
      name: '用户名称'
    }))
    expect(JSON.stringify((window as any).electronAPI.saveBrand.mock.calls)).not.toContain('皮肤名称')

    useBrandStore.getState().setSkinName(null)
    expect(useBrandStore.getState().effectiveName()).toBe('用户名称')
  })

  it('rolls back a user name when its disk save fails', async () => {
    ;(window as any).electronAPI.saveBrand = vi.fn(async () => ({ ok: false, error: { message: '只读磁盘' } }))
    await expect(useBrandStore.getState().setName('新名称')).rejects.toThrow('只读磁盘')
    expect(useBrandStore.getState().name).toBe(DEFAULT_APP_NAME)
    expect(useBrandStore.getState().persistenceError).toBe('只读磁盘')
  })

  it('rejects a 33 character name before changing state or calling IPC', async () => {
    await expect(useBrandStore.getState().setName('x'.repeat(33))).rejects.toBeInstanceOf(BrandNameError)
    expect(useBrandStore.getState().name).toBe(DEFAULT_APP_NAME)
    expect((window as any).electronAPI.saveBrand).not.toHaveBeenCalled()
  })

  it('rolls two consecutive failed name saves back to the last confirmed name', async () => {
    ;(window as any).electronAPI.saveBrand = vi.fn(async () => ({
      ok: false,
      error: { message: '连续写入失败' }
    }))

    const results = await Promise.allSettled([
      useBrandStore.getState().setName('第一个名称'),
      useBrandStore.getState().setName('第二个名称')
    ])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(useBrandStore.getState().name).toBe(DEFAULT_APP_NAME)
    expect(useBrandStore.getState().revision).toBe(0)
  })
})

describe('brand appearance persistence boundary', () => {
  it('recognizes an appearance that only has a dark override when scheme is dark', () => {
    useBrandAppearanceStore.getState().setScheme('dark')
    useBrandAppearanceStore.getState().setSkinAppearance({ dark: { bgColor: '#123456' } })
    expect(useBrandAppearanceStore.getState().effectiveAppearance()).toEqual({ bgColor: '#123456' })
  })

  it('keeps explicit user overrides above both common and dark theme defaults', async () => {
    useBrandAppearanceStore.getState().setSkinAppearance({
      bgColor: '#111111',
      dark: { bgColor: '#222222', panelOpacity: 70 }
    })
    await useBrandAppearanceStore.getState().setAppearance({ bgColor: '#333333' })
    useBrandAppearanceStore.getState().setScheme('dark')
    expect(useBrandAppearanceStore.getState().effectiveAppearance()).toMatchObject({
      bgColor: '#333333',
      panelOpacity: 70
    })

    await useBrandAppearanceStore.getState().setAppearance({ dark: { bgColor: '#444444' } })
    expect(useBrandAppearanceStore.getState().effectiveAppearance().bgColor).toBe('#444444')
  })

  it('rejects unsafe values before they enter state or IPC', async () => {
    await expect(useBrandAppearanceStore.getState().setAppearance({
      bgImage: 'https://tracker.example/pixel.png'
    })).rejects.toBeInstanceOf(BrandAppearanceError)
    await expect(useBrandAppearanceStore.getState().setAppearance({
      bgColor: 'red'
    })).rejects.toBeInstanceOf(BrandAppearanceError)
    expect(useBrandAppearanceStore.getState().appearance).toEqual({})
    expect((window as any).electronAPI.saveBrandAppearance).not.toHaveBeenCalled()
  })

  it('normalizes short hex colors to the shared lowercase six-digit form', async () => {
    await useBrandAppearanceStore.getState().setAppearance({ bgColor: '#ABC' })
    expect(useBrandAppearanceStore.getState().appearance.bgColor).toBe('#aabbcc')
  })

  it('keeps local appearance when the disk file is corrupt', async () => {
    useBrandAppearanceStore.setState({
      appearance: { bgImage: 'aurora' },
      revision: 3,
      updatedAt: 30
    })
    ;(window as any).electronAPI.loadBrandAppearance = vi.fn(async () => ({
      status: 'corrupt',
      error: { message: '外观 JSON 损坏' }
    }))
    await expect(useBrandAppearanceStore.getState().loadFromDisk()).rejects.toThrow('外观 JSON 损坏')
    expect(useBrandAppearanceStore.getState().appearance).toEqual({ bgImage: 'aurora' })
  })

  it('rolls two consecutive failed appearance saves back to the last confirmed appearance', async () => {
    ;(window as any).electronAPI.saveBrandAppearance = vi.fn(async () => ({
      ok: false,
      error: { message: '连续写入失败' }
    }))

    const results = await Promise.allSettled([
      useBrandAppearanceStore.getState().setAppearance({ bgImage: 'aurora' }),
      useBrandAppearanceStore.getState().setAppearance({ bgImage: 'forest' })
    ])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(useBrandAppearanceStore.getState().appearance).toEqual({})
    expect(useBrandAppearanceStore.getState().revision).toBe(0)
  })
})
