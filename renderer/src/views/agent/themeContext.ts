// Agent theme context: light, dark, or system.
// index.tsx owns the mode state and applies it to .dsh-root[data-theme] and MantineProvider.
// The left-side three-state switch reads and updates state via useAgentTheme().
import { createContext, useContext } from 'react'

export type AgentThemeMode = 'light' | 'dark' | 'system'
export type AgentScheme = 'light' | 'dark'

export interface AgentThemeContextValue {
  mode: AgentThemeMode
  scheme: AgentScheme // Resolved effective mode from system (dark/light).
  setMode: (m: AgentThemeMode) => void
}

export const AgentThemeContext = createContext<AgentThemeContextValue>({
  mode: 'system',
  scheme: 'light',
  setMode: () => {}
})

export const useAgentTheme = () => useContext(AgentThemeContext)
