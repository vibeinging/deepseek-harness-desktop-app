// 应用名 store：用户名称持久化，皮肤名称只做当前皮肤的临时覆盖。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n, { langTitle, setAppNameProvider } from '@/lang'

export const DEFAULT_APP_NAME = 'DeepSeek Harness Desktop App'
const LEGACY_DEFAULT_APP_NAMES = new Set(['DeepSeek Harness', 'dsh-work'])
const SETTINGS_SCHEMA_VERSION = 1
const STORE_SCHEMA_VERSION = 2
const DISK_KEY = 'brand'

type LoadEnvelope<T> =
  | { status: 'missing' }
  | { status: 'corrupt'; error?: { code?: string; message?: string } }
  | { status: 'valid'; value: T }

type SaveEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error?: { code?: string; message?: string } }

interface PersistedBrand {
  schema_version: number
  revision: number
  updated_at: number
  name: string
}

interface BrandSavePayload extends PersistedBrand {
  effectiveName: string
}

interface DurableBrandState {
  name: string
  revision: number
  updatedAt: number
}

export class BrandNameError extends Error {
  code: string
  constructor(message: string, code = 'BRAND_NAME_INVALID') {
    super(message)
    this.name = 'BrandNameError'
    this.code = code
  }
}

export class BrandPersistenceError extends Error {
  code: string
  constructor(message: string, code = 'BRAND_PERSISTENCE_ERROR') {
    super(message)
    this.name = 'BrandPersistenceError'
    this.code = code
  }
}

export interface BrandState {
  /** 用户保存的应用名。皮肤切换不能改写它。 */
  name: string
  /** 当前皮肤提供的临时名称，不持久化。 */
  skinName: string | null
  revision: number
  updatedAt: number
  persistenceError: string | null
  setName: (name: string) => Promise<void>
  setSkinName: (name: string | null) => void
  effectiveName: () => string
  initBrand: () => void
  loadFromDisk: () => Promise<void>
  saveToDisk: () => Promise<void>
  clearPersistenceError: () => void
}

let saveQueue: Promise<void> = Promise.resolve()

function normalizeStored(name: unknown): string {
  if (typeof name !== 'string') return ''
  const trimmed = name.trim()
  if (LEGACY_DEFAULT_APP_NAMES.has(trimmed)) return DEFAULT_APP_NAME
  return trimmed.length > 32 ? trimmed.slice(0, 32) : trimmed
}

function isLegacyDefaultName(name: unknown): boolean {
  return typeof name === 'string' && LEGACY_DEFAULT_APP_NAMES.has(name.trim())
}

function normalizeUserInput(name: unknown): string {
  if (typeof name !== 'string') throw new BrandNameError('应用名称必须是字符串', 'BRAND_NAME_INVALID')
  const trimmed = name.trim()
  if (trimmed.length > 32) throw new BrandNameError('应用名称不能超过 32 个字符', 'BRAND_NAME_TOO_LONG')
  return trimmed || DEFAULT_APP_NAME
}

function resolveEffectiveName(userName: string, skinName: string | null): string {
  const normalizedUser = normalizeStored(userName) || DEFAULT_APP_NAME
  // 用户显式名称优先；只有用户仍使用默认名时，皮肤名才临时生效。
  if (normalizedUser !== DEFAULT_APP_NAME) return normalizedUser
  return normalizeStored(skinName || '') || normalizedUser
}

function applyNameToDocument(name: string) {
  if (typeof document !== 'undefined') document.title = name || langTitle(undefined) || DEFAULT_APP_NAME
  try {
    i18n.addResourceBundle('zh', 'app', { name }, true, true)
    i18n.addResourceBundle('en', 'app', { name }, true, true)
  } catch {
    /* i18n 未初始化时忽略 */
  }
}

async function notifyMainProcess(name: string) {
  if (typeof window === 'undefined') return
  const api = (window as { electronAPI?: { setBrandName?: (name: string) => Promise<unknown> } }).electronAPI
  if (api?.setBrandName) await api.setBrandName(name || DEFAULT_APP_NAME)
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

function compareEnvelope(disk: PersistedBrand, localRevision: number, localUpdatedAt: number): number {
  if (disk.revision !== localRevision) return disk.revision - localRevision
  return disk.updated_at - localUpdatedAt
}

function queueSave(snapshot: PersistedBrand, currentEffectiveName: () => string): Promise<void> {
  const task = saveQueue.catch(() => undefined).then(async () => {
    if (typeof window === 'undefined') return
    const api = (window as { electronAPI?: { saveBrand?: (data: unknown) => Promise<unknown> } }).electronAPI
    if (!api?.saveBrand) return
    const payload: BrandSavePayload = { ...snapshot, effectiveName: currentEffectiveName() }
    const result = await api.saveBrand(payload) as SaveEnvelope<PersistedBrand>
    if (!result || typeof result !== 'object' || result.ok !== true) {
      throw new BrandPersistenceError(
        persistenceMessage(result, '应用名称保存失败'),
        persistenceCode(result, 'BRAND_PERSISTENCE_ERROR')
      )
    }
  })
  saveQueue = task.catch(() => undefined)
  return task
}

function persistedSnapshot(state: Pick<BrandState, 'name' | 'revision' | 'updatedAt'>): PersistedBrand {
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    revision: state.revision,
    updated_at: state.updatedAt,
    name: normalizeStored(state.name) || DEFAULT_APP_NAME
  }
}

export const useBrandStore = create<BrandState>()(
  persist(
    (set, get) => {
      let pendingMutations = 0
      let lastConfirmed: DurableBrandState | null = null

      const normalizeLocalBackup = () => {
        const state = get()
        const validNameType = typeof state.name === 'string'
        const name = validNameType ? (normalizeStored(state.name) || DEFAULT_APP_NAME) : DEFAULT_APP_NAME
        const revision = validNameType && Number.isSafeInteger(state.revision) && state.revision >= 0
          ? state.revision
          : 0
        const updatedAt = validNameType && Number.isFinite(state.updatedAt) && state.updatedAt >= 0
          ? state.updatedAt
          : 0
        if (name !== state.name || revision !== state.revision || updatedAt !== state.updatedAt) {
          set({ name, revision, updatedAt })
        }
      }

      const applyCurrent = (notify = true) => {
        normalizeLocalBackup()
        const state = get()
        const effective = resolveEffectiveName(state.name, state.skinName)
        applyNameToDocument(effective)
        if (notify) {
          void notifyMainProcess(effective).catch((error) => {
            set({ persistenceError: (error as Error).message || '应用名称同步失败' })
          })
        }
      }

      return {
        name: DEFAULT_APP_NAME,
        skinName: null,
        revision: 0,
        updatedAt: 0,
        persistenceError: null,

        setName: (name) => {
          normalizeLocalBackup()
          const previous = get()
          let nextName: string
          try {
            nextName = normalizeUserInput(name)
          } catch (error) {
            return Promise.reject(error)
          }
          const nextRevision = previous.revision + 1
          const nextUpdatedAt = Date.now()
          set({ name: nextName, revision: nextRevision, updatedAt: nextUpdatedAt, persistenceError: null })
          applyCurrent(false)
          const snapshot: PersistedBrand = {
            schema_version: SETTINGS_SCHEMA_VERSION,
            revision: nextRevision,
            updated_at: nextUpdatedAt,
            name: nextName
          }
          if (pendingMutations === 0) {
            lastConfirmed = { name: previous.name, revision: previous.revision, updatedAt: previous.updatedAt }
          }
          pendingMutations += 1
          const save = queueSave(snapshot, () => resolveEffectiveName(snapshot.name, get().skinName))
          return save.then(() => {
            lastConfirmed = {
              name: snapshot.name,
              revision: snapshot.revision,
              updatedAt: snapshot.updated_at
            }
            if (get().revision === nextRevision) set({ persistenceError: null })
          }).catch((error) => {
            // 只在没有更新操作越过本次 revision 时回滚，不能用旧失败覆盖新选择。
            if (get().revision === nextRevision) {
              set(lastConfirmed || { name: previous.name, revision: previous.revision, updatedAt: previous.updatedAt })
              applyCurrent()
            }
            set({ persistenceError: (error as Error).message || '应用名称保存失败' })
            throw error
          }).finally(() => {
            pendingMutations = Math.max(0, pendingMutations - 1)
          })
        },

        setSkinName: (name) => {
          set({ skinName: normalizeStored(name || '') || null })
          applyCurrent()
        },

        effectiveName: () => resolveEffectiveName(get().name, get().skinName),

        initBrand: applyCurrent,

        loadFromDisk: async () => {
          normalizeLocalBackup()
          if (typeof window === 'undefined') return
          const api = (window as { electronAPI?: { loadBrand?: () => Promise<unknown> } }).electronAPI
          if (!api?.loadBrand) return
          const startedRevision = get().revision
          let result: LoadEnvelope<PersistedBrand>
          try {
            result = await api.loadBrand() as LoadEnvelope<PersistedBrand>
          } catch (error) {
            set({ persistenceError: (error as Error).message || '应用名称读取失败' })
            throw error
          }
          if (get().revision !== startedRevision) return
          if (result?.status === 'missing') {
            await get().saveToDisk()
            return
          }
          if (result?.status === 'corrupt') {
            const message = persistenceMessage(result, '应用名称文件已损坏，已保留本地备份')
            set({ persistenceError: message })
            throw new Error(message)
          }
          if (result?.status !== 'valid' || !result.value || typeof result.value.name !== 'string') {
            const message = '应用名称读取结果不合法，已保留本地备份'
            set({ persistenceError: message })
            throw new Error(message)
          }

          const disk = result.value
          const diskName = normalizeStored(disk.name) || DEFAULT_APP_NAME
          if (isLegacyDefaultName(disk.name)) {
            set({
              name: DEFAULT_APP_NAME,
              revision: Math.max(get().revision, disk.revision) + 1,
              updatedAt: Date.now(),
              persistenceError: null
            })
            await get().saveToDisk()
            return
          }
          const isLegacy = disk.schema_version !== SETTINGS_SCHEMA_VERSION
          if (isLegacy) {
            const localName = get().name
            const mergedName = localName !== DEFAULT_APP_NAME ? localName : diskName
            set({ name: mergedName, revision: get().revision + 1, updatedAt: Date.now(), persistenceError: null })
            await get().saveToDisk()
            return
          }

          if (compareEnvelope(disk, get().revision, get().updatedAt) >= 0) {
            set({ name: diskName, revision: disk.revision, updatedAt: disk.updated_at, persistenceError: null })
          } else {
            // localStorage 更新，通常意味着上次磁盘写入失败；保留并重试回写。
            await get().saveToDisk()
          }
        },

        saveToDisk: async () => {
          normalizeLocalBackup()
          const snapshot = persistedSnapshot(get())
          try {
            await queueSave(snapshot, () => resolveEffectiveName(snapshot.name, get().skinName))
            if (get().revision === snapshot.revision) set({ persistenceError: null })
          } catch (error) {
            set({ persistenceError: (error as Error).message || '应用名称保存失败' })
            throw error
          }
        },

        clearPersistenceError: () => set({ persistenceError: null })
      }
    },
    {
      name: DISK_KEY,
      version: STORE_SCHEMA_VERSION,
      migrate: (persistedState) => {
        const state = persistedState as BrandState
        return { ...state, name: normalizeStored(state?.name) || DEFAULT_APP_NAME }
      },
      partialize: (s) => ({ name: s.name, revision: s.revision, updatedAt: s.updatedAt })
    }
  )
)

setAppNameProvider(() => useBrandStore.getState().effectiveName())

export function useAppName(): string {
  return useBrandStore((s) => resolveEffectiveName(s.name, s.skinName))
}
