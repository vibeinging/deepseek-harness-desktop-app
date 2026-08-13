import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconCircle,
  IconCircleCheckFilled,
  IconLoader2,
  IconMaximize,
  IconMinus,
  IconPlayerStop
} from '@tabler/icons-react'
import type { PlanStep } from '@/layout/workstation/Workstation'
import { planStepStatus, planStepWindow, summarizePlanProgress } from './planState'
import styles from './agent.module.scss'

type PlanFloatSide = 'left' | 'right'
type PlanFloatAnchor = { side: PlanFloatSide; offsetX: number; y: number }
type PlanFloatPosition = PlanFloatAnchor & { x: number }

const PLAN_FLOAT_STORAGE_KEY = 'dsh-plan-float-position'
const PLAN_FLOAT_EDGE_GAP = 16
const PLAN_FLOAT_MIN_GAP = 8

function StepIcon({ state, active }: { state: PlanStep['state']; active: boolean }) {
  if (state === 'done') return <IconCircleCheckFilled size={15} className={styles.planFloatDoneIcon} />
  if (state === 'failed') return <IconAlertCircle size={15} className={styles.planFloatFailedIcon} />
  if (state === 'interrupted') return <IconPlayerStop size={15} className={styles.planFloatInterruptedIcon} />
  if (state === 'skipped') return <IconMinus size={15} className={styles.planFloatSkippedIcon} />
  if (active) return <IconLoader2 size={15} className={styles.planFloatRunningIcon} />
  return <IconCircle size={14} className={styles.planFloatTodoIcon} />
}

function loadAnchor(): PlanFloatAnchor | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAN_FLOAT_STORAGE_KEY) || 'null')
    if (
      (raw?.side === 'left' || raw?.side === 'right') &&
      Number.isFinite(raw?.offsetX) &&
      Number.isFinite(raw?.y)
    ) {
      return { side: raw.side, offsetX: Number(raw.offsetX), y: Number(raw.y) }
    }
    if (Number.isFinite(raw?.y)) return { side: 'right', offsetX: PLAN_FLOAT_EDGE_GAP, y: Number(raw.y) }
  } catch {
    // Ignore invalid local state and use the default anchor.
  }
  return null
}

function saveAnchor(anchor: PlanFloatAnchor) {
  localStorage.setItem(
    PLAN_FLOAT_STORAGE_KEY,
    JSON.stringify({ side: anchor.side, offsetX: Math.round(anchor.offsetX), y: Math.round(anchor.y) })
  )
}

function measureFloat(node: HTMLElement, parent: HTMLElement) {
  const parentRect = parent.getBoundingClientRect()
  const width = node.offsetWidth || node.getBoundingClientRect().width
  const height = node.offsetHeight || node.getBoundingClientRect().height
  return { parentRect, width, height }
}

function clampAnchorToParent(node: HTMLElement, parent: HTMLElement, anchor: PlanFloatAnchor): PlanFloatPosition {
  const { parentRect, width, height } = measureFloat(node, parent)
  const maxX = Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - PLAN_FLOAT_MIN_GAP)
  const offsetX = Math.max(PLAN_FLOAT_MIN_GAP, Math.min(maxX, anchor.offsetX))
  const y = Math.max(
    PLAN_FLOAT_MIN_GAP,
    Math.min(Math.max(PLAN_FLOAT_MIN_GAP, parentRect.height - height - PLAN_FLOAT_MIN_GAP), anchor.y)
  )
  const x = anchor.side === 'right'
    ? Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - offsetX)
    : offsetX
  return { side: anchor.side, offsetX, x, y }
}

function anchorFromPosition(node: HTMLElement, parent: HTMLElement, position: { x: number; y: number }): PlanFloatPosition {
  const { parentRect, width } = measureFloat(node, parent)
  const maxX = Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - PLAN_FLOAT_MIN_GAP)
  const x = Math.max(PLAN_FLOAT_MIN_GAP, Math.min(maxX, position.x))
  const rightOffset = Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - x)
  const side: PlanFloatSide = x <= rightOffset ? 'left' : 'right'
  return clampAnchorToParent(node, parent, {
    side,
    offsetX: side === 'left' ? x : rightOffset,
    y: position.y
  })
}

function samePosition(a: PlanFloatPosition | null, b: PlanFloatPosition) {
  return a?.side === b.side
    && Math.abs(a.offsetX - b.offsetX) < 0.5
    && Math.abs(a.x - b.x) < 0.5
    && Math.abs(a.y - b.y) < 0.5
}

export default function PlanStatusFloat({ plan, running }: { plan: PlanStep[]; running?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const storedAnchorRef = useRef<PlanFloatAnchor | null>(loadAnchor())
  const [position, setPosition] = useState<PlanFloatPosition | null>(null)
  const [minimized, setMinimized] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => summarizePlanProgress(plan, Boolean(running)), [plan, running])
  const stepWindow = useMemo(() => planStepWindow(plan, expanded), [expanded, plan])

  useEffect(() => {
    const node = ref.current
    const parent = node?.parentElement
    if (!node || !parent) return undefined

    const syncAnchoredPosition = () => {
      setPosition((previous) => {
        const anchor = previous || storedAnchorRef.current || { side: 'right', offsetX: PLAN_FLOAT_EDGE_GAP, y: 14 }
        const next = clampAnchorToParent(node, parent, anchor)
        if (samePosition(previous, next)) return previous
        storedAnchorRef.current = { side: next.side, offsetX: next.offsetX, y: next.y }
        saveAnchor(storedAnchorRef.current)
        return next
      })
    }

    const frame = window.requestAnimationFrame(syncAnchoredPosition)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncAnchoredPosition)
    observer?.observe(parent)
    observer?.observe(node)
    window.addEventListener('resize', syncAnchoredPosition)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', syncAnchoredPosition)
    }
  }, [expanded, minimized, plan.length])

  if (!plan.length) return null

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const node = ref.current
    const parent = node?.parentElement
    if (!node || !parent) return
    event.preventDefault()

    const nodeRect = node.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    const pointerOffsetX = event.clientX - nodeRect.left
    const pointerOffsetY = event.clientY - nodeRect.top
    let latest = anchorFromPosition(node, parent, {
      x: nodeRect.left - parentRect.left,
      y: nodeRect.top - parentRect.top
    })

    document.body.dataset.ahaDraggingPlan = 'true'
    const onMove = (moveEvent: PointerEvent) => {
      latest = anchorFromPosition(node, parent, {
        x: moveEvent.clientX - parentRect.left - pointerOffsetX,
        y: moveEvent.clientY - parentRect.top - pointerOffsetY
      })
      setPosition(latest)
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.removeAttribute('data-dsh-dragging-plan')
      storedAnchorRef.current = { side: latest.side, offsetX: latest.offsetX, y: latest.y }
      saveAnchor(storedAnchorRef.current)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const visibleSteps = plan.slice(stepWindow.start, stepWindow.end)
  const truncated = stepWindow.hiddenBefore > 0 || stepWindow.hiddenAfter > 0

  return (
    <aside
      ref={ref}
      className={`${styles.planFloat} ${minimized ? styles.planFloatMinimized : ''}`}
      aria-label="当前计划执行状态"
      data-plan-float
      data-running={running ? 'true' : undefined}
      data-minimized={minimized ? 'true' : undefined}
      data-anchor={position?.side}
      style={position ? { left: position.x, top: position.y, right: 'auto' } : undefined}
    >
      <div className={styles.planFloatHeader} onPointerDown={startDrag}>
        <div className={styles.planFloatHeaderText}>
          <div className={styles.planFloatTitle}>{summary.title}</div>
          <div className={styles.planFloatCurrent} role="status" aria-live="polite" data-plan-summary title={summary.label}>
            {summary.label}
          </div>
        </div>
        <div className={styles.planFloatActions}>
          <span className={styles.planFloatPulse} aria-hidden="true" />
          <button
            type="button"
            className={styles.planFloatAction}
            aria-label={minimized ? '展开计划浮窗' : '最小化计划浮窗'}
            title={minimized ? '展开' : '最小化'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMinimized((value) => !value)}
          >
            {minimized ? <IconMaximize size={13} stroke={1.8} /> : <IconMinus size={13} stroke={1.8} />}
          </button>
        </div>
      </div>
      {!minimized && (
        <>
          <ol className={styles.planFloatSteps} aria-label={`计划步骤，共 ${plan.length} 项`}>
            {stepWindow.hiddenBefore > 0 && <li className={styles.planFloatGap}>前面还有 {stepWindow.hiddenBefore} 个步骤</li>}
            {visibleSteps.map((step, offset) => {
              const index = stepWindow.start + offset
              const active = summary.active && index === summary.activeIndex
              return (
                <li
                  key={`${index}:${step.title}`}
                  className={styles.planFloatStep}
                  data-plan-step={index + 1}
                  data-state={step.state}
                  data-active={active ? 'true' : 'false'}
                  aria-current={active ? 'step' : undefined}
                >
                  <StepIcon state={step.state} active={active} />
                  <span className={styles.planFloatStepBody}>
                    <strong className={styles.planFloatStepTitle} title={step.title}>{step.title}</strong>
                    {step.detail && <small className={styles.planFloatStepDetail} title={step.detail}>{step.detail}</small>}
                  </span>
                  <span className={styles.planFloatStepStatus}>{planStepStatus(step, active)}</span>
                </li>
              )
            })}
            {stepWindow.hiddenAfter > 0 && <li className={styles.planFloatGap}>后面还有 {stepWindow.hiddenAfter} 个步骤</li>}
          </ol>
          {(truncated || expanded && plan.length > 6) && (
            <button
              type="button"
              className={styles.planFloatExpand}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? '收起步骤' : `查看全部 ${plan.length} 个步骤`}
            </button>
          )}
        </>
      )}
    </aside>
  )
}
