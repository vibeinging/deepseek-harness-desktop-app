import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTIVE_SESSION_STORAGE_KEY,
  clearAgentActiveSessionState,
  loadAgentActiveSessionState,
  resolveRestoredAgentWorkspace,
  saveAgentActiveSessionState
} from './activeSessionRestoration'

const CHAT_WORKSPACE_ID = '__chat__'
const projects = [
  { id: 'project-a', name: '项目 A' },
  { id: 'project-b', name: '项目 B' }
]

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
}

describe('agent active session restoration', () => {
  it('uses the saved workspace as both the visible workspace and global project context', () => {
    expect(
      resolveRestoredAgentWorkspace({
        saved: { activeWs: 'project-b', activeId: 'conversation-b' },
        currentProjectId: 'project-a',
        projects,
        chatWorkspaceId: CHAT_WORKSPACE_ID,
      }),
    ).toEqual({
      activeWs: 'project-b',
      activeId: 'conversation-b',
      currentProject: projects[1],
      savedWorkspaceValid: true,
    })
  })

  it('drops a stale saved session and falls back to the current project', () => {
    expect(
      resolveRestoredAgentWorkspace({
        saved: {
          activeWs: 'deleted-project',
          activeId: 'deleted-conversation'
        },
        currentProjectId: 'project-a',
        projects,
        chatWorkspaceId: CHAT_WORKSPACE_ID,
      }),
    ).toEqual({
      activeWs: 'project-a',
      activeId: null,
      currentProject: projects[0],
      savedWorkspaceValid: false,
    })
  })

  it('clears the global project when restoring the global chat workspace', () => {
    expect(
      resolveRestoredAgentWorkspace({
        saved: { activeWs: CHAT_WORKSPACE_ID, activeId: 'chat-conversation' },
        currentProjectId: 'project-a',
        projects,
        chatWorkspaceId: CHAT_WORKSPACE_ID,
      }),
    ).toEqual({
      activeWs: CHAT_WORKSPACE_ID,
      activeId: 'chat-conversation',
      currentProject: null,
      savedWorkspaceValid: true,
    })
  })

  it('falls back to the first available project when both saved and current projects are stale', () => {
    expect(
      resolveRestoredAgentWorkspace({
        saved: {
          activeWs: 'deleted-project',
          activeId: 'deleted-conversation'
        },
        currentProjectId: 'another-deleted-project',
        projects,
        chatWorkspaceId: CHAT_WORKSPACE_ID,
      }),
    ).toEqual({
      activeWs: 'project-a',
      activeId: null,
      currentProject: projects[0],
      savedWorkspaceValid: false,
    })
  })

  it('persists an explicit project selection as the next Agent workspace intent', () => {
    const storage = memoryStorage()
    saveAgentActiveSessionState({ activeWs: 'local-project', activeId: null }, storage)

    expect(loadAgentActiveSessionState(storage)).toEqual({
      activeWs: 'local-project',
      activeId: null
    })
    expect(JSON.parse(storage.getItem(AGENT_ACTIVE_SESSION_STORAGE_KEY) || '{}')).toEqual({
      activeWs: 'local-project',
      activeId: null
    })

    clearAgentActiveSessionState(storage)
    expect(loadAgentActiveSessionState(storage)).toEqual({ activeWs: '', activeId: null })
  })
})
