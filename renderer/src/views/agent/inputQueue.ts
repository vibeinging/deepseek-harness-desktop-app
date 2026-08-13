import type { Attachment } from './ComposerActions'

export interface ConversationQueueItem {
  id: string
  text: string
  attachments?: Attachment[]
  extra?: Record<string, unknown>
}

type QueueStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

const STORAGE_PREFIX = 'dsh-thread-input-queue:v1'
const MAX_QUEUE_ITEMS = 50
const MAX_TEXT_LENGTH = 200_000
const MAX_ATTACHMENTS = 50

function defaultStorage(): QueueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeAttachment(value: unknown): Attachment | null {
  const input = recordValue(value)
  if (!input) return null
  const path = String(input.path || '').trim()
  if (!path) return null
  const name = String(input.name || path.split(/[\\/]/).pop() || path).trim()
  return {
    path,
    name,
    ...(input.isDir === true ? { isDir: true } : {}),
    ...(typeof input.mimeType === 'string' ? { mimeType: input.mimeType } : {}),
    ...(Number.isFinite(Number(input.size)) ? { size: Number(input.size) } : {}),
    ...(Number.isFinite(Number(input.width)) ? { width: Number(input.width) } : {}),
    ...(Number.isFinite(Number(input.height)) ? { height: Number(input.height) } : {})
  }
}

export function conversationInputQueueStorageKey(projectId: string, conversationId: string | null) {
  const project = String(projectId || '').trim()
  const conversation = String(conversationId || '').trim()
  return project && conversation ? `${STORAGE_PREFIX}:${project}:${conversation}` : ''
}

export function normalizeConversationInputQueue(value: unknown): ConversationQueueItem[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const items: ConversationQueueItem[] = []

  for (const raw of value.slice(0, MAX_QUEUE_ITEMS)) {
    const input = recordValue(raw)
    if (!input) continue
    const text = String(input.text || '').trim().slice(0, MAX_TEXT_LENGTH)
    const attachments = Array.isArray(input.attachments)
      ? input.attachments.slice(0, MAX_ATTACHMENTS).map(normalizeAttachment).filter(Boolean) as Attachment[]
      : []
    if (!text && attachments.length === 0) continue

    const rawId = String(input.id || '').trim()
    let id = rawId || `restored-${items.length + 1}`
    while (ids.has(id)) id = `${id}-${items.length + 1}`
    ids.add(id)

    const extra = recordValue(input.extra)
    items.push({
      id,
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(extra ? { extra } : {})
    })
  }
  return items
}

export function loadConversationInputQueue(
  projectId: string,
  conversationId: string | null,
  storage: QueueStorage | null = defaultStorage()
): ConversationQueueItem[] {
  const key = conversationInputQueueStorageKey(projectId, conversationId)
  if (!key || !storage) return []
  try {
    return normalizeConversationInputQueue(JSON.parse(storage.getItem(key) || '[]'))
  } catch {
    try { storage.removeItem(key) } catch { /* ignore unavailable storage */ }
    return []
  }
}

export function persistConversationInputQueue(
  projectId: string,
  conversationId: string | null,
  queue: ConversationQueueItem[],
  storage: QueueStorage | null = defaultStorage()
) {
  const key = conversationInputQueueStorageKey(projectId, conversationId)
  if (!key || !storage) return false
  try {
    const normalized = normalizeConversationInputQueue(queue)
    if (normalized.length === 0) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(normalized))
    return true
  } catch {
    return false
  }
}
