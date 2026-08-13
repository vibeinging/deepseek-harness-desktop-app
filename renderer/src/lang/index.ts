import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import zh from './zh'
import settings from '@/settings'

/**
 * i18n initialization (aligned with original vue-i18n).
 * - en/zh dictionaries directly reuse Vue project language files (plain object, keys unchanged).
 * - vue-i18n uses `{name}` interpolation, so i18next delimiters are also set to `{}` for zero-change dictionary migration.
 */
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh }
  },
  lng: settings.defaultLanguage,
  fallbackLng: 'zh',
  interpolation: {
    escapeValue: false,
    prefix: '{',
    suffix: '}'
  },
  returnNull: false
})

export default i18n

/** In non-component contexts (axios interceptor / store / guards), use i18n.t(...). */
export const t = i18n.t.bind(i18n)

/** Equivalent of vue-i18n te: check if a key exists. */
export const te = (key: string) => i18n.exists(key)

/**
 * 应用名提供者：由 brand store 启动时注入，避免 lang 模块反向依赖 store（循环依赖）。
 * langTitle 无参时优先读它，回退 settings.title。
 */
let appNameProvider: (() => string) | null = null
export function setAppNameProvider(fn: (() => string) | null) {
  appNameProvider = fn
}

/**
 * Translate route meta.title to localized title (aligned with hooks/use-common.langTitle).
 * The previous implementation iterated zh top-level keys and checked `${key}.${title}` via te; keep the same behavior.
 * 无参时返回当前应用名（优先 brand store 的自定义名，回退 settings.title）。
 */
export const langTitle = (title?: string): string => {
  if (!title) return (appNameProvider?.() || settings.title)
  for (const key of Object.keys(zh)) {
    const full = `${key}.${title}`
    if (i18n.exists(full)) {
      const v = i18n.t(full)
      if (v) return v
    }
  }
  return title
}
