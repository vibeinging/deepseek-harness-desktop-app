// 品牌外观 store。用户覆盖持久化，皮肤基底只驻留内存。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { applyAppearance, hasAppearanceContent } from '@/theme/skins/applyAppearance'
import { findBgPreset } from '@/theme/skins/backgrounds'
import { normalizeHexColor } from '@/theme/skins/colors'
import type { BrandAppearance } from '@/theme/skins/types'

const DISK_KEY = 'brand-appearance'
const SETTINGS_SCHEMA_VERSION = 1
export const MAX_APPEARANCE_FILE_BYTES = 256 * 1024
const LOCAL_BG_PATTERN = /^dsh-skin-asset:\/\/[a-f0-9]{24}\.(?:png|jpe?g|webp|gif)$/i
const BG_SIZE_VALUES = new Set(['cover', 'contain', 'center'])

type LoadEnvelope<T> =
  | { status: 'missing' }
  | { status: 'corrupt'; error?: { code?: string; message?: string } }
  | { status: 'valid'; value: T }

type SaveEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error?: { code?: string; message?: string } }

interface PersistedAppearance {
  schema_version: number
  revision: number
  updated_at: number
  appearance: BrandAppearance
}

interface DurableAppearanceState {
  appearance: BrandAppearance
  revision: number
  updatedAt: number
}

export class BrandAppearanceError extends Error {
  code: string
  constructor(message: string, code = 'BRAND_APPEARANCE_INVALID') {
    super(message)
    this.name = 'BrandAppearanceError'
    this.code = code
  }
}

export interface BrandAppearanceState {
  appearance: BrandAppearance
  skinAppearance: BrandAppearance | null
  scheme: 'light' | 'dark'
  revision: number
  updatedAt: number
  persistenceError: string | null
  setAppearance: (patch: Partial<BrandAppearance>) => Promise<void>
  resetAppearance: () => Promise<void>
  setSkinAppearance: (ap: BrandAppearance | null) => void
  effectiveAppearance: () => BrandAppearance
  setScheme: (scheme: 'light' | 'dark') => void
  initAppearance: () => void
  loadFromDisk: () => Promise<void>
  saveToDisk: () => Promise<void>
  clearPersistenceError: () => void
}

let saveQueue: Promise<void> = Promise.resolve()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function byteLength(value: unknown): number {
  const text = JSON.stringify(value, null, 2)
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
}

function normalizeBgImage(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new BrandAppearanceError(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (findBgPreset(normalized) || LOCAL_BG_PATTERN.test(normalized)) return normalized
  throw new BrandAppearanceError(`${field} 只能使用内置预设或本机图片`, 'BRAND_BG_IMAGE_INVALID')
}

function normalizePercent(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new BrandAppearanceError(`${field} 必须是 0-100 之间的数字`, 'BRAND_PERCENT_INVALID')
  }
  return value
}

/** Store 边界统一校验。用户 UI、磁盘恢复、皮肤基底都必须经过这里。 */
export function normalizeBrandAppearance(value: unknown, options: { allowAppName?: boolean } = {}): BrandAppearance {
  if (!isPlainObject(value)) throw new BrandAppearanceError('品牌外观必须是对象')
  const allowed = new Set(['appName', 'bgColor', 'bgImage', 'bgImageSize', 'bgOpacity', 'panelOpacity', 'dark'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new BrandAppearanceError(`品牌外观含非法字段 "${key}"`)
  }
  const result: BrandAppearance = {}
  if (!options.allowAppName && value.appName !== undefined && value.appName !== null) {
    throw new BrandAppearanceError('当前外观层不允许 appName')
  }
  if (options.allowAppName && value.appName !== undefined && value.appName !== null) {
    if (typeof value.appName !== 'string' || !value.appName.trim() || value.appName.trim().length > 32) {
      throw new BrandAppearanceError('appName 必须是 1-32 个字符')
    }
    result.appName = value.appName.trim()
  }
  if (value.bgColor !== undefined && value.bgColor !== null && value.bgColor !== '') {
    const color = normalizeHexColor(value.bgColor)
    if (!color) {
      throw new BrandAppearanceError('bgColor 只支持 #RGB 或 #RRGGBB', 'BRAND_BG_COLOR_INVALID')
    }
    result.bgColor = color
  }
  const bgImage = normalizeBgImage(value.bgImage, 'bgImage')
  if (bgImage !== undefined) result.bgImage = bgImage
  if (value.bgImageSize !== undefined && value.bgImageSize !== null) {
    if (typeof value.bgImageSize !== 'string' || !BG_SIZE_VALUES.has(value.bgImageSize)) {
      throw new BrandAppearanceError('bgImageSize 必须是 cover、contain 或 center')
    }
    result.bgImageSize = value.bgImageSize as BrandAppearance['bgImageSize']
  }
  const bgOpacity = normalizePercent(value.bgOpacity, 'bgOpacity')
  const panelOpacity = normalizePercent(value.panelOpacity, 'panelOpacity')
  if (bgOpacity !== undefined) result.bgOpacity = bgOpacity
  if (panelOpacity !== undefined) result.panelOpacity = panelOpacity
  if (value.dark !== undefined && value.dark !== null) {
    if (!isPlainObject(value.dark)) throw new BrandAppearanceError('dark 必须是对象')
    const dark = normalizeBrandAppearance(value.dark)
    if (dark.appName || dark.dark) throw new BrandAppearanceError('dark 不允许 appName 或嵌套 dark')
    if (Object.keys(dark).length > 0) result.dark = dark
  }
  return result
}

function cleanUndefined(value: BrandAppearance): BrandAppearance {
  const result = { ...value }
  for (const key of Object.keys(result) as (keyof BrandAppearance)[]) {
    if (result[key] === undefined) delete result[key]
  }
  if (result.dark) {
    const dark = { ...result.dark }
    for (const key of Object.keys(dark) as (keyof typeof dark)[]) {
      if (dark[key] === undefined) delete dark[key]
    }
    if (Object.keys(dark).length > 0) result.dark = dark
    else delete result.dark
  }
  return result
}

/** right 的显式字段优先，dark 子对象逐字段合并。 */
function mergeAppearance(base: BrandAppearance, override: BrandAppearance): BrandAppearance {
  const merged: BrandAppearance = { ...base, ...override }
  if (override.dark || base.dark) merged.dark = { ...(base.dark || {}), ...(override.dark || {}) }
  return cleanUndefined(merged)
}

function commonAppearance(ap: BrandAppearance): BrandAppearance {
  return cleanUndefined({ ...ap, dark: undefined, appName: undefined })
}

/**
 * 正常主题产品的覆盖顺序：主题公共值 → 主题模式值 → 用户公共值 → 用户模式值。
 * 用户明确设置的普通字段因此不会在暗色模式下被主题的暗色默认值反向覆盖。
 */
export function resolveAppearanceForScheme(
  theme: BrandAppearance | null,
  user: BrandAppearance,
  scheme: 'light' | 'dark'
): BrandAppearance {
  const themeCommon = commonAppearance(theme || {})
  const userCommon = commonAppearance(user)
  if (scheme !== 'dark') return cleanUndefined({ ...themeCommon, ...userCommon })
  return cleanUndefined({
    ...themeCommon,
    ...(theme?.dark || {}),
    ...userCommon,
    ...(user.dark || {})
  })
}

function applyEffective(state: Pick<BrandAppearanceState, 'appearance' | 'skinAppearance' | 'scheme'>) {
  const effective = resolveAppearanceForScheme(state.skinAppearance, state.appearance, state.scheme)
  applyAppearance(effective, state.scheme, hasAppearanceContent(effective))
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

function snapshotOf(state: Pick<BrandAppearanceState, 'appearance' | 'revision' | 'updatedAt'>): PersistedAppearance {
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    revision: state.revision,
    updated_at: state.updatedAt,
    appearance: state.appearance
  }
}

function assertSize(snapshot: PersistedAppearance) {
  if (byteLength(snapshot) > MAX_APPEARANCE_FILE_BYTES) {
    throw new BrandAppearanceError('品牌外观定义超过 256KB', 'BRAND_APPEARANCE_TOO_LARGE')
  }
}

function queueSave(snapshot: PersistedAppearance): Promise<void> {
  assertSize(snapshot)
  const task = saveQueue.catch(() => undefined).then(async () => {
    if (typeof window === 'undefined') return
    const api = (window as { electronAPI?: { saveBrandAppearance?: (data: unknown) => Promise<unknown> } }).electronAPI
    if (!api?.saveBrandAppearance) return
    const result = await api.saveBrandAppearance(snapshot) as SaveEnvelope<PersistedAppearance>
    if (!result || typeof result !== 'object' || result.ok !== true) {
      throw new BrandAppearanceError(
        persistenceMessage(result, '品牌外观保存失败'),
        persistenceCode(result, 'BRAND_APPEARANCE_PERSISTENCE_ERROR')
      )
    }
  })
  saveQueue = task.catch(() => undefined)
  return task
}

export const useBrandAppearanceStore = create<BrandAppearanceState>()(
  persist(
    (set, get) => {
      let pendingMutations = 0
      let lastConfirmed: DurableAppearanceState | null = null

      const normalizeLocalBackup = () => {
        const state = get()
        let appearance: BrandAppearance
        let invalid = false
        try {
          appearance = normalizeBrandAppearance(state.appearance)
        } catch (error) {
          appearance = {}
          invalid = true
          set({ persistenceError: `本地品牌外观备份已损坏，已忽略：${(error as Error).message}` })
        }
        const revision = !invalid && Number.isSafeInteger(state.revision) && state.revision >= 0
          ? state.revision
          : 0
        const updatedAt = !invalid && Number.isFinite(state.updatedAt) && state.updatedAt >= 0
          ? state.updatedAt
          : 0
        if (JSON.stringify(appearance) !== JSON.stringify(state.appearance) ||
          revision !== state.revision || updatedAt !== state.updatedAt) {
          set({ appearance, revision, updatedAt })
        }
      }

      const mutateAndSave = (appearance: BrandAppearance): Promise<void> => {
        normalizeLocalBackup()
        let normalized: BrandAppearance
        try {
          normalized = normalizeBrandAppearance(appearance)
        } catch (error) {
          return Promise.reject(error)
        }
        const previous = get()
        const revision = previous.revision + 1
        const updatedAt = Date.now()
        const snapshot: PersistedAppearance = {
          schema_version: SETTINGS_SCHEMA_VERSION,
          revision,
          updated_at: updatedAt,
          appearance: normalized
        }
        try {
          assertSize(snapshot)
        } catch (error) {
          return Promise.reject(error)
        }
        set({ appearance: normalized, revision, updatedAt, persistenceError: null })
        applyEffective(get())
        if (pendingMutations === 0) {
          lastConfirmed = {
            appearance: previous.appearance,
            revision: previous.revision,
            updatedAt: previous.updatedAt
          }
        }
        pendingMutations += 1
        return queueSave(snapshot).then(() => {
          lastConfirmed = {
            appearance: snapshot.appearance,
            revision: snapshot.revision,
            updatedAt: snapshot.updated_at
          }
          if (get().revision === revision) set({ persistenceError: null })
        }).catch((error) => {
          if (get().revision === revision) {
            set(lastConfirmed || {
              appearance: previous.appearance,
              revision: previous.revision,
              updatedAt: previous.updatedAt
            })
            applyEffective(get())
          }
          set({ persistenceError: (error as Error).message || '品牌外观保存失败' })
          throw error
        }).finally(() => {
          pendingMutations = Math.max(0, pendingMutations - 1)
        })
      }

      return {
        appearance: {},
        skinAppearance: null,
        scheme: 'light',
        revision: 0,
        updatedAt: 0,
        persistenceError: null,

        setAppearance: (patch) => {
          normalizeLocalBackup()
          return mutateAndSave(cleanUndefined(mergeAppearance(get().appearance, patch)))
        },
        resetAppearance: () => mutateAndSave({}),

        setSkinAppearance: (ap) => {
          normalizeLocalBackup()
          const normalized = ap ? normalizeBrandAppearance(ap) : null
          set({ skinAppearance: normalized })
          applyEffective(get())
        },

        effectiveAppearance: () => {
          normalizeLocalBackup()
          return resolveAppearanceForScheme(get().skinAppearance, get().appearance, get().scheme)
        },

        setScheme: (scheme) => {
          normalizeLocalBackup()
          set({ scheme })
          applyEffective(get())
        },

        initAppearance: () => {
          normalizeLocalBackup()
          applyEffective(get())
        },

        loadFromDisk: async () => {
          normalizeLocalBackup()
          if (typeof window === 'undefined') return
          const api = (window as { electronAPI?: { loadBrandAppearance?: () => Promise<unknown> } }).electronAPI
          if (!api?.loadBrandAppearance) return
          const startedRevision = get().revision
          let result: LoadEnvelope<PersistedAppearance>
          try {
            result = await api.loadBrandAppearance() as LoadEnvelope<PersistedAppearance>
          } catch (error) {
            set({ persistenceError: (error as Error).message || '品牌外观读取失败' })
            throw error
          }
          if (get().revision !== startedRevision) return
          if (result?.status === 'missing') {
            await get().saveToDisk()
            return
          }
          if (result?.status === 'corrupt') {
            const message = persistenceMessage(result, '品牌外观文件已损坏，已保留本地备份')
            set({ persistenceError: message })
            throw new Error(message)
          }
          if (result?.status !== 'valid' || !result.value) {
            const message = '品牌外观读取结果不合法，已保留本地备份'
            set({ persistenceError: message })
            throw new Error(message)
          }

          let diskAppearance: BrandAppearance
          try {
            diskAppearance = normalizeBrandAppearance(result.value.appearance)
          } catch (error) {
            const message = `品牌外观文件不合法：${(error as Error).message}`
            set({ persistenceError: message })
            throw new Error(message)
          }
          const disk = result.value
          const legacy = disk.schema_version !== SETTINGS_SCHEMA_VERSION
          if (legacy) {
            // 旧格式没有版本，localStorage 显式字段优先，避免合法空磁盘擦掉本地备份。
            const merged = mergeAppearance(diskAppearance, get().appearance)
            set({ appearance: merged, revision: get().revision + 1, updatedAt: Date.now(), persistenceError: null })
            await get().saveToDisk()
            return
          }

          const diskIsNewer = disk.revision > get().revision ||
            (disk.revision === get().revision && disk.updated_at >= get().updatedAt)
          if (diskIsNewer) {
            set({ appearance: diskAppearance, revision: disk.revision, updatedAt: disk.updated_at, persistenceError: null })
          } else {
            await get().saveToDisk()
          }
        },

        saveToDisk: async () => {
          normalizeLocalBackup()
          const snapshot = snapshotOf(get())
          assertSize(snapshot)
          try {
            await queueSave(snapshot)
            if (get().revision === snapshot.revision) set({ persistenceError: null })
          } catch (error) {
            set({ persistenceError: (error as Error).message || '品牌外观保存失败' })
            throw error
          }
        },

        clearPersistenceError: () => set({ persistenceError: null })
      }
    },
    {
      name: DISK_KEY,
      version: SETTINGS_SCHEMA_VERSION,
      migrate: (persistedState) => persistedState as BrandAppearanceState,
      partialize: (s) => ({ appearance: s.appearance, revision: s.revision, updatedAt: s.updatedAt })
    }
  )
)
