/**
 * Application startup initialization (aligned with App.vue onBeforeMount / onMounted):
 * - Initialize skin (品牌皮肤) + brand appearance (外观) + brand name (应用名) + language
 *
 * 皮肤系统取代旧的 config.theme 单 class 切换：
 * - 同步先用 localStorage 已有数据应用激活皮肤 / 外观 / 应用名（首屏不阻塞）。
 * - 再异步从磁盘（Electron userData）恢复（长久保存），完成后重应用。
 * 正式 DSH Client 启动时，明暗模式和语言由 DSH Runtime 快照提供；独立 Vite 页面才读取本机回退值。
 */
import i18n from '@/lang'
import { useConfigStore } from '@/store/config'
import { useSkinsStore } from '@/store/skins'
import { useBrandAppearanceStore } from '@/store/brandAppearance'
import { useBrandStore } from '@/store/brand'
import { DEFAULT_SKIN_ID } from '@/theme/skins/builtin'
import { resolveInitialScheme } from '@/theme/skins/scheme'

const LEGACY_THEME_MIGRATION_KEY = 'skins:legacy-theme-migrated:v1'

export interface InitAppOptions {
  scheme?: 'light' | 'dark'
  language?: 'zh' | 'en'
}

function localStorageGet(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key) } catch { return null }
}

function localStorageSet(key: string, value: string) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}

function hasPersistedSkinSelection(): boolean {
  const raw = localStorageGet('skins')
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw) as { state?: { activeSkinId?: unknown } }
    return typeof parsed?.state?.activeSkinId === 'string' && parsed.state.activeSkinId.length > 0
  } catch {
    return false
  }
}

/** 旧 config.theme 只读一次；已有新 store 选择时绝不覆盖。 */
function migrateLegacyThemeOnce(legacyTheme: string | undefined) {
  if (localStorageGet(LEGACY_THEME_MIGRATION_KEY) === 'done') return
  const skinsState = useSkinsStore.getState()
  if (!hasPersistedSkinSelection() && legacyTheme && legacyTheme !== DEFAULT_SKIN_ID && skinsState.getSkin(legacyTheme)) {
    useSkinsStore.setState({
      activeSkinId: legacyTheme,
      revision: skinsState.revision + 1,
      updatedAt: Date.now()
    })
  }
  // 无论旧值是否有效都标记完成，避免它在未来重新覆盖用户的新选择。
  localStorageSet(LEGACY_THEME_MIGRATION_KEY, 'done')
}

export function initApp(options: InitAppOptions = {}): Promise<void> {
  const config = useConfigStore.getState()
  const language = options.language || config.language
  if (language !== config.language) config.setLanguage(language)

  // 1) 旧 config.theme → skins.activeSkinId 真正的一次性迁移。
  migrateLegacyThemeOnce(config.theme)

  // 1.5) 启动时先用持久化的明暗 scheme 设置 store，消除暗色皮肤的浅色闪现。
  //      明暗模式由 views/agent/index.tsx 拥有，启动首屏前在此同步一次。
  const initialScheme = options.scheme || resolveInitialScheme()
  useSkinsStore.setState({ scheme: initialScheme })
  useBrandAppearanceStore.setState({ scheme: initialScheme })

  // 2) 同步应用激活皮肤 + 品牌外观 + 应用名（localStorage 数据已由 zustand persist 恢复）。
  void useSkinsStore.getState().initActiveSkin({ finalizeMissing: false }).catch((error) => {
    console.warn('[skins] 首屏皮肤初始化失败:', (error as Error).message)
  })
  try {
    useBrandAppearanceStore.getState().initAppearance()
  } catch (error) {
    console.warn('[app-init] 首屏品牌外观初始化失败:', (error as Error).message)
  }
  try {
    useBrandStore.getState().initBrand()
  } catch (error) {
    console.warn('[app-init] 首屏应用名称初始化失败:', (error as Error).message)
  }

  // 3) 语言（brand.initBrand 已设置 document.title 为应用名；这里仅切换语言，不覆盖 title）。
  i18n.changeLanguage(language)

  // 4) 异步从磁盘恢复（Electron userData，长久保存），不阻塞首屏。
  const loadLabels = ['皮肤设置', '品牌外观', '应用名称']
  return Promise.allSettled([
    useSkinsStore.getState().loadFromDisk(),
    useBrandAppearanceStore.getState().loadFromDisk(),
    useBrandStore.getState().loadFromDisk()
  ]).then(async (results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[app-init] ${loadLabels[index]}恢复失败:`, (result.reason as Error)?.message || result.reason)
      }
    })
    // 磁盘恢复后统一重应用（userSkins/appearance/name 可能变化）。
    // 任意一层失败都不能阻止另外两层进入 DOM。
    const applyResults = await Promise.allSettled([
      useSkinsStore.getState().initActiveSkin({ finalizeMissing: true }),
      Promise.resolve().then(() => useBrandAppearanceStore.getState().initAppearance()),
      Promise.resolve().then(() => useBrandStore.getState().initBrand())
    ])
    applyResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[app-init] ${loadLabels[index]}重应用失败:`, (result.reason as Error)?.message || result.reason)
      }
    })
  }).catch((error) => {
    console.warn('[app-init] 外观恢复失败:', (error as Error).message)
  })
}
