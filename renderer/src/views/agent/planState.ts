import type { PlanStep } from '@/layout/workstation/Workstation'

const COLLAPSED_STEP_LIMIT = 6

export interface PlanProgressSummary {
  completed: number
  failed: number
  skipped: number
  interrupted: number
  remaining: number
  activeIndex: number
  active: boolean
  title: string
  label: string
}

export interface PlanStepWindow {
  start: number
  end: number
  hiddenBefore: number
  hiddenAfter: number
}

function parsePlanValue(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value || '[]')
  } catch {
    return []
  }
}

function planStepState(step: any): PlanStep['state'] {
  const status = String(step?.status || step?.state || '').toLowerCase()
  if (['done', 'completed', 'complete'].includes(status)) return 'done'
  if (['running', 'doing', 'in_progress', 'inprogress'].includes(status)) return 'running'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'skipped'
  if (status === 'interrupted') return 'interrupted'
  return 'todo'
}

/** Normalize native and extension plan payloads at the UI boundary. */
export function normalizePlanSteps(value: unknown): PlanStep[] {
  const parsed = parsePlanValue(value)
  const steps = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.steps) ? (parsed as any).steps : []
  return steps
    .map((step: any) => ({
      title: String(step?.title || step?.step || step?.name || '').trim(),
      detail: String(step?.detail || step?.description || '').trim() || undefined,
      state: planStepState(step)
    }) satisfies PlanStep)
    .filter((step: PlanStep) => step.title)
}

export function summarizePlanProgress(steps: PlanStep[], turnRunning: boolean): PlanProgressSummary {
  const completed = steps.filter((step) => step.state === 'done').length
  const failed = steps.filter((step) => step.state === 'failed').length
  const skipped = steps.filter((step) => step.state === 'skipped').length
  const interrupted = steps.filter((step) => step.state === 'interrupted').length
  const remaining = steps.filter((step) => ['running', 'todo'].includes(step.state)).length
  const activeIndex = steps.findIndex((step) => step.state === 'running')
  const active = turnRunning && activeIndex >= 0
  return {
    completed,
    failed,
    skipped,
    interrupted,
    remaining,
    activeIndex,
    active,
    title: active
      ? '正在执行计划'
      : failed > 0
        ? '计划未完成'
        : interrupted > 0
          ? '计划已停止'
          : remaining === 0
            ? '计划已完成'
            : '计划进度',
    label: [
      `${completed}/${steps.length} 已完成`,
      failed ? `${failed} 项失败` : '',
      skipped ? `${skipped} 项跳过` : '',
      interrupted ? `${interrupted} 项停止` : '',
      remaining ? `${remaining} 项未完成` : ''
    ].filter(Boolean).join(' · ')
  }
}

export function planStepWindow(steps: PlanStep[], expanded: boolean): PlanStepWindow {
  if (expanded || steps.length <= COLLAPSED_STEP_LIMIT) {
    return { start: 0, end: steps.length, hiddenBefore: 0, hiddenAfter: 0 }
  }
  const current = steps.findIndex((step) => step.state === 'running')
  const next = steps.findIndex((step) => step.state === 'todo')
  const focus = current >= 0 ? current : next >= 0 ? next : steps.length - 1
  const start = Math.min(Math.max(focus - 2, 0), steps.length - COLLAPSED_STEP_LIMIT)
  const end = start + COLLAPSED_STEP_LIMIT
  return {
    start,
    end,
    hiddenBefore: start,
    hiddenAfter: steps.length - end
  }
}

export function planStepStatus(step: PlanStep, active: boolean) {
  if (step.state === 'done') return '已完成'
  if (step.state === 'running') return active ? '进行中' : '未完成'
  if (step.state === 'failed') return '失败'
  if (step.state === 'skipped') return '已跳过'
  if (step.state === 'interrupted') return '已停止'
  return '待处理'
}
