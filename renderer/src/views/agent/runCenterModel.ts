import type { AgentRunEvent, AgentRunSummary } from '@/api/agent'

export const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_user_input',
  'recovering'
])

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  pending: '等待',
  running: '运行中',
  waiting_approval: '等待审批',
  waiting_user_input: '等待输入',
  interrupted: '已停止',
  skipped: '已跳过',
  failed: '失败',
  completed: '完成',
  ok: '完成',
  error: '失败',
  cancelled: '已取消',
  recovering: '恢复中',
  expired: '已过期',
  not_found: '不存在'
}

const STATUS_COLOR: Record<string, string> = {
  queued: 'gray',
  pending: 'gray',
  running: 'orange',
  waiting_approval: 'yellow',
  waiting_user_input: 'yellow',
  interrupted: 'gray',
  skipped: 'gray',
  failed: 'red',
  completed: 'teal',
  ok: 'teal',
  error: 'red',
  cancelled: 'gray',
  recovering: 'blue',
  expired: 'gray',
  not_found: 'gray'
}

export function runStatusLabel(status?: string | null) {
  const value = String(status || '').toLowerCase()
  return STATUS_LABEL[value] || status || '未知'
}

export function runStatusColor(status?: string | null) {
  return STATUS_COLOR[String(status || '').toLowerCase()] || 'gray'
}

export function canStopRun(run?: AgentRunSummary | null) {
  return Boolean(run && ACTIVE_RUN_STATUSES.has(String(run.status || '').toLowerCase()))
}

export function waitingRunMessage(run?: AgentRunSummary | null) {
  const status = String(run?.status || '').toLowerCase()
  if (status === 'waiting_approval') return '正在等待你确认高风险操作，Runner 已释放执行槽。'
  if (status === 'waiting_user_input') return '正在等待补充信息，Runner 已释放执行槽。'
  if (status === 'recovering') return '正在从已保存的运行点继续。'
  return ''
}

export function latestRunFailure(events: AgentRunEvent[] = []) {
  return [...events].reverse().find((event) =>
    Boolean(event.error_message || event.error_code) || /failed|error|interrupted/.test(String(event.event_type || ''))
  ) || null
}

export function compactRunValue(value: unknown, max = 160) {
  if (value == null || value === '') return ''
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) } catch { text = String(value) }
  }
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

export function runArtifactName(path?: string | null) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || '未命名产物'
}
