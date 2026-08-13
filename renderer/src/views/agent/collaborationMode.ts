export type CollaborationMode = 'default' | 'plan'

const COLLABORATION_MODES = new Set<CollaborationMode>(['default', 'plan'])

export function normalizeCollaborationMode(value: unknown): CollaborationMode {
  return COLLABORATION_MODES.has(value as CollaborationMode)
    ? value as CollaborationMode
    : 'default'
}

export function conversationCollaborationModeStorageKey(projectId: string, conversationId: string | null) {
  return projectId && conversationId
    ? `dsh-thread-collaboration-mode:${projectId}:${conversationId}`
    : ''
}

function projectCollaborationModeStorageKey(projectId: string) {
  return projectId ? `dsh-project-collaboration-mode:${projectId}` : ''
}

export function loadConversationCollaborationMode(
  projectId: string,
  conversationId: string | null
): CollaborationMode {
  try {
    const conversationKey = conversationCollaborationModeStorageKey(projectId, conversationId)
    const projectKey = projectCollaborationModeStorageKey(projectId)
    return normalizeCollaborationMode(
      (conversationKey ? localStorage.getItem(conversationKey) : null)
      || (projectKey ? localStorage.getItem(projectKey) : null)
    )
  } catch {
    return 'default'
  }
}

export function persistConversationCollaborationMode(
  projectId: string,
  conversationId: string | null,
  collaborationMode: CollaborationMode
) {
  try {
    const mode = normalizeCollaborationMode(collaborationMode)
    const projectKey = projectCollaborationModeStorageKey(projectId)
    const conversationKey = conversationCollaborationModeStorageKey(projectId, conversationId)
    if (projectKey) localStorage.setItem(projectKey, mode)
    if (conversationKey) localStorage.setItem(conversationKey, mode)
  } catch {
    /* ignore */
  }
}
