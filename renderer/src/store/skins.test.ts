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
import { DEFAULT_PROFILE_SKIN_ID, DEFAULT_SKIN_ID } from '@/theme/skins/builtin'
import settings from '@/settings'
import { deriveMantineColors } from '@/theme/skins/colors'
import { normalizeSkinDefinition, parseSkinFile } from '@/theme/skins/import'
import { useBrandAppearanceStore } from './brandAppearance'
import { DEFAULT_APP_NAME, useBrandStore } from './brand'
import { MAX_USER_SKINS, useSkinsStore } from './skins'

const primary = '#336699'

function userSkin(id: string, appearance: Record<string, unknown> = {}) {
  return normalizeSkinDefinition({
    id,
    name: id,
    vars: { '--el-color-primary': primary },
    mantineColors: deriveMantineColors(primary),
    ...(Object.keys(appearance).length > 0 ? { appearance } : {})
  })
}

function profileTheme(id: string) {
  return {
    id,
    manifest_id: 'ocean',
    name: 'Profile Ocean',
    base: DEFAULT_SKIN_ID,
    vars: { '--el-color-primary': primary },
    mantineColors: deriveMantineColors(primary),
    source_bundle: { package_name: '@demo/theme-pack', name: '@demo/theme-pack' }
  } as any
}

function ok(value: unknown) {
  return Promise.resolve({ ok: true, value })
}

beforeEach(() => {
  settings.enableCustomThemes = true
  testStorage.clear()
  vi.restoreAllMocks()
  vi.stubGlobal('window', {
    electronAPI: {
      saveSkins: vi.fn((value) => ok(value)),
      saveBrand: vi.fn((value) => ok(value)),
      saveBrandAppearance: vi.fn((value) => ok(value)),
      setBrandName: vi.fn(async (value) => value)
    }
  })
  useSkinsStore.setState({
    userSkins: [],
    profileThemes: [],
    activeSkinId: DEFAULT_PROFILE_SKIN_ID,
    fallbackSkinId: DEFAULT_SKIN_ID,
    appliedSkinId: DEFAULT_SKIN_ID,
    previewSkin: null,
    scheme: 'light',
    profileCatalogReady: false,
    diskLoadComplete: false,
    profileThemeWarnings: [],
    revision: 0,
    updatedAt: 0,
    persistenceError: null
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

describe('active skin transaction', () => {
  it('switches theme appearance without changing the independently saved app name', async () => {
    await useBrandStore.getState().setName('我的工作台')
    const skin = userSkin('named-ocean', { bgImage: 'aurora' })
    await useSkinsStore.getState().addUserSkin(skin)
    await useSkinsStore.getState().setActiveSkin(skin.id)

    expect(useSkinsStore.getState().appliedSkinId).toBe(skin.id)
    expect(useBrandAppearanceStore.getState().skinAppearance).toMatchObject({ bgImage: 'aurora' })
    expect(useBrandStore.getState().name).toBe('我的工作台')
    expect(useBrandStore.getState().skinName).toBeNull()
    expect(useBrandStore.getState().effectiveName()).toBe('我的工作台')

    await useSkinsStore.getState().setActiveSkin(DEFAULT_SKIN_ID)
    expect(useBrandAppearanceStore.getState().skinAppearance).toBeNull()
    expect(useBrandStore.getState().skinName).toBeNull()
    expect(useBrandStore.getState().effectiveName()).toBe('我的工作台')
  })

  it('reapplies all derived state after editing and deleting the active user skin', async () => {
    const skin = userSkin('editable-ocean', { bgImage: 'aurora' })
    await useSkinsStore.getState().addUserSkin(skin)
    await useSkinsStore.getState().setActiveSkin(skin.id)

    await useSkinsStore.getState().updateUserSkin(skin.id, {
      appearance: { bgImage: 'forest' }
    })
    expect(useBrandStore.getState().skinName).toBeNull()
    expect(useBrandAppearanceStore.getState().skinAppearance?.bgImage).toBe('forest')

    await useSkinsStore.getState().deleteUserSkin(skin.id)
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useBrandStore.getState().skinName).toBeNull()
    expect(useBrandAppearanceStore.getState().skinAppearance).toBeNull()
  })

  it('keeps a persisted Profile id pending until an authoritative catalog succeeds', async () => {
    const runtimeId = 'profile:%40demo%2Ftheme-pack:ocean'
    useSkinsStore.setState({ activeSkinId: runtimeId, profileCatalogReady: false })

    await useSkinsStore.getState().initActiveSkin()
    expect(useSkinsStore.getState().activeSkinId).toBe(runtimeId)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)

    await useSkinsStore.getState().setProfileThemes([profileTheme(runtimeId)], { authoritative: true })
    expect(useSkinsStore.getState().activeSkinId).toBe(runtimeId)
    expect(useSkinsStore.getState().appliedSkinId).toBe(runtimeId)

    useSkinsStore.setState({ diskLoadComplete: true, fallbackSkinId: DEFAULT_SKIN_ID })
    await useSkinsStore.getState().setProfileThemes([], { authoritative: true })
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
  })

  it('migrates the former built-in selection to the Profile-owned formal theme', async () => {
    useSkinsStore.setState({ activeSkinId: DEFAULT_SKIN_ID, revision: 4, updatedAt: 40 })

    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: false })

    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_PROFILE_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().profileThemeWarnings.join('\n')).toMatch(/DSH Profile 正式主题/)
  })

  it('previews a custom theme without persisting or replacing the selected theme', async () => {
    const preview = userSkin('preview-ocean')
    const saveSkins = (window as any).electronAPI.saveSkins as ReturnType<typeof vi.fn>
    saveSkins.mockClear()

    useSkinsStore.getState().previewUserSkin(preview)
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_PROFILE_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(preview.id)
    expect(useSkinsStore.getState().previewSkin?.id).toBe(preview.id)
    expect(saveSkins).not.toHaveBeenCalled()

    useSkinsStore.getState().clearThemePreview()
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().previewSkin).toBeNull()
    expect(saveSkins).not.toHaveBeenCalled()
  })

  it('keeps Profile themes visible while local custom themes are disabled', async () => {
    const existing = userSkin('disabled-ocean')
    const runtimeId = 'profile:%40demo%2Ftheme-pack:ocean'
    useSkinsStore.setState({
      userSkins: [existing],
      activeSkinId: existing.id,
      appliedSkinId: existing.id,
      fallbackSkinId: DEFAULT_SKIN_ID,
      profileThemes: [profileTheme(runtimeId)],
      diskLoadComplete: true
    })
    settings.enableCustomThemes = false

    expect(useSkinsStore.getState().listSkins().some((skin) => skin.id === runtimeId)).toBe(true)
    expect(useSkinsStore.getState().listSkins().some((skin) => skin.id === existing.id)).toBe(false)
    expect(useSkinsStore.getState().userSkins.map((skin) => skin.id)).toEqual([existing.id])
    expect(() => useSkinsStore.getState().previewUserSkin(userSkin('new-preview')))
      .toThrowError(/自定义主题功能已关闭/)
    await expect(useSkinsStore.getState().addUserSkin(userSkin('new-theme')))
      .rejects.toMatchObject({ code: 'CUSTOM_THEMES_DISABLED' })

    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: true })
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().userSkins.map((skin) => skin.id)).toEqual([existing.id])
  })

  it('saves and activates an edited theme in one durable write', async () => {
    const theme = userSkin('saved-ocean')
    const saveSkins = (window as any).electronAPI.saveSkins as ReturnType<typeof vi.fn>
    const saved = await useSkinsStore.getState().saveUserSkin(theme)

    expect(saved.id).toBe(theme.id)
    expect(useSkinsStore.getState().activeSkinId).toBe(theme.id)
    expect(useSkinsStore.getState().appliedSkinId).toBe(theme.id)
    expect(saveSkins).toHaveBeenCalledTimes(1)
  })

  it('does not let an authoritative catalog response race ahead of a pending disk restore', async () => {
    const pendingProfileId = 'profile:%40demo%2Ftheme-pack:ocean'
    const diskSkin = userSkin('newer-disk-skin')
    let resolveDisk: (value: unknown) => void = () => undefined
    ;(window as any).electronAPI.loadSkins = vi.fn(() => new Promise((resolve) => { resolveDisk = resolve }))
    useSkinsStore.setState({
      activeSkinId: pendingProfileId,
      revision: 1,
      updatedAt: 10,
      diskLoadComplete: false
    })

    const diskLoad = useSkinsStore.getState().loadFromDisk()
    await useSkinsStore.getState().setProfileThemes([], { authoritative: true })
    expect(useSkinsStore.getState().activeSkinId).toBe(pendingProfileId)
    expect(useSkinsStore.getState().revision).toBe(1)

    resolveDisk({
      status: 'valid',
      value: {
        schema_version: 1,
        revision: 7,
        updated_at: 70,
        userSkins: [diskSkin],
        activeSkinId: diskSkin.id
      }
    })
    await diskLoad
    expect(useSkinsStore.getState().revision).toBe(7)
    expect(useSkinsStore.getState().activeSkinId).toBe(diskSkin.id)
    expect(useSkinsStore.getState().userSkins.map((skin) => skin.id)).toEqual([diskSkin.id])
  })

  it('falls back a missing ordinary user skin instead of treating it as a pending Profile theme', async () => {
    useSkinsStore.setState({ activeSkinId: 'missing-user-skin', diskLoadComplete: true })
    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: true })
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
  })

  it('does not overwrite a complete disk backup during the startup preview fallback', async () => {
    const diskSkin = userSkin('disk-user-skin')
    useSkinsStore.setState({ activeSkinId: diskSkin.id, userSkins: [], revision: 0, updatedAt: 0 })
    const saveSkins = (window as any).electronAPI.saveSkins as ReturnType<typeof vi.fn>
    ;(window as any).electronAPI.loadSkins = vi.fn(async () => ({
      status: 'valid',
      value: {
        schema_version: 1,
        revision: 2,
        updated_at: 20,
        userSkins: [diskSkin],
        activeSkinId: diskSkin.id
      }
    }))

    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: false })
    expect(useSkinsStore.getState().activeSkinId).toBe(diskSkin.id)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(saveSkins).not.toHaveBeenCalled()

    await useSkinsStore.getState().loadFromDisk()
    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: true })
    expect(useSkinsStore.getState().activeSkinId).toBe(diskSkin.id)
    expect(useSkinsStore.getState().appliedSkinId).toBe(diskSkin.id)
    expect(saveSkins).not.toHaveBeenCalled()
  })

  it('normalizes an already migrated local backup idempotently across repeated startup init', async () => {
    const local = userSkin('already-normalized')
    useSkinsStore.setState({
      userSkins: [local],
      activeSkinId: local.id,
      revision: 4,
      updatedAt: 40
    })
    const saveSkins = (window as any).electronAPI.saveSkins as ReturnType<typeof vi.fn>

    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: false })
    const afterFirst = useSkinsStore.getState()
    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: false })
    const afterSecond = useSkinsStore.getState()

    expect(afterFirst.revision).toBe(4)
    expect(afterSecond.revision).toBe(4)
    expect(afterSecond.updatedAt).toBe(40)
    expect(saveSkins).not.toHaveBeenCalled()
  })

  it('migrates legacy raw CSS in a local backup once, then stays idempotent', async () => {
    useSkinsStore.setState({
      userSkins: [{
        id: 'legacy-local',
        name: 'Legacy Local',
        vars: { '--el-color-primary': primary },
        extraCss: 'body { display: none }',
        updatedAt: 25
      } as any],
      activeSkinId: 'legacy-local',
      revision: 2,
      updatedAt: 20
    })

    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: false })
    const afterMigration = useSkinsStore.getState()
    expect(afterMigration.userSkins[0].extraCss).toBeUndefined()
    expect(afterMigration.userSkins[0].mantineColors).toHaveLength(10)
    expect(afterMigration.revision).toBe(3)
    expect(afterMigration.profileThemeWarnings.join('\n')).toMatch(/原始 CSS/)

    await useSkinsStore.getState().initActiveSkin({ finalizeMissing: false })
    expect(useSkinsStore.getState().revision).toBe(3)
  })

  it('rolls back an immediate switch when persistence fails', async () => {
    const skin = userSkin('rollback-ocean')
    useSkinsStore.setState({ userSkins: [skin] })
    const saveSkins = vi.fn(async () => ({
      ok: false,
      error: { code: 'EIO', message: '磁盘不可写' }
    }))
    ;(window as any).electronAPI.saveSkins = saveSkins

    await expect(useSkinsStore.getState().setActiveSkin(skin.id)).rejects.toMatchObject({
      code: 'EIO',
      message: '磁盘不可写'
    })
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_PROFILE_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().persistenceError).toBe('磁盘不可写')
  })

  it('rejects item 65 before changing local state or invoking IPC', async () => {
    const skins = Array.from({ length: MAX_USER_SKINS }, (_, index) => userSkin(`skin-${index}`))
    useSkinsStore.setState({ userSkins: skins })
    const saveSkins = (window as any).electronAPI.saveSkins as ReturnType<typeof vi.fn>

    await expect(useSkinsStore.getState().addUserSkin(userSkin('skin-over-limit'))).rejects.toThrow(/不能超过 64/)
    expect(useSkinsStore.getState().userSkins).toHaveLength(MAX_USER_SKINS)
    expect(saveSkins).not.toHaveBeenCalled()
  })

  it('keeps a newer queued choice after an older save fails and clears the stale error', async () => {
    const first = userSkin('queue-first')
    const second = userSkin('queue-second')
    useSkinsStore.setState({ userSkins: [first, second] })
    let rejectFirst: (error: Error) => void = () => undefined
    const firstWrite = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
    ;(window as any).electronAPI.saveSkins = vi.fn()
      .mockImplementationOnce(() => firstWrite)
      .mockImplementationOnce((value) => ok(value))

    const oldMutation = useSkinsStore.getState().setActiveSkin(first.id)
    const oldRejected = expect(oldMutation).rejects.toThrow('旧写入失败')
    const newMutation = useSkinsStore.getState().setActiveSkin(second.id)
    rejectFirst(new Error('旧写入失败'))

    await oldRejected
    await newMutation
    expect(useSkinsStore.getState().activeSkinId).toBe(second.id)
    expect(useSkinsStore.getState().appliedSkinId).toBe(second.id)
    expect(useSkinsStore.getState().persistenceError).toBeNull()
  })

  it('rolls two consecutive failed saves back to the last confirmed skin state', async () => {
    const first = userSkin('double-fail-first')
    const second = userSkin('double-fail-second')
    useSkinsStore.setState({ userSkins: [first, second] })
    ;(window as any).electronAPI.saveSkins = vi.fn(async () => ({
      ok: false,
      error: { message: '连续写入失败' }
    }))

    const results = await Promise.allSettled([
      useSkinsStore.getState().setActiveSkin(first.id),
      useSkinsStore.getState().setActiveSkin(second.id)
    ])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(useSkinsStore.getState().activeSkinId).toBe(DEFAULT_PROFILE_SKIN_ID)
    expect(useSkinsStore.getState().appliedSkinId).toBe(DEFAULT_SKIN_ID)
    expect(useSkinsStore.getState().revision).toBe(0)
  })

  it('rolls a newer failed save back to an older save that was confirmed', async () => {
    const first = userSkin('confirmed-first')
    const second = userSkin('failed-second')
    useSkinsStore.setState({ userSkins: [first, second] })
    ;(window as any).electronAPI.saveSkins = vi.fn()
      .mockImplementationOnce((value) => ok(value))
      .mockImplementationOnce(async () => ({ ok: false, error: { message: '第二次写入失败' } }))

    const results = await Promise.allSettled([
      useSkinsStore.getState().setActiveSkin(first.id),
      useSkinsStore.getState().setActiveSkin(second.id)
    ])

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(useSkinsStore.getState().activeSkinId).toBe(first.id)
    expect(useSkinsStore.getState().appliedSkinId).toBe(first.id)
    expect(useSkinsStore.getState().revision).toBe(1)
  })

  it('strictly rejects raw CSS on new additions', async () => {
    await expect(useSkinsStore.getState().addUserSkin({
      id: 'raw-css',
      name: 'Raw CSS',
      vars: { '--el-color-primary': primary },
      mantineColors: deriveMantineColors(primary),
      extraCss: 'body { display: none }'
    } as any)).rejects.toThrow(/原始 CSS/)
    expect(useSkinsStore.getState().getSkin('raw-css')).toBeUndefined()
  })

  it('exports builtins as portable base copies and rejects Profile theme exports', async () => {
    const exported = useSkinsStore.getState().exportSkinToText(DEFAULT_SKIN_ID)
    const copy = parseSkinFile(exported)
    expect(copy.id).toBe(`${DEFAULT_SKIN_ID}-copy`)
    expect(copy.base).toBe(DEFAULT_SKIN_ID)

    const runtimeId = 'profile:%40demo%2Ftheme-pack:ocean'
    await useSkinsStore.getState().setProfileThemes([profileTheme(runtimeId)], { authoritative: true })
    expect(() => useSkinsStore.getState().exportSkinToText(runtimeId)).toThrow(/Profile 主题不能导出/)
  })
})

describe('disk backup recovery', () => {
  it('keeps localStorage state when disk is missing or corrupt', async () => {
    const local = userSkin('local-backup')
    useSkinsStore.setState({ userSkins: [local], activeSkinId: local.id, revision: 5, updatedAt: 50 })
    ;(window as any).electronAPI.loadSkins = vi.fn(async () => ({ status: 'missing' }))
    await useSkinsStore.getState().loadFromDisk()
    expect(useSkinsStore.getState().userSkins.map((skin) => skin.id)).toEqual([local.id])

    ;(window as any).electronAPI.loadSkins = vi.fn(async () => ({
      status: 'corrupt',
      error: { message: 'JSON 已损坏' }
    }))
    await expect(useSkinsStore.getState().loadFromDisk()).rejects.toThrow('JSON 已损坏')
    expect(useSkinsStore.getState().userSkins.map((skin) => skin.id)).toEqual([local.id])
  })

  it('treats an invalid item in a versioned disk payload as corrupt instead of partially replacing local backup', async () => {
    const local = userSkin('safe-local')
    useSkinsStore.setState({ userSkins: [local], activeSkinId: local.id, revision: 5, updatedAt: 50 })
    ;(window as any).electronAPI.loadSkins = vi.fn(async () => ({
      status: 'valid',
      value: {
        schema_version: 1,
        revision: 8,
        updated_at: 80,
        userSkins: [{ id: '../../invalid', name: 'Bad' }],
        activeSkinId: DEFAULT_SKIN_ID
      }
    }))

    await expect(useSkinsStore.getState().loadFromDisk()).rejects.toThrow(/损坏的自定义主题/)
    expect(useSkinsStore.getState().userSkins.map((skin) => skin.id)).toEqual([local.id])
    expect(useSkinsStore.getState().revision).toBe(5)
  })
})
