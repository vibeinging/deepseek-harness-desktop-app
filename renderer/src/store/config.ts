import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import settings from '@/settings'
import i18n, { langTitle } from '@/lang'
import { toggleHtmlClass } from '@/theme/utils'
import { useSkinsStore } from '@/store/skins'

export interface ConfigState {
  language: 'zh' | 'en'
  theme: string
  size: 'large' | 'default' | 'small'
  setTheme: (data: string) => Promise<void>
  setSize: (data: 'large' | 'default' | 'small') => void
  setLanguage: (lang: 'zh' | 'en') => void
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      language: settings.defaultLanguage,
      theme: settings.defaultTheme,
      size: settings.defaultSize,
      setTheme: async (data) => {
        // 皮肤系统接管：把品牌皮肤切换代理到 skins store（热切换）。
        // 仍保留旧 theme 字段用于兼容/迁移；toggleHtmlClass 仅在 skins store 未识别该 id 时兜底。
        const skins = useSkinsStore.getState()
        if (skins.getSkin(data)) {
          await skins.setActiveSkin(data)
        } else {
          toggleHtmlClass(data)
        }
        set({ theme: data })
      },
      setSize: (data) => set({ size: data }),
      setLanguage: (lang) => {
        set({ language: lang })
        i18n.changeLanguage(lang)
        document.title = langTitle(undefined)
      }
    }),
    {
      name: 'config',
      partialize: (s) => ({ language: s.language, theme: s.theme })
    }
  )
)
