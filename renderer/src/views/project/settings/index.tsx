// Project settings page inside the app. It should only be opened embedded in the /agent workspace.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { Center, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { SettingsShell, SettingsNavItem } from '@/views/agent/SettingsShell'
import { useProjectStore } from '@/store/project'
import { getProjectDetailReq } from '@/api/project'

import BasicInfo from './components/BasicInfo'
import ProjectInstructions from './components/ProjectInstructions'
import ProjectChatMemory from './components/ProjectChatMemory'

import styles from './index.module.scss'

const ModelConfig = lazy(() => import('./components/ModelConfig'))

const HOST_TABS = ['basic', 'instructions', 'chat-memory', 'models'] as const

// Initial structure for each tab's refresh key
const initialTabRefreshKeys = (): Record<string, number> => ({
  basic: 0,
  instructions: 0,
  'chat-memory': 0,
  models: 0
})

export default function ProjectSettings({
  hiddenTabs = [],
  onBack,
  onProjectUpdated,
  onDeleteProject
}: {
  hiddenTabs?: string[]
  onBack: () => void
  onProjectUpdated?: (project: any) => void
  onDeleteProject?: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  // Current project (zustand selector, aligned with projectStore.currentProject)
  const currentProject = useProjectStore((s) => s.currentProject)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const hasProject = !!currentProject?.id
  const allowedTabs = useMemo(() => new Set<string>(HOST_TABS), [])
  const tabLoading = (
    <Center style={{ minHeight: 160 }}>
      <Text c="dimmed">加载中...</Text>
    </Center>
  )
  const fallbackTab = useMemo(
    () => HOST_TABS.find((tabName) => !hiddenTabs.includes(tabName)) || 'basic',
    [hiddenTabs]
  )
  const isAllowedTab = useCallback(
    (tabName: string) => allowedTabs.has(tabName) && !hiddenTabs.includes(tabName),
    [allowedTabs, hiddenTabs]
  )

  // Get the initial Host-owned tab from the URL hash.
  const getInitialTab = useCallback(() => {
    const hash = location.hash?.replace('#', '') || ''
    return isAllowedTab(hash) ? hash : fallbackTab
  }, [fallbackTab, isAllowedTab, location.hash])

  // Current active tab
  const [activeTab, setActiveTab] = useState<string>(getInitialTab())

  // Refresh key for each tab
  const [tabRefreshKeys, setTabRefreshKeys] = useState<Record<string, number>>(initialTabRefreshKeys())

  // Left sidebar group collapse state (groupKey => collapsed). Clicking group title toggles it.
  // Track tabs that have been activated (aligned with el-tab-pane lazy: mount after first activation, then keep mounted)
  const [renderedTabs, setRenderedTabs] = useState<Set<string>>(() => new Set([getInitialTab()]))
  useEffect(() => {
    setRenderedTabs((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])

  // ============ Navigation helper (keep path/params, only replace hash) ============
  const replaceHash = useCallback(
    (hash: string) => {
      navigate({ pathname: location.pathname, search: location.search, hash }, { replace: true })
    },
    [navigate, location.pathname, location.search]
  )

  // ============ Tab switch ============
  const handleTabChange = useCallback(
    (tabName: string | null) => {
      if (!tabName || !isAllowedTab(tabName)) return

      // Refresh only the clicked tab
      setTabRefreshKeys((prev) => {
        return { ...prev, [tabName]: (prev[tabName] || 0) + 1 }
      })

      setActiveTab(tabName)

      // Update URL hash without refreshing the whole page
      replaceHash(`#${tabName}`)
    },
    [isAllowedTab, replaceHash]
  )

  // ============ Handle project update ============
  const handleProjectUpdated = useCallback(
    (updatedProject: any) => {
      setCurrentProject(updatedProject)
      onProjectUpdated?.(updatedProject)
    },
    [onProjectUpdated, setCurrentProject]
  )

  // ============ Watch URL hash changes (browser back/forward) ============
  useEffect(() => {
    const hash = location.hash?.replace('#', '') || ''
    if (!hash) {
      if (activeTab !== fallbackTab) setActiveTab(fallbackTab)
      return
    }
    const tabName = hash
    if (!isAllowedTab(tabName)) {
      if (activeTab !== fallbackTab) setActiveTab(fallbackTab)
      replaceHash(`#${fallbackTab}`)
      return
    }
    if (tabName !== activeTab) setActiveTab(tabName)
  }, [activeTab, fallbackTab, isAllowedTab, location.hash, replaceHash])

  // ============ Watch project changes and refresh all tabs ============
  const prevProjectIdRef = useRef<string | undefined>(currentProject?.id)
  useEffect(() => {
    const newProjectId = currentProject?.id
    const oldProjectId = prevProjectIdRef.current
    prevProjectIdRef.current = newProjectId

    // Refresh all tab keys on project switch to force reloading components
    if (newProjectId && newProjectId !== oldProjectId) {
      // Refresh all tab keys
      setTabRefreshKeys((prev) => {
        const next = { ...prev }
        Object.keys(next).forEach((key) => {
          next[key] += 1
        })
        return next
      })

      navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash || `#${activeTab}`
        },
        { replace: true }
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id])

  // ============ Initialization ============
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      const project = useProjectStore.getState().currentProject
      if (!project?.id) {
        notifications.show({ color: 'yellow', message: t('project.settings.selectProjectFirst') })
        onBack()
        return
      }

      // Refresh project details (skip if data was fetched in the last 5 seconds to avoid duplicate requests after admin navigation)
      const staleThreshold = 5000
      if (Date.now() - useProjectStore.getState().lastDetailFetchedAt > staleThreshold) {
        try {
          const res: any = await getProjectDetailReq(project.id)
          if (!cancelled && res.data) {
            setCurrentProject(res.data)
          }
        } catch {
          // Use cached data when fetch fails
        }
      }

      // Add hash to main settings page if missing.
      if (!cancelled && !location.hash) {
        replaceHash(`#${activeTab}`)
      }
    }
    init()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ============ Render each tab content (lazy: mount only after activation) ============
  // Align with el-tab-pane lazy: mount on first activation and keep mounted. Mantine renders all panels by default;
  // render content only after tab enters renderedTabs.
  const isRendered = (name: string) => renderedTabs.has(name)
  const renderSuspendedTab = (name: string) => (
    <Suspense fallback={tabLoading}>{renderTabComponent(name)}</Suspense>
  )

  // Content component for each tab (lazy gate + refresh key), used by shell to render current tab.
  const renderTabComponent = (name: string): ReactNode => {
    if (!isAllowedTab(name)) return null
    const pid = currentProject?.id
    switch (name) {
      case 'basic':
        return isRendered('basic') ? (
          <BasicInfo
            key={tabRefreshKeys.basic}
            project={currentProject}
            onUpdated={handleProjectUpdated}
            onDelete={onDeleteProject}
          />
        ) : null
      case 'instructions':
        return isRendered('instructions') ? (
          <ProjectInstructions
            key={tabRefreshKeys.instructions}
            project={currentProject}
            onUpdated={handleProjectUpdated}
          />
        ) : null
      case 'chat-memory':
        return isRendered('chat-memory') ? (
          <ProjectChatMemory key={tabRefreshKeys['chat-memory']} projectId={pid} />
        ) : null
      case 'models':
        return isRendered('models') ? (
          <ModelConfig key={tabRefreshKeys.models} projectId={pid} />
        ) : null
      default:
        return null
    }
  }

  const navItem = (name: string, label: ReactNode, id?: string, pluginName?: string, nested = false) => (
    <SettingsNavItem key={name} id={id} pluginName={pluginName} nested={nested} active={activeTab === name} onClick={() => handleTabChange(name)}>
      {label}
    </SettingsNavItem>
  )

  return (
    <SettingsShell
      onBack={onBack}
      nav={
        <>
          {isAllowedTab('basic') && navItem('basic', t('project.settings.tabs.basic'))}
          {isAllowedTab('instructions') && navItem('instructions', t('project.settings.tabs.instructions'))}
          {isAllowedTab('chat-memory') && navItem('chat-memory', t('project.settings.tabs.chatMemory'))}
        </>
      }
    >
      <div className={styles.shellContent}>
        {hasProject ? renderSuspendedTab(activeTab) : <Text c="dimmed">{t('project.settings.noProject')}</Text>}
      </div>
    </SettingsShell>
  )
}
