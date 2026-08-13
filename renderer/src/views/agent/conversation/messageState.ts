import type { ArtifactSelectionMetadata, Attachment } from '../ComposerActions'
import { basename } from '../folders'
import { loadAgentSettings } from '../AgentSettings'
import type {
  AgentBlock as Block,
  AgentMessage as Msg,
  AgentSkillSelection,
  AgentStreamTarget,
  AgentTurnPatch
} from '../stream/types'
import { dedupeStreamBlocks, mergeStreamBlock } from '../stream/reducer'

export const LARGE_PASTE_LIMIT_BYTES = 4000
export const LARGE_PASTE_NOTICE = '粘贴内容超过 4000 字节，已自动转换为 txt 附件。'

export function textByteLength(value: string) {
  return new TextEncoder().encode(value).length
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function artifactSelectionFromRaw(value: unknown): ArtifactSelectionMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, any>
  const format = String(raw.format || '').trim()
  const anchor = String(raw.anchor || '').trim()
  const label = String(raw.label || '').trim()
  if (!format || !anchor || !label) return null
  return {
    format,
    anchor,
    label,
    ...(raw.page ? { page: Number(raw.page) } : {}),
    ...(raw.sheet ? { sheet: String(raw.sheet) } : {}),
    ...(raw.address ? { address: String(raw.address) } : {}),
    ...(raw.object_id || raw.objectId ? { objectId: String(raw.object_id || raw.objectId) } : {}),
    ...(raw.kind ? { kind: String(raw.kind) } : {}),
    ...(raw.rect && typeof raw.rect === 'object' ? { rect: raw.rect } : {})
  }
}

export function attachmentArtifactSelections(attachment: Attachment): ArtifactSelectionMetadata[] {
  const multiple = Array.isArray(attachment.artifactSelections)
    ? attachment.artifactSelections.map(artifactSelectionFromRaw).filter(Boolean) as ArtifactSelectionMetadata[]
    : []
  if (multiple.length > 0) return multiple
  const single = artifactSelectionFromRaw(attachment.artifactSelection)
  return single ? [single] : []
}

function artifactSelectionForRequest(selection: ArtifactSelectionMetadata) {
  return {
    ...selection,
    ...(selection.objectId ? { object_id: selection.objectId } : {}),
    objectId: undefined
  }
}

export function attachmentFromBlock(block: Block): Attachment | null {
  if (block.type !== 'attachment') return null
  const meta = block.metadata || {}
  const path = String(meta.path || meta.file_path || block.content || '').trim()
  if (!path) return null
  const rawSelections = Array.isArray(meta.artifact_selections)
    ? meta.artifact_selections
    : Array.isArray(meta.artifactSelections)
      ? meta.artifactSelections
      : []
  const artifactSelections = rawSelections.map(artifactSelectionFromRaw).filter(Boolean) as ArtifactSelectionMetadata[]
  const legacySelection = artifactSelectionFromRaw(meta.artifact_selection || meta.artifactSelection)
  return {
    path,
    name: String(meta.name || block.content || path.split('/').filter(Boolean).pop() || path).trim(),
    isDir: Boolean(meta.is_dir || meta.isDir),
    mimeType: String(meta.mime_type || meta.mimeType || ''),
    size: Number(meta.size_bytes || meta.size || 0) || undefined,
    width: Number(meta.width || 0) || undefined,
    height: Number(meta.height || 0) || undefined,
    dshAttachment: meta.dsh_app_session_id && meta.dsh_attachment_id
      ? {
          appSessionId: String(meta.dsh_app_session_id),
          attachmentId: String(meta.dsh_attachment_id)
        }
      : undefined,
    artifactId: String(meta.artifact_id || meta.artifactId || '') || undefined,
    artifactVersionId: String(meta.artifact_version_id || meta.artifactVersionId || '') || undefined,
    artifactVersionNumber: Number(meta.artifact_version_number || meta.artifactVersionNumber || 0) || undefined,
    artifactSelections: artifactSelections.length > 0
      ? artifactSelections
      : legacySelection ? [legacySelection] : undefined,
    artifactSelection: legacySelection || undefined
  }
}

export function attachmentFromBranchDraft(item: any): Attachment | null {
  const path = String(item?.path || '').trim()
  if (!path) return null
  return {
    path,
    name: String(item?.name || basename(path)).trim(),
    isDir: Boolean(item?.is_dir),
    mimeType: String(item?.mime_type || ''),
    size: Number(item?.size_bytes || 0) || undefined,
    width: Number(item?.width || 0) || undefined,
    height: Number(item?.height || 0) || undefined
  }
}

export function optimisticSkillSelections(value: unknown, names: unknown): AgentSkillSelection[] {
  const raw = Array.isArray(value)
    ? value
    : (Array.isArray(names) ? names : []).map((name) => ({ selectionKey: name, name }))
  return raw.flatMap((item: any) => {
    const record = typeof item === 'string' ? { selectionKey: item, name: item } : item
    const selectionKey = String(record?.selectionKey || record?.selection_key || record?.name || '').trim()
    const name = String(record?.skillName || record?.name || selectionKey).trim()
    if (!selectionKey || !name) return []
    return [{
      selectionKey,
      name,
      qualifiedName: String(record?.qualifiedName || record?.qualified_name || '') || null,
      displayName: String(record?.displayName || record?.display_name || record?.label || name),
      source: String(record?.source || '') || null,
      scope: String(record?.scope || '') || null,
      pluginName: String(record?.pluginName || record?.plugin_name || '') || null,
      version: String(record?.version || '') || null,
      digest: String(record?.digest || '') || null,
      selectionMode: 'explicit'
    }]
  })
}

export function assistantCopyText(blocks: Block[]) {
  const readable = blocks.filter((block) =>
    ['text', 'markdown', 'agentMessage', 'error'].includes(block.type) && String(block.content || '').trim()
  )
  return readable.map((block) => String(block.content || '').trim()).filter(Boolean).join('\n\n')
}

export function attachmentBlock(attachment: Attachment, index: number): Block {
  return {
    id: `att-${Date.now()}-${index}`,
    type: 'attachment',
    content: attachment.name,
    display_type: 'file',
    metadata: {
      path: attachment.path,
      name: attachment.name,
      is_dir: Boolean(attachment.isDir),
      ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
      ...(attachment.size ? { size_bytes: attachment.size } : {}),
      ...(attachment.width ? { width: attachment.width } : {}),
      ...(attachment.height ? { height: attachment.height } : {}),
      ...(attachment.artifactId ? { artifact_id: attachment.artifactId } : {}),
      ...(attachment.artifactVersionId ? { artifact_version_id: attachment.artifactVersionId } : {}),
      ...(attachment.artifactVersionNumber ? { artifact_version_number: attachment.artifactVersionNumber } : {}),
      ...(attachmentArtifactSelections(attachment).length ? {
        artifact_selections: attachmentArtifactSelections(attachment).map(artifactSelectionForRequest),
        artifact_selection: artifactSelectionForRequest(attachmentArtifactSelections(attachment)[0])
      } : {})
    }
  }
}

export function normalizeAttachmentsForRequest(items: Attachment[] = []) {
  return items
    .filter((item) => item?.path)
    .map((item) => ({
      path: item.path,
      name: item.name,
      is_dir: Boolean(item.isDir),
      ...(item.mimeType ? { mime_type: item.mimeType } : {}),
      ...(item.size ? { size_bytes: item.size } : {}),
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.artifactId ? { artifact_id: item.artifactId } : {}),
      ...(item.artifactVersionId ? { artifact_version_id: item.artifactVersionId } : {}),
      ...(item.artifactVersionNumber ? { artifact_version_number: item.artifactVersionNumber } : {}),
      ...(attachmentArtifactSelections(item).length ? {
        artifact_selections: attachmentArtifactSelections(item).map(artifactSelectionForRequest),
        artifact_selection: artifactSelectionForRequest(attachmentArtifactSelections(item)[0])
      } : {})
    }))
}


type TaskNotificationTone = 'action' | 'success' | 'error'

const TASK_NOTIFICATION_TONES: Record<TaskNotificationTone, Array<{ frequency: number; start: number; duration: number }>> = {
  action: [
    { frequency: 880, start: 0, duration: 0.1 },
    { frequency: 880, start: 0.16, duration: 0.12 }
  ],
  success: [
    { frequency: 660, start: 0, duration: 0.09 },
    { frequency: 920, start: 0.1, duration: 0.13 }
  ],
  error: [
    { frequency: 520, start: 0, duration: 0.11 },
    { frequency: 330, start: 0.13, duration: 0.16 }
  ]
}

function playTaskNotificationSound(tone: TaskNotificationTone = 'success') {
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) return
    const ctx = new AudioContextCtor()
    const now = ctx.currentTime
    const notes = TASK_NOTIFICATION_TONES[tone] || TASK_NOTIFICATION_TONES.success
    for (const note of notes) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = now + note.start
      const end = start + note.duration
      oscillator.type = tone === 'error' ? 'triangle' : 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(tone === 'action' ? 0.07 : 0.052, start + 0.018)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(end)
    }
    const totalMs = Math.max(...notes.map((note) => note.start + note.duration)) * 1000
    window.setTimeout(() => ctx.close().catch(() => undefined), totalMs + 120)
  } catch {
    /* ignore */
  }
}

export function sendTaskNotification(title: string, body: string, tone: TaskNotificationTone = 'success') {
  const settings = loadAgentSettings()
  if (!settings.taskNotify) return
  if (settings.notifySound) playTaskNotificationSound(tone)
  if (!('Notification' in window)) return
  const show = () => {
    try {
      new Notification(title, { body, silent: true })
    } catch {
      /* ignore */
    }
  }
  if (Notification.permission === 'granted') {
    show()
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') show()
    }).catch(() => undefined)
  }
}

function turnId(index: number) {
  return `turn-${index}`
}

export function messageTurnId(message: Msg, index: number) {
  return message.id || message.turnId ? `turn-${message.id || message.turnId}` : turnId(index)
}

export function messageText(message: Msg) {
  return message.blocks
    .map((block) => block.content)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}


function targetAssistantIndex(messages: Msg[], target?: AgentStreamTarget) {
  if (target?.turnId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant' && messages[index]?.turnId === target.turnId) return index
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'assistant' && !message.turnId && message.status === 'pending') return index
    }
    return -1
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && (!message.turnId || message.status === 'pending' || message.status === 'inProgress')) return index
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index
  }
  return -1
}

export function applyBlockToMessages(prev: Msg[], b: Block, target?: AgentStreamTarget) {
  const next = [...prev]
  const messageIndex = targetAssistantIndex(next, target)
  if (messageIndex < 0) return next
  const message = next[messageIndex]
  const blocks = dedupeStreamBlocks(message.blocks)
  const i = blocks.findIndex((x) => x.id === b.id)
  if (i >= 0) {
    const prevBlock = blocks[i]
    if (b.metadata?.mode === 'append') {
      blocks[i] = mergeStreamBlock(prevBlock, b)
    } else if ((b.type === 'confirm' || b.type === 'user_input') && !b.content) {
      blocks[i] = { ...prevBlock, ...b, content: prevBlock.content }
    } else {
      blocks[i] = b
    }
  } else {
    blocks.push(b)
  }
  next[messageIndex] = {
    ...message,
    blocks,
    threadId: target?.threadId || message.threadId,
    turnId: target?.turnId || message.turnId
  }
  return next
}

export function removeBlockFromMessages(prev: Msg[], blockId: string, target?: AgentStreamTarget) {
  if (!blockId) return prev
  const messageIndex = targetAssistantIndex(prev, target)
  if (messageIndex < 0) return prev
  const message = prev[messageIndex]
  const blocks = message.blocks.filter((block) => block.id !== blockId)
  if (blocks.length === message.blocks.length) return prev
  const next = [...prev]
  next[messageIndex] = { ...message, blocks }
  return next
}

export function applyTurnToMessages(prev: Msg[], turn: AgentTurnPatch) {
  const next = [...prev]
  let messageIndex = targetAssistantIndex(next, turn)
  if (messageIndex < 0) {
    next.push({
      id: turn.messageId || turn.turnId || `assistant-${Date.now()}`,
      role: 'assistant',
      blocks: [],
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: turn.status || 'pending'
    })
    messageIndex = next.length - 1
  }
  const message = next[messageIndex]
  next[messageIndex] = {
    ...message,
    id: turn.messageId || message.id || turn.turnId || undefined,
    threadId: turn.threadId || message.threadId,
    turnId: turn.turnId || message.turnId,
    status: turn.status || message.status,
    answerStatus: turn.answerStatus || message.answerStatus,
    answerItemId: turn.answerItemId ?? message.answerItemId,
    answerSource: turn.answerSource ?? message.answerSource,
    answerRejectionCode: turn.answerRejectionCode ?? message.answerRejectionCode,
    startedAtMs: turn.startedAtMs ?? message.startedAtMs,
    completedAtMs: turn.completedAtMs ?? message.completedAtMs,
    durationMs: turn.durationMs ?? message.durationMs,
    error: turn.error ?? message.error
  }
  return next
}

export function insertSteerUserMessage(prev: Msg[], message: Msg, turnId: string): Msg[] {
  const targetTurnId = String(turnId || '').trim()
  if (!targetTurnId) return [...prev, message]
  const assistantIndex = prev.findIndex((item) => (
    item.role === 'assistant'
    && item.turnId === targetTurnId
    && (item.status === 'pending' || item.status === 'inProgress')
  ))
  if (assistantIndex < 0) return [...prev, message]
  return [...prev.slice(0, assistantIndex), message, ...prev.slice(assistantIndex)]
}
