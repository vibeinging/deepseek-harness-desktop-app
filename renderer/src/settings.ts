/**
 * Global settings (aligned with original src/settings.js). Keep only fields still relevant to React project.
 */
export interface AppSettings {
  title: string
  sidebarLogo: boolean
  showNavbarTitle: boolean
  ShowDropDown: boolean
  showHamburger: boolean
  showLeftMenu: boolean
  showTagsView: boolean
  tagsViewNum: number
  showTopNavbar: boolean
  mainNeedAnimation: boolean
  isNeedNprogress: boolean
  errorLog: string[]
  delWindowHeight: string
  viteBasePath: string
  defaultLanguage: 'zh' | 'en'
  defaultTheme: string
  defaultSize: 'large' | 'default' | 'small'
  /** 本地自定义主题开关。未配置环境变量时默认开启。 */
  enableCustomThemes: boolean
  plateFormId: number
}

export function featureEnabled(value: unknown, defaultValue = true): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue
  return !['0', 'false', 'off'].includes(String(value).trim().toLowerCase())
}

export const settings: AppSettings = {
  title: 'dsh-work',
  sidebarLogo: true,
  showNavbarTitle: false,
  ShowDropDown: true,
  showHamburger: true,
  showLeftMenu: true,
  showTagsView: true,
  tagsViewNum: 6,
  showTopNavbar: true,
  mainNeedAnimation: false,
  isNeedNprogress: true,
  errorLog: ['prod'],
  delWindowHeight: '210px',
  viteBasePath: '/',
  defaultLanguage: 'zh',
  defaultTheme: 'profile:%40deepseek-ai%2Fdsh-theme-pack:professional-blue',
  defaultSize: 'default',
  enableCustomThemes: featureEnabled(import.meta.env.VITE_APP_ENABLE_CUSTOM_THEMES),
  plateFormId: 2
}

export default settings
