// 明暗模式解析（供启动时消除浅色闪现）。
// 明暗模式由 views/agent/index.tsx 拥有（localStorage['dsh-theme']），
// 但皮肤/外观 store 需要在启动首屏前就拿到正确 scheme，否则会用默认 'light' 应用皮肤，
// 在暗色 + custom dark 覆盖皮肤下产生一次浅色闪现。
//
// 本模块把"从 localStorage + 系统偏好解析当前生效 scheme"的逻辑集中，供启动时同步调用。

export type AgentScheme = 'light' | 'dark'
export type AgentThemeMode = 'light' | 'dark' | 'system'

/** localStorage key（与 views/agent/index.tsx 的 STORAGE_KEY 一致）。 */
const THEME_MODE_KEY = 'dsh-theme'

/** 读取系统 prefers-color-scheme。 */
export function systemScheme(): AgentScheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 启动时同步解析当前生效的明暗 scheme。
 * 优先级：localStorage['dsh-theme']（light/dark/system）→ system 偏好 → dark（默认暗，与 index.tsx 一致）。
 */
export function resolveInitialScheme(): AgentScheme {
  if (typeof localStorage === 'undefined') return systemScheme()
  const mode = String(localStorage.getItem(THEME_MODE_KEY) || 'dark') as AgentThemeMode
  if (mode === 'light' || mode === 'dark') return mode
  if (mode === 'system') return systemScheme()
  return systemScheme()
}
