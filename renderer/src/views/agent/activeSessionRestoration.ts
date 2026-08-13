export const AGENT_ACTIVE_SESSION_STORAGE_KEY = 'dsh-active-session'

interface RestorableWorkspace {
  id: string
}

export interface AgentActiveSessionState {
  activeWs: string
  activeId: string | null
}

interface ActiveSessionStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

interface RestoreActiveWorkspaceOptions<T extends RestorableWorkspace> {
  saved: AgentActiveSessionState
  currentProjectId?: string | null
  projects: T[]
  chatWorkspaceId: string
}

export function loadAgentActiveSessionState(
  storage: ActiveSessionStorage = localStorage
): AgentActiveSessionState {
  try {
    const raw = storage.getItem(AGENT_ACTIVE_SESSION_STORAGE_KEY)
    if (!raw) return { activeWs: '', activeId: null }
    const parsed = JSON.parse(raw) as Partial<AgentActiveSessionState>
    return {
      activeWs: typeof parsed.activeWs === 'string' ? parsed.activeWs : '',
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null
    }
  } catch {
    return { activeWs: '', activeId: null }
  }
}

export function saveAgentActiveSessionState(
  state: AgentActiveSessionState,
  storage: ActiveSessionStorage = localStorage
) {
  try {
    if (state.activeWs) {
      storage.setItem(AGENT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(state))
    } else {
      storage.removeItem(AGENT_ACTIVE_SESSION_STORAGE_KEY)
    }
  } catch {
    // 本地偏好为尽力而为，不影响会话本身。
  }
}

export function clearAgentActiveSessionState(storage: ActiveSessionStorage = localStorage) {
  try {
    storage.removeItem(AGENT_ACTIVE_SESSION_STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function resolveRestoredAgentWorkspace<T extends RestorableWorkspace>({
  saved,
  currentProjectId,
  projects,
  chatWorkspaceId
}: RestoreActiveWorkspaceOptions<T>) {
  const savedProject = projects.find((project) => project.id === saved.activeWs)
  const savedWorkspaceValid = saved.activeWs === chatWorkspaceId || Boolean(savedProject)
  const currentProject = currentProjectId
    ? projects.find((project) => project.id === currentProjectId)
    : undefined
  const activeWs = savedWorkspaceValid
    ? saved.activeWs
    : currentProject?.id || projects[0]?.id || chatWorkspaceId
  const activeProject = activeWs === chatWorkspaceId
    ? null
    : projects.find((project) => project.id === activeWs) || null

  return {
    activeWs,
    activeId: savedWorkspaceValid && saved.activeWs === activeWs ? saved.activeId : null,
    currentProject: activeProject,
    savedWorkspaceValid
  }
}
