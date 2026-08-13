export type ActivityState = 'running' | 'done' | 'error' | 'rejected' | 'stopped'
export type ApprovalInteractionState = 'requested' | 'approved' | 'rejected' | 'stopped' | 'error'
export type UserInputInteractionState = 'requested' | 'resolved' | 'stopped' | 'error'

function normalizedState(value: unknown): string {
  return String(value || '').toLowerCase()
}

function terminalInteractionFromTurn(turnStatus: unknown): 'stopped' | 'error' | null {
  const raw = normalizedState(turnStatus)
  if (raw === 'failed') return 'error'
  if (raw === 'completed' || raw === 'interrupted' || raw === 'expired') return 'stopped'
  return null
}

export function activityState(value: unknown, turnRunning: boolean): ActivityState {
  const raw = normalizedState(value)
  if (raw === 'running' || raw === 'inprogress' || raw === 'in_progress') {
    return turnRunning ? 'running' : 'stopped'
  }
  if (raw === 'failed' || raw === 'error' || raw === 'errored' || raw === 'notfound' || raw === 'not_found') {
    return 'error'
  }
  if (raw === 'declined' || raw === 'rejected') return 'rejected'
  if (raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled' || raw === 'stopped') return 'stopped'
  return 'done'
}

export function approvalInteractionState(
  title: unknown,
  status: unknown,
  localDecision?: 'approved' | 'rejected',
  turnStatus?: unknown
): ApprovalInteractionState {
  if (localDecision) return localDecision
  const raw = normalizedState(status || title)
  if (raw === 'approved') return 'approved'
  if (raw === 'declined' || raw === 'rejected') return 'rejected'
  if (raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled' || raw === 'stopped') return 'stopped'
  if (raw === 'failed' || raw === 'error' || raw === 'errored') return 'error'
  return terminalInteractionFromTurn(turnStatus) || 'requested'
}

export function userInputInteractionState(title: unknown, status: unknown, turnStatus?: unknown): UserInputInteractionState {
  const raw = normalizedState(status || title)
  if (raw === 'resolved' || raw === 'answered') return 'resolved'
  if (raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled' || raw === 'stopped') return 'stopped'
  if (raw === 'failed' || raw === 'error' || raw === 'errored') return 'error'
  return terminalInteractionFromTurn(turnStatus) || 'requested'
}

export function activityStateLabel(state: ActivityState): string {
  if (state === 'running') return '进行中'
  if (state === 'error') return '失败'
  if (state === 'rejected') return '已拒绝'
  if (state === 'stopped') return '已停止'
  return '已完成'
}
