// 主题 store。内部沿用 skin 字段兼容旧数据；所有生命周期通过统一事务同步颜色、外观和选择。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import settings from '@/settings'
import { BUILTIN_SKINS, DEFAULT_SKIN_ID, isBuiltinSkinId } from '@/theme/skins/builtin'
import { applySkin } from '@/theme/skins/apply'
import {
  migrateLegacySkinDefinition,
  normalizeProfileThemeDefinition,
  normalizeSkinDefinition,
  parseSkinFile,
  serializeSkinFile,
  SkinValidationError
} from '@/theme/skins/import'
import { normalizeBrandAppearance, useBrandAppearanceStore } from '@/store/brandAppearance'
import { useBrandStore } from '@/store/brand'
import type { SkinDefinition } from '@/theme/skins/types'

const DISK_KEY = 'skins'
const SETTINGS_SCHEMA_VERSION = 1
export const MAX_USER_SKINS = 64
export const MAX_SKINS_FILE_BYTES = 2 * 1024 * 1024
const USER_SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
const PROFILE_THEME_ID_PATTERN = /^profile:((?:[a-z0-9._!~*'()-]|%[0-9a-f]{2}){1,440}):[a-z0-9][a-z0-9_-]{0,62}$/i

export function customThemesEnabled(): boolean {
  return settings.enableCustomThemes !== false
}

function customThemesDisabledError(): SkinValidationError {
  return new SkinValidationError('自定义主题功能已关闭', 'CUSTOM_THEMES_DISABLED')
}

function isProfileThemeId(value: string): boolean {
  if (value.length > 512) return false
  const match = PROFILE_THEME_ID_PATTERN.exec(value)
  if (!match) return false
  try {
    return encodeURIComponent(decodeURIComponent(match[1])) === match[1]
  } catch {
    return false
  }
}

function isPersistableActiveSkinId(value: string): boolean {
  return USER_SKIN_ID_PATTERN.test(value) || isProfileThemeId(value)
}

type LoadEnvelope<T> =
  | { status: 'missing' }
  | { status: 'corrupt'; error?: { code?: string; message?: string } }
  | { status: 'valid'; value: T }

type SaveEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error?: { code?: string; message?: string } }

interface PersistedSkins {
  schema_version: number
  revision: number
  updated_at: number
  userSkins: SkinDefinition[]
  activeSkinId: string
  /** Profile/自定义主题消失时恢复的最近内置主题。旧文件缺省为 DEFAULT_SKIN_ID。 */
  fallbackSkinId?: string
}

interface ProfileThemesOptions {
  /** true 仅用于成功返回的 Profile 全量目录。此时缺失的 pending 主题才能判定为已消失。 */
  authoritative?: boolean
  /** Server 在 Profile 描述边界发现的错误；与 Renderer 二次校验告警一起展示。 */
  warnings?: string[]
}

interface DurableSkinsState {
  userSkins: SkinDefinition[]
  activeSkinId: string
  fallbackSkinId: string
  revision: number
  updatedAt: number
}

export class SkinPersistenceError extends Error {
  code: string
  constructor(message: string, code = 'SKINS_PERSISTENCE_ERROR') {
    super(message)
    this.name = 'SkinPersistenceError'
    this.code = code
  }
}

export interface SkinsState {
  userSkins: SkinDefinition[]
  profileThemes: SkinDefinition[]
  activeSkinId: string
  fallbackSkinId: string
  /** 实际已应用到 DOM 的主题。pending Profile 尚未解析时可与 activeSkinId 不同。 */
  appliedSkinId: string
  /** 编辑器临时预览，不进入列表、不持久化。 */
  previewSkin: SkinDefinition | null
  scheme: 'light' | 'dark'
  profileCatalogReady: boolean
  diskLoadComplete: boolean
  profileThemeWarnings: string[]
  revision: number
  updatedAt: number
  persistenceError: string | null
  listSkins: () => SkinDefinition[]
  getSkin: (id: string) => SkinDefinition | undefined
  getAppliedSkin: () => SkinDefinition | undefined
  setActiveSkin: (id: string) => Promise<void>
  previewUserSkin: (skin: SkinDefinition) => SkinDefinition
  clearThemePreview: () => void
  saveUserSkin: (skin: SkinDefinition, editingId?: string | null) => Promise<SkinDefinition>
  setScheme: (scheme: 'light' | 'dark') => void
  initActiveSkin: (options?: { finalizeMissing?: boolean }) => Promise<void>
  setProfileThemes: (themes: SkinDefinition[], options?: ProfileThemesOptions) => Promise<void>
  addUserSkin: (skin: SkinDefinition) => Promise<void>
  updateUserSkin: (id: string, patch: Partial<SkinDefinition>) => Promise<SkinDefinition | null>
  deleteUserSkin: (id: string) => Promise<void>
  importSkinFromText: (json: string) => Promise<SkinDefinition>
  exportSkinToText: (id: string) => string
  loadFromDisk: () => Promise<void>
  saveToDisk: () => Promise<void>
  clearPersistenceError: () => void
}

let saveQueue: Promise<void> = Promise.resolve()

function byteLength(value: unknown): number {
  const text = JSON.stringify(value, null, 2)
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
}

function snapshotOf(state: DurableSkinsState): PersistedSkins {
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    revision: state.revision,
    updated_at: state.updatedAt,
    userSkins: state.userSkins,
    activeSkinId: state.activeSkinId,
    fallbackSkinId: state.fallbackSkinId
  }
}

function assertCatalogLimits(snapshot: PersistedSkins) {
  if (snapshot.userSkins.length > MAX_USER_SKINS) {
    throw new SkinPersistenceError(`自定义主题不能超过 ${MAX_USER_SKINS} 个`, 'SKINS_COUNT_EXCEEDED')
  }
  if (byteLength(snapshot) > MAX_SKINS_FILE_BYTES) {
    throw new SkinPersistenceError('主题定义总大小不能超过 2MB', 'SKINS_FILE_TOO_LARGE')
  }
}

function persistenceMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const message = (value as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

function persistenceCode(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const code = (value as { error?: { code?: unknown } }).error?.code
    if (typeof code === 'string' && code.trim()) return code
  }
  return fallback
}

function queueSave(snapshot: PersistedSkins): Promise<void> {
  assertCatalogLimits(snapshot)
  const task = saveQueue.catch(() => undefined).then(async () => {
    if (typeof window === 'undefined') return
    const api = (window as { electronAPI?: { saveSkins?: (data: unknown) => Promise<unknown> } }).electronAPI
    if (!api?.saveSkins) return
    const result = await api.saveSkins(snapshot) as SaveEnvelope<PersistedSkins>
    if (!result || typeof result !== 'object' || result.ok !== true) {
      throw new SkinPersistenceError(
        persistenceMessage(result, '主题设置保存失败'),
        persistenceCode(result, 'SKINS_PERSISTENCE_ERROR')
      )
    }
  })
  saveQueue = task.catch(() => undefined)
  return task
}

function asDurable(state: SkinsState): DurableSkinsState {
  return {
    userSkins: state.userSkins,
    activeSkinId: state.activeSkinId,
    fallbackSkinId: state.fallbackSkinId,
    revision: state.revision,
    updatedAt: state.updatedAt
  }
}

function isPortableAsset(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('dsh-skin-asset://')
}

function assertPortableSkin(skin: SkinDefinition) {
  if (isPortableAsset(skin.appearance?.bgImage) || isPortableAsset(skin.appearance?.dark?.bgImage)) {
    throw new SkinValidationError('本机图片不能随主题导出，请先改用内置背景预设', 'SKIN_ASSET_NOT_PORTABLE')
  }
}

function normalizeUserList(
  rawItems: unknown[],
  warnings: string[],
  options: { rejectInvalid?: boolean } = {}
): SkinDefinition[] {
  const byId = new Map<string, SkinDefinition>()
  for (const raw of rawItems) {
    try {
      const skin = migrateLegacySkinDefinition(raw, (message) => warnings.push(message))
      const rawUpdatedAt = raw && typeof raw === 'object' && typeof (raw as { updatedAt?: unknown }).updatedAt === 'number'
        ? (raw as { updatedAt: number }).updatedAt
        : undefined
      if (rawUpdatedAt !== undefined && Number.isFinite(rawUpdatedAt)) skin.updatedAt = rawUpdatedAt
      const existing = byId.get(skin.id)
      const existingAt = typeof existing?.updatedAt === 'number' ? existing.updatedAt : 0
      const nextAt = typeof skin.updatedAt === 'number' ? skin.updatedAt : 0
      if (!existing || nextAt >= existingAt) byId.set(skin.id, skin)
    } catch (error) {
      if (options.rejectInvalid) {
        throw new SkinPersistenceError(
          `主题设置包含损坏的自定义主题，已保留本地备份：${(error as Error).message}`,
          'SKINS_ITEM_INVALID'
        )
      }
      warnings.push(`已跳过损坏的自定义主题：${(error as Error).message}`)
    }
  }
  return [...byId.values()]
}

function mergeLegacyUserSkins(local: SkinDefinition[], disk: SkinDefinition[]): SkinDefinition[] {
  const merged = new Map<string, SkinDefinition>()
  for (const skin of disk) merged.set(skin.id, skin)
  for (const skin of local) {
    const diskSkin = merged.get(skin.id)
    const localAt = typeof skin.updatedAt === 'number' ? skin.updatedAt : 0
    const diskAt = typeof diskSkin?.updatedAt === 'number' ? diskSkin.updatedAt : 0
    if (!diskSkin || localAt >= diskAt) merged.set(skin.id, skin)
  }
  return [...merged.values()]
}

export const useSkinsStore = create<SkinsState>()(
  persist(
    (set, get) => {
      let pendingMutations = 0
      let lastConfirmed: DurableSkinsState | null = null

      const fallbackTheme = () => {
        const id = isBuiltinSkinId(get().fallbackSkinId) ? get().fallbackSkinId : DEFAULT_SKIN_ID
        return get().getSkin(id) || get().getSkin(DEFAULT_SKIN_ID)
      }

      const applyThemeDefinition = (selected: SkinDefinition) => {
        // 先验证派生外观，避免颜色已切换后才发现后续状态非法。
        const skinAppearance = selected.appearance
          ? normalizeBrandAppearance(selected.appearance)
          : null
        set({ appliedSkinId: selected.id })
        applySkin(selected, get().scheme)
        useBrandAppearanceStore.getState().setSkinAppearance(skinAppearance)
        // 旧主题可能携带临时应用名；新模型明确清理，不让主题改名。
        useBrandStore.getState().setSkinName(null)
      }

      /** 同一事务内同步主题选择、颜色和外观，不再让生命周期调用者各自漏掉一层。 */
      const applyActiveSkinTransaction = (options: {
        requestedId?: string
        allowPending?: boolean
        preserveMissingSelection?: boolean
      } = {}) => {
        const requestedId = options.requestedId ?? get().activeSkinId
        let selected = get().getSkin(requestedId)
        let selectedId = requestedId
        const pendingProfile = !selected && options.allowPending === true && isProfileThemeId(requestedId)
        const preserveMissing = !selected && options.preserveMissingSelection === true && isPersistableActiveSkinId(requestedId)
        const pending = pendingProfile || preserveMissing
        if (!selected) {
          selected = fallbackTheme()
          if (!pending) selectedId = selected?.id || DEFAULT_SKIN_ID
        }
        if (!selected) throw new SkinValidationError('默认主题不存在', 'SKIN_DEFAULT_MISSING')
        set({ activeSkinId: selectedId, previewSkin: null })
        applyThemeDefinition(selected)
        return { selectedId, pending, fellBack: selectedId !== requestedId }
      }

      const restoreDurable = (previous: DurableSkinsState) => {
        set(previous)
        applyActiveSkinTransaction({ requestedId: previous.activeSkinId, allowPending: !get().profileCatalogReady })
      }

      const saveMutation = <T,>(
        previous: DurableSkinsState,
        revision: number,
        snapshot: PersistedSkins,
        result: T
      ): Promise<T> => {
        if (pendingMutations === 0) lastConfirmed = previous
        pendingMutations += 1
        return queueSave(snapshot).then(() => {
          lastConfirmed = {
            userSkins: snapshot.userSkins,
            activeSkinId: snapshot.activeSkinId,
            fallbackSkinId: snapshot.fallbackSkinId || DEFAULT_SKIN_ID,
            revision: snapshot.revision,
            updatedAt: snapshot.updated_at
          }
          if (get().revision === revision) set({ persistenceError: null })
          return result
        }).catch((error) => {
          if (get().revision === revision) restoreDurable(lastConfirmed || previous)
          set({ persistenceError: (error as Error).message || '主题设置保存失败' })
          throw error
        }).finally(() => {
          pendingMutations = Math.max(0, pendingMutations - 1)
        })
      }

      const normalizeLocalBackup = () => {
        const warnings: string[] = []
        const state = get()
        const rawSkins = Array.isArray(state.userSkins) ? state.userSkins as unknown[] : []
        if (!Array.isArray(state.userSkins)) warnings.push('本地主题备份格式损坏，已忽略无效列表')
        const normalized = normalizeUserList(rawSkins, warnings)
        const rawActive = typeof state.activeSkinId === 'string' ? state.activeSkinId.trim() : ''
        const activeSkinId = rawActive && isPersistableActiveSkinId(rawActive) ? rawActive : DEFAULT_SKIN_ID
        if (rawActive && activeSkinId !== rawActive) warnings.push('本地当前主题 ID 不合法，已恢复默认主题')
        const fallbackSkinId = isBuiltinSkinId(state.fallbackSkinId) ? state.fallbackSkinId : DEFAULT_SKIN_ID
        const safeRevision = Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0
        const safeUpdatedAt = Number.isFinite(state.updatedAt) && state.updatedAt >= 0 ? state.updatedAt : 0
        let limitError: string | null = null
        try {
          assertCatalogLimits(snapshotOf({
            userSkins: normalized,
            activeSkinId,
            fallbackSkinId,
            revision: safeRevision,
            updatedAt: safeUpdatedAt
          }))
        } catch (error) {
          limitError = (error as Error).message
        }
        const changed = JSON.stringify(normalized) !== JSON.stringify(rawSkins) ||
          activeSkinId !== state.activeSkinId ||
          fallbackSkinId !== state.fallbackSkinId ||
          safeRevision !== state.revision ||
          safeUpdatedAt !== state.updatedAt
        if (changed) {
          set({
            userSkins: normalized,
            activeSkinId,
            fallbackSkinId,
            revision: safeRevision + 1,
            updatedAt: Date.now(),
            profileThemeWarnings: [...state.profileThemeWarnings, ...warnings],
            ...(limitError ? { persistenceError: limitError } : {})
          })
        } else if (warnings.length > 0 || limitError) {
          set({
            profileThemeWarnings: [...state.profileThemeWarnings, ...warnings],
            ...(limitError ? { persistenceError: limitError } : {})
          })
        }
      }

      return {
        userSkins: [],
        profileThemes: [],
        activeSkinId: DEFAULT_SKIN_ID,
        fallbackSkinId: DEFAULT_SKIN_ID,
        appliedSkinId: DEFAULT_SKIN_ID,
        previewSkin: null,
        scheme: 'light',
        profileCatalogReady: false,
        diskLoadComplete: false,
        profileThemeWarnings: [],
        revision: 0,
        updatedAt: 0,
        persistenceError: null,

        listSkins: () => {
          const { userSkins, profileThemes } = get()
          if (!customThemesEnabled()) return [...BUILTIN_SKINS]
          const safeUserSkins = Array.isArray(userSkins) ? userSkins : []
          const safeProfileThemes = Array.isArray(profileThemes) ? profileThemes : []
          const seen = new Set<string>()
          const merged: SkinDefinition[] = []
          for (const skin of [...BUILTIN_SKINS, ...safeUserSkins, ...safeProfileThemes]) {
            if (!seen.has(skin.id)) {
              seen.add(skin.id)
              merged.push(skin)
            }
          }
          return merged
        },

        getSkin: (id) => get().listSkins().find((skin) => skin.id === id),

        getAppliedSkin: () => get().previewSkin || get().getSkin(get().appliedSkinId),

        setActiveSkin: (id) => {
          if (!get().getSkin(id)) return Promise.reject(new SkinValidationError(`主题不存在: ${id}`, 'SKIN_NOT_FOUND'))
          const previous = asDurable(get())
          const revision = previous.revision + 1
          const updatedAt = Date.now()
          const fallbackSkinId = isBuiltinSkinId(id) ? id : previous.fallbackSkinId
          const snapshot = snapshotOf({ ...previous, activeSkinId: id, fallbackSkinId, revision, updatedAt })
          try {
            assertCatalogLimits(snapshot)
          } catch (error) {
            return Promise.reject(error)
          }
          set({ activeSkinId: id, fallbackSkinId, previewSkin: null, revision, updatedAt, persistenceError: null })
          applyActiveSkinTransaction({ requestedId: id })
          return saveMutation(previous, revision, snapshot, undefined)
        },

        previewUserSkin: (rawSkin) => {
          if (!customThemesEnabled()) throw customThemesDisabledError()
          const skin = normalizeSkinDefinition(rawSkin)
          set({ previewSkin: skin })
          applyThemeDefinition(skin)
          return skin
        },

        clearThemePreview: () => {
          if (!get().previewSkin) return
          set({ previewSkin: null })
          applyActiveSkinTransaction({
            allowPending: !get().profileCatalogReady,
            preserveMissingSelection: !get().diskLoadComplete
          })
        },

        setScheme: (scheme) => {
          set({ scheme })
          if (get().previewSkin) {
            applyThemeDefinition(get().previewSkin!)
            return
          }
          applyActiveSkinTransaction({
            allowPending: !get().profileCatalogReady,
            preserveMissingSelection: !get().diskLoadComplete
          })
        },

        initActiveSkin: async (options = {}) => {
          normalizeLocalBackup()
          const finalizeMissing = options.finalizeMissing !== false
          const before = get().activeSkinId
          const result = applyActiveSkinTransaction({
            allowPending: !get().profileCatalogReady,
            preserveMissingSelection: !finalizeMissing
          })
          if (finalizeMissing && result.fellBack && before !== result.selectedId) {
            const revision = get().revision + 1
            const updatedAt = Date.now()
            set({ revision, updatedAt })
            await get().saveToDisk()
          }
        },

        setProfileThemes: async (themes, options = {}) => {
          const warnings = Array.isArray(options.warnings)
            ? options.warnings.filter((warning) => typeof warning === 'string' && warning.trim())
            : []
          const diskLoadComplete = get().diskLoadComplete
          const currentUserSkins = Array.isArray(get().userSkins) ? get().userSkins : []
          const reserved = new Set([...BUILTIN_SKINS, ...currentUserSkins].map((skin) => skin.id))
          const normalized: SkinDefinition[] = []
          const seen = new Set<string>()
          for (const raw of Array.isArray(themes) ? themes : []) {
            try {
              const skin = normalizeProfileThemeDefinition(raw)
              if (reserved.has(skin.id) || seen.has(skin.id)) {
                warnings.push(`Profile 主题 ID 冲突，已跳过：${skin.id}`)
                continue
              }
              seen.add(skin.id)
              normalized.push(skin)
            } catch (error) {
              warnings.push(`Profile 主题无效，已跳过：${(error as Error).message}`)
            }
          }
          set({
            profileThemes: normalized,
            profileCatalogReady: options.authoritative === true ? true : get().profileCatalogReady,
            profileThemeWarnings: warnings
          })

          const requested = get().activeSkinId
          const result = applyActiveSkinTransaction({
            requestedId: requested,
            allowPending: options.authoritative !== true && !get().profileCatalogReady,
            // backend ready 可能早于磁盘恢复。此时目录虽已权威，也不能抢先改写待恢复选择。
            preserveMissingSelection: !diskLoadComplete
          })
          if (result.fellBack) {
            // catalog 已明确成功，活动 Profile 主题确实消失。回退状态保留，即使磁盘暂时写失败也不重新应用失效主题。
            const revision = get().revision + 1
            const updatedAt = Date.now()
            set({ revision, updatedAt, persistenceError: null })
            await get().saveToDisk()
          }
        },

        saveUserSkin: (rawSkin, editingId = null) => {
          if (!customThemesEnabled()) return Promise.reject(customThemesDisabledError())
          let skin: SkinDefinition
          try {
            skin = normalizeSkinDefinition(rawSkin)
          } catch (error) {
            return Promise.reject(error)
          }
          const previous = asDurable(get())
          let nextSkins: SkinDefinition[]
          if (editingId) {
            const index = previous.userSkins.findIndex((item) => item.id === editingId)
            if (index < 0) {
              return Promise.reject(new SkinValidationError('要编辑的主题已不存在', 'SKIN_NOT_FOUND'))
            }
            if (skin.id !== editingId) {
              return Promise.reject(new SkinValidationError('主题 ID 创建后不能修改', 'SKIN_ID_IMMUTABLE'))
            }
            nextSkins = previous.userSkins.map((item) => (item.id === editingId ? skin : item))
          } else {
            if (get().getSkin(skin.id)) {
              return Promise.reject(new SkinValidationError(`id "${skin.id}" 已存在`, 'SKIN_ID_CONFLICT'))
            }
            nextSkins = [...previous.userSkins, skin]
          }
          const revision = previous.revision + 1
          const updatedAt = Date.now()
          const snapshot = snapshotOf({
            ...previous,
            userSkins: nextSkins,
            activeSkinId: skin.id,
            revision,
            updatedAt
          })
          try {
            assertCatalogLimits(snapshot)
          } catch (error) {
            return Promise.reject(error)
          }
          set({
            userSkins: nextSkins,
            activeSkinId: skin.id,
            previewSkin: null,
            revision,
            updatedAt,
            persistenceError: null
          })
          applyActiveSkinTransaction({ requestedId: skin.id })
          return saveMutation(previous, revision, snapshot, skin)
        },

        addUserSkin: (rawSkin) => {
          if (!customThemesEnabled()) return Promise.reject(customThemesDisabledError())
          // 新增/导入必须走严格入口；legacy migration 只允许用于已有持久化数据。
          let skin: SkinDefinition
          try {
            skin = normalizeSkinDefinition(rawSkin)
          } catch (error) {
            return Promise.reject(error)
          }
          if (get().getSkin(skin.id)) {
            return Promise.reject(new SkinValidationError(`id "${skin.id}" 已存在`, 'SKIN_ID_CONFLICT'))
          }
          const previous = asDurable(get())
          const revision = previous.revision + 1
          const updatedAt = Date.now()
          const nextSkins = [...previous.userSkins, skin]
          const snapshot = snapshotOf({ ...previous, userSkins: nextSkins, revision, updatedAt })
          try {
            assertCatalogLimits(snapshot)
          } catch (error) {
            return Promise.reject(error)
          }
          set({ userSkins: nextSkins, revision, updatedAt, persistenceError: null })
          return saveMutation(previous, revision, snapshot, undefined)
        },

        updateUserSkin: (id, patch) => {
          if (!customThemesEnabled()) return Promise.reject(customThemesDisabledError())
          const existing = get().userSkins.find((skin) => skin.id === id)
          if (!existing) return Promise.resolve(null)
          let next: SkinDefinition
          try {
            next = normalizeSkinDefinition({ ...existing, ...patch, id, updatedAt: Date.now() })
          } catch (error) {
            return Promise.reject(error)
          }
          const previous = asDurable(get())
          const revision = previous.revision + 1
          const updatedAt = Date.now()
          const nextSkins = previous.userSkins.map((skin) => (skin.id === id ? next : skin))
          const snapshot = snapshotOf({ ...previous, userSkins: nextSkins, revision, updatedAt })
          try {
            assertCatalogLimits(snapshot)
          } catch (error) {
            return Promise.reject(error)
          }
          set({ userSkins: nextSkins, revision, updatedAt, persistenceError: null })
          if (previous.activeSkinId === id) applyActiveSkinTransaction({ requestedId: id })
          return saveMutation(previous, revision, snapshot, next)
        },

        deleteUserSkin: (id) => {
          if (!customThemesEnabled()) return Promise.reject(customThemesDisabledError())
          const existing = get().userSkins.find((skin) => skin.id === id)
          if (!existing) return Promise.resolve()
          const previous = asDurable(get())
          const revision = previous.revision + 1
          const updatedAt = Date.now()
          const nextSkins = previous.userSkins.filter((skin) => skin.id !== id)
          const nextActive = previous.activeSkinId === id ? previous.fallbackSkinId : previous.activeSkinId
          const snapshot = snapshotOf({
            ...previous,
            userSkins: nextSkins,
            activeSkinId: nextActive,
            revision,
            updatedAt
          })
          try {
            assertCatalogLimits(snapshot)
          } catch (error) {
            return Promise.reject(error)
          }
          set({ userSkins: nextSkins, activeSkinId: nextActive, previewSkin: null, revision, updatedAt, persistenceError: null })
          if (previous.activeSkinId === id) applyActiveSkinTransaction({ requestedId: nextActive })
          return saveMutation(previous, revision, snapshot, undefined)
        },

        importSkinFromText: async (json) => {
          if (!customThemesEnabled()) throw customThemesDisabledError()
          const skin = parseSkinFile(json)
          await get().addUserSkin(skin)
          return skin
        },

        exportSkinToText: (id) => {
          if (!customThemesEnabled()) throw customThemesDisabledError()
          const skin = get().getSkin(id)
          if (!skin) throw new SkinValidationError(`主题不存在: ${id}`, 'SKIN_NOT_FOUND')
          if (skin.source === 'profile') {
            throw new SkinValidationError('Profile 主题不能导出为用户主题，请先新建自定义副本', 'SKIN_PROFILE_NOT_EXPORTABLE')
          }
          assertPortableSkin(skin)
          const portable: SkinDefinition = {
            ...skin,
            builtIn: false,
            source: 'user'
          }
          delete (portable as { htmlClass?: string }).htmlClass
          if (skin.builtIn) {
            portable.id = `${skin.id}-copy`
            portable.name = `${skin.name}（副本）`
            portable.base = skin.id
          }
          return serializeSkinFile(portable)
        },

        loadFromDisk: async () => {
          normalizeLocalBackup()
          if (typeof window === 'undefined') {
            set({ diskLoadComplete: true })
            return
          }
          const api = (window as { electronAPI?: { loadSkins?: () => Promise<unknown> } }).electronAPI
          if (!api?.loadSkins) {
            set({ diskLoadComplete: true })
            return
          }
          const startedRevision = get().revision
          let result: LoadEnvelope<PersistedSkins>
          try {
            result = await api.loadSkins() as LoadEnvelope<PersistedSkins>
          } catch (error) {
            set({ persistenceError: (error as Error).message || '主题设置读取失败', diskLoadComplete: true })
            throw error
          }
          if (get().revision !== startedRevision) {
            set({ diskLoadComplete: true })
            return
          }
          if (result?.status === 'missing') {
            set({ diskLoadComplete: true })
            await get().saveToDisk()
            return
          }
          if (result?.status === 'corrupt') {
            const message = persistenceMessage(result, '主题设置文件已损坏，已保留本地备份')
            set({ persistenceError: message, diskLoadComplete: true })
            throw new SkinPersistenceError(message)
          }
          if (result?.status !== 'valid' || !result.value || !Array.isArray(result.value.userSkins)) {
            const message = '主题设置读取结果不合法，已保留本地备份'
            set({ persistenceError: message, diskLoadComplete: true })
            throw new SkinPersistenceError(message)
          }

          const disk = result.value
          const legacy = disk.schema_version !== SETTINGS_SCHEMA_VERSION
          const diskFallbackSkinId = isBuiltinSkinId(disk.fallbackSkinId || '')
            ? disk.fallbackSkinId!
            : DEFAULT_SKIN_ID
          const warnings: string[] = []
          let diskSkins: SkinDefinition[]
          try {
            diskSkins = normalizeUserList(result.value.userSkins as unknown[], warnings, {
              rejectInvalid: !legacy
            })
          } catch (error) {
            const message = (error as Error).message || '主题设置包含损坏的数据，已保留本地备份'
            set({ persistenceError: message, diskLoadComplete: true })
            throw error
          }
          if (disk.activeSkinId && !isPersistableActiveSkinId(disk.activeSkinId)) {
            const message = '磁盘中的当前主题 ID 不合法，已保留本地备份'
            set({ persistenceError: message, diskLoadComplete: true })
            throw new SkinPersistenceError(message)
          }

          if (legacy) {
            const mergedSkins = mergeLegacyUserSkins(get().userSkins, diskSkins)
            const available = new Set([...BUILTIN_SKINS, ...mergedSkins].map((skin) => skin.id))
            const localActive = get().activeSkinId
            const diskActive = disk.activeSkinId
            const activeSkinId = localActive !== DEFAULT_SKIN_ID
              ? localActive
              : (diskActive && (available.has(diskActive) || isPersistableActiveSkinId(diskActive)) ? diskActive : localActive)
            set({
              userSkins: mergedSkins,
              activeSkinId,
              fallbackSkinId: isBuiltinSkinId(get().fallbackSkinId)
                ? get().fallbackSkinId
                : diskFallbackSkinId,
              revision: get().revision + 1,
              updatedAt: Date.now(),
              profileThemeWarnings: [...get().profileThemeWarnings, ...warnings],
              persistenceError: null,
              diskLoadComplete: true
            })
            await get().saveToDisk()
            return
          }

          const diskIsNewer = disk.revision > get().revision ||
            (disk.revision === get().revision && disk.updated_at >= get().updatedAt)
          if (diskIsNewer) {
            const migrated = warnings.length > 0
              || JSON.stringify(diskSkins) !== JSON.stringify(disk.userSkins)
            set({
              userSkins: diskSkins,
              activeSkinId: disk.activeSkinId || DEFAULT_SKIN_ID,
              fallbackSkinId: diskFallbackSkinId,
              revision: migrated ? disk.revision + 1 : disk.revision,
              updatedAt: migrated ? Date.now() : disk.updated_at,
              profileThemeWarnings: [...get().profileThemeWarnings, ...warnings],
              persistenceError: null,
              diskLoadComplete: true
            })
            if (migrated) await get().saveToDisk()
          } else {
            set({ diskLoadComplete: true })
            await get().saveToDisk()
          }
        },

        saveToDisk: async () => {
          const snapshot = snapshotOf(asDurable(get()))
          assertCatalogLimits(snapshot)
          try {
            await queueSave(snapshot)
            if (get().revision === snapshot.revision) set({ persistenceError: null })
          } catch (error) {
            set({ persistenceError: (error as Error).message || '主题设置保存失败' })
            throw error
          }
        },

        clearPersistenceError: () => set({ persistenceError: null })
      }
    },
    {
      name: DISK_KEY,
      version: SETTINGS_SCHEMA_VERSION,
      migrate: (persistedState) => persistedState as SkinsState,
      partialize: (state) => ({
        userSkins: state.userSkins,
        activeSkinId: state.activeSkinId,
        fallbackSkinId: state.fallbackSkinId,
        revision: state.revision,
        updatedAt: state.updatedAt
      })
    }
  )
)
