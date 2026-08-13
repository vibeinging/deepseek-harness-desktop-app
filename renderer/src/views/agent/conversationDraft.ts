import type { ArtifactSelectionMetadata, Attachment } from './ComposerActions'
import type { ReviewComment } from './WorkspaceChanges'

export type DraftSearchMode = 'auto' | 'required' | 'off'

export interface ConversationDraft {
  input: string
  attachments: Attachment[]
  reviewComments: ReviewComment[]
  searchMode: DraftSearchMode
  updatedAt: number
}

const STORAGE_PREFIX = 'dsh-conversation-draft:v1:'
const NEW_CONVERSATION_ID = '__new__'
const MAX_INPUT_LENGTH = 100_000
const MAX_ATTACHMENTS = 24
const MAX_REVIEW_COMMENTS = 50
const LEGACY_ARTIFACT_SELECTION_PREFIX = '请按我接下来的要求修改项目产物「'
const LEGACY_ARTIFACT_SELECTION_END = '保存为新版本，不覆盖历史。'

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function stripLegacyArtifactReferencePrompt(value: unknown) {
  const input = String(value || '').slice(0, MAX_INPUT_LENGTH)
  if (input.startsWith(LEGACY_ARTIFACT_SELECTION_PREFIX)) {
    const markerIndex = input.indexOf(LEGACY_ARTIFACT_SELECTION_END)
    if (markerIndex >= 0) return input.slice(markerIndex + LEGACY_ARTIFACT_SELECTION_END.length).trimStart()
  }
  return input.replace(
    /^项目产物「[^\n]{1,512}」v\d+（artifact_id: [^\n，]{1,256}，version_id: [^\n）]{1,256}）。\s*/,
    ''
  )
}

export function conversationDraftStorageKey(projectId: string, sessionId?: string | null) {
  const scope = `${String(projectId || '__chat__')}:${String(sessionId || NEW_CONVERSATION_ID)}`
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`
}

function cleanArtifactSelection(value: unknown): ArtifactSelectionMetadata | null {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  return raw
    && String(raw.format || '').trim()
    && String(raw.anchor || '').trim()
    && String(raw.label || '').trim()
    ? {
        format: String(raw.format).trim().slice(0, 32),
        anchor: String(raw.anchor).trim().slice(0, 1024),
        label: String(raw.label).trim().slice(0, 512),
        ...(Number.isFinite(Number(raw.page)) ? { page: Number(raw.page) } : {}),
        ...(String(raw.sheet || '').trim() ? { sheet: String(raw.sheet).trim().slice(0, 256) } : {}),
        ...(String(raw.address || '').trim() ? { address: String(raw.address).trim().slice(0, 64) } : {}),
        ...(String(raw.objectId || '').trim() ? { objectId: String(raw.objectId).trim().slice(0, 256) } : {}),
        ...(String(raw.kind || '').trim() ? { kind: String(raw.kind).trim().slice(0, 64) } : {}),
        ...(raw.rect && typeof raw.rect === 'object' ? {
          rect: {
            x: Number((raw.rect as Record<string, unknown>).x) || 0,
            y: Number((raw.rect as Record<string, unknown>).y) || 0,
            width: Number((raw.rect as Record<string, unknown>).width) || 0,
            height: Number((raw.rect as Record<string, unknown>).height) || 0
          }
        } : {})
      }
    : null
}

function cleanAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const path = String(item.path || '').trim().slice(0, 4096)
  if (!path) return null
  const rawSelections = Array.isArray(item.artifactSelections) ? item.artifactSelections : []
  const selections = rawSelections.map(cleanArtifactSelection).filter(Boolean) as ArtifactSelectionMetadata[]
  const legacySelection = cleanArtifactSelection(item.artifactSelection)
  return {
    path,
    name: String(item.name || path.split('/').pop() || path).trim().slice(0, 512),
    isDir: item.isDir === true,
    mimeType: String(item.mimeType || '').trim().slice(0, 256) || undefined,
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
    width: Number.isFinite(Number(item.width)) ? Number(item.width) : undefined,
    height: Number.isFinite(Number(item.height)) ? Number(item.height) : undefined,
    artifactId: String(item.artifactId || '').trim().slice(0, 256) || undefined,
    artifactVersionId: String(item.artifactVersionId || '').trim().slice(0, 256) || undefined,
    artifactVersionNumber: Number.isInteger(Number(item.artifactVersionNumber))
      && Number(item.artifactVersionNumber) > 0
      ? Number(item.artifactVersionNumber)
      : undefined,
    artifactSelections: selections.length > 0
      ? selections
      : legacySelection ? [legacySelection] : undefined,
    artifactSelection: legacySelection || undefined
  }
}

function cleanReviewComment(value: unknown): ReviewComment | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const id = String(item.id || '').trim().slice(0, 256)
  const path = String(item.path || '').trim().slice(0, 4096)
  const comment = String(item.comment || '').trim().slice(0, 8000)
  if (!id || !path || !comment) return null
  return {
    id,
    path,
    comment,
    side: item.side === 'old' ? 'old' : 'new',
    oldLine: item.oldLine != null && Number.isFinite(Number(item.oldLine)) ? Number(item.oldLine) : null,
    newLine: item.newLine != null && Number.isFinite(Number(item.newLine)) ? Number(item.newLine) : null,
    lineText: String(item.lineText || '').slice(0, 2000) || undefined,
    hunkId: String(item.hunkId || '').slice(0, 1000) || null,
    status: item.status === 'resolved' ? 'resolved' : 'open'
  }
}

function emptyDraft(): ConversationDraft {
  return {
    input: '',
    attachments: [],
    reviewComments: [],
    searchMode: 'auto',
    updatedAt: 0
  }
}

export function loadConversationDraft(
  projectId: string,
  sessionId?: string | null,
  storage: DraftStorage = localStorage
): ConversationDraft {
  const key = conversationDraftStorageKey(projectId, sessionId)
  try {
    const raw = storage.getItem(key)
    if (!raw) return emptyDraft()
    const value = JSON.parse(raw) as Record<string, unknown>
    const attachments = (Array.isArray(value.attachments) ? value.attachments : [])
      .slice(0, MAX_ATTACHMENTS)
      .map(cleanAttachment)
      .filter(Boolean) as Attachment[]
    const reviewComments = (Array.isArray(value.reviewComments) ? value.reviewComments : [])
      .slice(0, MAX_REVIEW_COMMENTS)
      .map(cleanReviewComment)
      .filter(Boolean) as ReviewComment[]
    const searchMode = ['auto', 'required', 'off'].includes(String(value.searchMode))
      ? value.searchMode as DraftSearchMode
      : 'auto'
    return {
      input: String(value.input || '').slice(0, MAX_INPUT_LENGTH),
      attachments,
      reviewComments,
      searchMode,
      updatedAt: Number(value.updatedAt || 0) || 0
    }
  } catch {
    try { storage.removeItem(key) } catch { /* ignore */ }
    return emptyDraft()
  }
}

export function persistConversationDraft(
  projectId: string,
  sessionId: string | null | undefined,
  draft: Omit<ConversationDraft, 'updatedAt'>,
  storage: DraftStorage = localStorage
) {
  const key = conversationDraftStorageKey(projectId, sessionId)
  try {
    if (!draft.input && !draft.attachments.length && !draft.reviewComments.length && draft.searchMode === 'auto') {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify({ ...draft, updatedAt: Date.now() }))
  } catch {
    // Draft recovery is best-effort and must never block the composer.
  }
}

export function clearConversationDraft(
  projectId: string,
  sessionId?: string | null,
  storage: DraftStorage = localStorage
) {
  try {
    storage.removeItem(conversationDraftStorageKey(projectId, sessionId))
  } catch {
    // Ignore unavailable or full local storage.
  }
}
