// Agent desktop entry (top route /agent, layout:false, includes own shell).
// Legacy smart Q&A page is retired; Q&A capability remains in backend eval APIs and no longer has its own route.
// Theme: light (Agent-like neutral shell), dark (neutral gray-black), or system; synced through .dsh-root[data-theme] and Mantine.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import { useLocation, useOutlet } from 'react-router-dom'
import AgentShell from './AgentShell'
import { resolveAgentShellRouteContent } from './AgentWorkspaceRoute'
import { applyAgentZoom, loadAgentSettings } from './AgentSettings'
import { AgentThemeContext, type AgentScheme, type AgentThemeMode } from './themeContext'
import { useSkinsStore } from '@/store/skins'
import { useBrandAppearanceStore } from '@/store/brandAppearance'
import { systemScheme as resolveSystemScheme } from '@/theme/skins/scheme'
import { useDshClientHost } from '@/dsh-client/DshClientHost'
import { useConfigStore } from '@/store/config'
import './agent-theme.scss'

const STORAGE_KEY = 'dsh-theme'
const systemScheme = (): AgentScheme => resolveSystemScheme()

export default function AgentPage() {
  const location = useLocation()
  const routeContent = resolveAgentShellRouteContent(location.pathname, useOutlet())
  const dshClientHost = useDshClientHost()
  const [standaloneMode, setStandaloneMode] = useState<AgentThemeMode>(
    () => (localStorage.getItem(STORAGE_KEY) as AgentThemeMode) || 'dark'
  )
  const [sysScheme, setSysScheme] = useState<AgentScheme>(systemScheme)

  // Follow system: listen for prefers-color-scheme updates.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSysScheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    if (!dshClientHost) localStorage.setItem(STORAGE_KEY, standaloneMode)
  }, [dshClientHost, standaloneMode])

  // Apply last saved UI zoom (can be changed in settings and reused after refresh).
  useEffect(() => {
    applyAgentZoom(loadAgentSettings().zoom)
  }, [])

  const mode: AgentThemeMode = dshClientHost?.themeSnapshot.preference || standaloneMode
  const scheme: AgentScheme = dshClientHost?.themeSnapshot.active.colorScheme
    || (mode === 'system' ? sysScheme : mode)
  const setMode = useCallback((next: AgentThemeMode) => {
    if (dshClientHost) dshClientHost.setTheme(next)
    else setStandaloneMode(next)
  }, [dshClientHost])

  useEffect(() => {
    const language = dshClientHost?.localeSnapshot.active
    if (language && useConfigStore.getState().language !== language) {
      useConfigStore.getState().setLanguage(language)
    }
  }, [dshClientHost?.localeSnapshot.active])

  // On resize gaps, set theme background color on html to match app outer color so exposed drag areas are not white.
  // Also mount Mantine color scheme to <html>:body so portal overlays (Select dropdowns, etc.) follow the same color mode.
  // MantineProvider dark mode only applies deeply when attached at root.
  // This effect stays active for the application shell and is cleaned up on unmount.
  useEffect(() => {
    const el = document.documentElement
    const prevBg = el.style.backgroundColor
    const prevScheme = el.getAttribute('data-mantine-color-scheme')
    el.style.backgroundColor = `var(--skin-dsh-bg, ${scheme === 'dark' ? '#36313f' : '#fbfaf7'})`
    el.setAttribute('data-mantine-color-scheme', scheme)
    // 同步明暗到皮肤 store + 品牌外观 store，让各自的 dark 覆盖正确叠加（热切换）。
    useSkinsStore.getState().setScheme(scheme)
    useBrandAppearanceStore.getState().setScheme(scheme)
    return () => {
      el.style.backgroundColor = prevBg
      if (prevScheme) el.setAttribute('data-mantine-color-scheme', prevScheme)
      else el.removeAttribute('data-mantine-color-scheme')
    }
  }, [scheme])
  const ctx = useMemo(() => ({ mode, scheme, setMode }), [mode, scheme])

  return (
    <AgentThemeContext.Provider value={ctx}>
      <MantineProvider forceColorScheme={scheme}>
        <div className="dsh-root" data-theme={scheme}>
          {/* Drag handle + outer padding are in .dsh-root (no zoom); only content inside .dsh-zoom is scaled. */}
          <div className="dsh-dragbar" />
          <div className="dsh-dragbar-side" />
          <div className="dsh-zoom">
            <AgentShell routeContent={routeContent} />
          </div>
        </div>
      </MantineProvider>
    </AgentThemeContext.Provider>
  )
}
