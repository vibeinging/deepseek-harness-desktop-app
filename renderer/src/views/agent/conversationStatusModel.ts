export type ConversationStatusKind =
  | 'running'
  | 'needs_confirmation'
  | 'needs_reply'
  | 'ready'
  | 'failed'
  | 'stopped'

export interface ConversationStatusBadge {
  kind: ConversationStatusKind
  label: string
  description: string
}

export interface ConversationStatusInput {
  latestRunStatus?: string | null
  latestRunViewedAt?: string | null
  liveInteractionStatus?: string | null
  locallyRunning?: boolean
}

export const REVIEWABLE_CONVERSATION_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'interrupted',
  'expired'
])

export const ACTIVE_CONVERSATION_RUN_STATUSES = new Set([
  'pending',
  'queued',
  'running',
  'suspended',
  'waiting_approval',
  'waiting_user_input',
  'recovering'
])

function normalizeStatus(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

export function isReviewableConversationRunStatus(value: unknown) {
  return REVIEWABLE_CONVERSATION_RUN_STATUSES.has(normalizeStatus(value))
}

export function isActiveConversationRunStatus(value: unknown) {
  return ACTIVE_CONVERSATION_RUN_STATUSES.has(normalizeStatus(value))
}

export function conversationRuntimeState({
  localBusy,
  conversationId,
  latestRunId,
  latestRunStatus,
  liveInteractionStatus,
  locallyRunning = false
}: {
  localBusy: boolean
  conversationId?: string | null
  latestRunId?: string | null
  latestRunStatus?: string | null
  liveInteractionStatus?: string | null
  locallyRunning?: boolean
}) {
  const authoritativeActive = isActiveConversationRunStatus(latestRunStatus)
    || isActiveConversationRunStatus(liveInteractionStatus)
  const authoritativeTerminal = isReviewableConversationRunStatus(latestRunStatus)
    && !isActiveConversationRunStatus(liveInteractionStatus)
  const recovered = Boolean(
    !localBusy
    && conversationId
    && (authoritativeActive || (locallyRunning && !authoritativeTerminal))
  )

  return {
    busy: localBusy || recovered,
    recovered,
    authoritativeActive,
    stopRunId: recovered && latestRunId ? String(latestRunId) : null
  }
}

export function conversationStatusBadge({
  latestRunStatus,
  latestRunViewedAt,
  liveInteractionStatus,
  locallyRunning = false
}: ConversationStatusInput): ConversationStatusBadge | null {
  const liveStatus = normalizeStatus(liveInteractionStatus)
  if (liveStatus === 'waiting_approval') {
    return {
      kind: 'needs_confirmation',
      label: '需要确认',
      description: '任务正在等待你确认后继续'
    }
  }
  if (liveStatus === 'waiting_user_input' || liveStatus === 'suspended') {
    return {
      kind: 'needs_reply',
      label: '需要回复',
      description: '任务正在等待你补充信息'
    }
  }

  if (locallyRunning) {
    return {
      kind: 'running',
      label: '正在运行',
      description: '任务正在运行'
    }
  }

  const status = normalizeStatus(latestRunStatus)
  if (status === 'waiting_approval') {
    return {
      kind: 'needs_confirmation',
      label: '需要确认',
      description: '任务正在等待你确认后继续'
    }
  }
  if (status === 'waiting_user_input' || status === 'suspended') {
    return {
      kind: 'needs_reply',
      label: '需要回复',
      description: '任务正在等待你补充信息'
    }
  }
  if (isActiveConversationRunStatus(status)) {
    return {
      kind: 'running',
      label: '正在运行',
      description: status === 'recovering' ? '任务正在恢复并继续运行' : '任务正在运行'
    }
  }

  if (latestRunViewedAt) return null
  if (status === 'completed') {
    return {
      kind: 'ready',
      label: '完成待查看',
      description: '任务已经完成，等待你查看结果'
    }
  }
  if (status === 'failed') {
    return {
      kind: 'failed',
      label: '运行失败',
      description: '任务运行失败，等待你查看原因'
    }
  }
  if (status === 'interrupted') {
    return {
      kind: 'stopped',
      label: '已停止',
      description: '任务已经停止'
    }
  }
  if (status === 'expired') {
    return {
      kind: 'stopped',
      label: '已过期',
      description: '任务已经过期'
    }
  }
  return null
}
