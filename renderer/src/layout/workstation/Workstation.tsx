import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Badge, Box, Button, Group, ScrollArea, Stack, Text } from '@mantine/core'
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconChartBar,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsRight,
  IconClock,
  IconDatabaseOff,
  IconMaximize,
  IconMinimize,
  IconLoader2,
  IconRefresh
} from '@tabler/icons-react'
import {
  getAgentSessionTraces,
  type AgentSessionTraceResponse,
  type AgentTraceRun,
  type AgentTraceSpan
} from '@/api/agent'
import TurnLocator, { type TurnLocatorMarker } from '@/components/TurnLocator'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import RunCenter from '@/views/agent/RunCenter'

export type ToolWhere = 'cloud' | 'local' | 'mcp'
export type StepState = 'done' | 'running' | 'todo' | 'failed' | 'skipped' | 'interrupted'
export type ArtifactKind = 'file' | 'table' | 'code' | 'image'

export interface PlanStep {
  title: string
  detail?: string
  state: StepState
}
export interface ToolCall {
  name: string
  where: ToolWhere
  status: 'ok' | 'running' | 'pending' | 'error'
  args?: string
  result?: string
}
export interface Artifact {
  name: string
  meta?: string
  kind: ArtifactKind
}
export interface SkillTrace {
  name: string
  runtime?: string | null
  status?: string | null
  reason?: string | null
}
export interface DataSource {
  name: string
  meta?: string
  ready?: boolean
}

export interface WorkstationProps {
  projectId?: string
  sessionId?: string | null
  hasStructured?: boolean
  showDataTools?: boolean
  running?: boolean
  tools?: ToolCall[]
  skills?: SkillTrace[]
  dataSources?: DataSource[]
  artifacts?: Artifact[]
  onRefresh?: () => void
  onCollapse?: () => void
  onConnectSource?: () => void
  hideHeader?: boolean
  reviewTarget?: { view: 'runs' | 'trace'; runId?: string | null; nonce?: number } | null
}

const KIND_LABEL: Record<string, string> = {
  agent: 'AGENT',
  llm: 'LLM',
  tool: 'TOOL',
  chain: 'CHAIN',
  retriever: 'RETR'
}

const KIND_COLOR: Record<string, string> = {
  agent: 'var(--mantine-color-grape-6)',
  llm: 'var(--mantine-color-blue-6)',
  tool: 'var(--mantine-color-cyan-6)',
  chain: 'var(--mantine-color-indigo-6)',
  retriever: 'var(--mantine-color-teal-6)'
}

function isError(status?: string | null) {
  const value = String(status || '').toLowerCase()
  return value === 'failed' || value === 'error'
}

function statusColor(status?: string | null) {
  const value = String(status || '').toLowerCase()
  if (value === 'completed' || value === 'ok') return 'teal'
  if (value === 'running' || value === 'pending') return 'orange'
  if (value === 'suspended') return 'yellow'
  if (isError(value)) return 'red'
  return 'gray'
}

function statusLabel(status?: string | null) {
  const value = String(status || '').toLowerCase()
  if (value === 'completed' || value === 'ok') return '完成'
  if (value === 'running') return '运行中'
  if (value === 'pending') return '等待'
  if (value === 'suspended') return '挂起'
  if (value === 'failed' || value === 'error') return '失败'
  return status || '未知'
}

function spanKey(span?: AgentTraceSpan | null) {
  return span?.externalSpanId || span?.id || ''
}

function spanRenderKey(span: AgentTraceSpan, index: number) {
  return spanKey(span) || `${span.name}-${span.depth || 0}-${index}`
}

function formatTime(value?: string | null) {
  if (!value) return ''
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return ''
  return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms?: number | null) {
  const n = Number(ms || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 ms'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

function formatToken(value?: number | null) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatOptionalToken(value?: number | null) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '-'
  return formatToken(n)
}

function runTime(run: AgentTraceRun) {
  return new Date(run.updatedAt || run.createdAt || run.finishedAt || '').getTime() || 0
}

function compareRuns(a: { run: AgentTraceRun; index: number }, b: { run: AgentTraceRun; index: number }) {
  const aq = Number(a.run.question?.questionNo || 0)
  const bq = Number(b.run.question?.questionNo || 0)
  if (aq > 0 && bq > 0 && aq !== bq) return aq - bq
  if (aq > 0 && bq <= 0) return -1
  if (aq <= 0 && bq > 0) return 1
  return runTime(a.run) - runTime(b.run) || a.index - b.index
}

function compactText(value?: string | null) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function rootSpan(run: AgentTraceRun) {
  const spans = run.trace?.spans || []
  return spans.find((span) => Number(span.depth || 0) === 0) || spans[0] || null
}

function childSpansOf(run: AgentTraceRun, parent?: AgentTraceSpan | null) {
  if (!parent) return []
  const spans = run.trace?.spans || []
  const parentKeys = new Set([
    spanKey(parent),
    parent.id || '',
    parent.externalSpanId || ''
  ].filter(Boolean))
  return spans.filter((span) => {
    if (span === parent) return false
    const directParentKeys = [
      span.parentId || '',
      span.externalParentSpanId || '',
      String(span.attrs?.parent_tool_call_id || ''),
      String(span.attrs?.parent_span_id || ''),
      String(span.attrs?.trace_parent_span_id || '')
    ].filter(Boolean)
    return directParentKeys.some((key) => parentKeys.has(key))
  })
}

function parentSpanOf(run: AgentTraceRun, span?: AgentTraceSpan | null) {
  if (!span) return null
  const spans = run.trace?.spans || []
  const parentKeys = [
    span.parentId || '',
    span.externalParentSpanId || '',
    String(span.attrs?.parent_tool_call_id || ''),
    String(span.attrs?.parent_span_id || ''),
    String(span.attrs?.trace_parent_span_id || '')
  ].filter(Boolean)
  if (!parentKeys.length) return null
  return spans.find((item) => {
    const keys = [spanKey(item), item.id || '', item.externalSpanId || ''].filter(Boolean)
    return keys.some((key) => parentKeys.includes(key))
  }) || null
}

function descendantSpansOf(run: AgentTraceRun, parent?: AgentTraceSpan | null) {
  if (!parent) return []
  const out: AgentTraceSpan[] = []
  const visited = new Set<string>()
  const visit = (node: AgentTraceSpan) => {
    for (const child of childSpansOf(run, node)) {
      const key = spanKey(child) || child.id || `${child.name}-${child.depth}-${out.length}`
      if (visited.has(key)) continue
      visited.add(key)
      out.push(child)
      visit(child)
    }
  }
  visit(parent)
  return out
}

function spanPath(run: AgentTraceRun, span?: AgentTraceSpan | null) {
  if (!span) return []
  const path: AgentTraceSpan[] = []
  const visited = new Set<string>()
  let current: AgentTraceSpan | null = span
  while (current) {
    const key = spanKey(current) || current.id || current.name
    if (visited.has(key)) break
    visited.add(key)
    path.unshift(current)
    current = parentSpanOf(run, current)
  }
  return path
}

interface TraceTokenParts {
  input: number
  output: number
  total: number
  cached: number
  cacheWrite: number
  reasoning: number
}

function numericAttr(span: AgentTraceSpan | null | undefined, ...keys: string[]) {
  if (!span?.attrs) return 0
  for (const key of keys) {
    const n = Number(span.attrs[key] || 0)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

function addTokenParts(a: TraceTokenParts, b: TraceTokenParts): TraceTokenParts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning
  }
}

function ownTokenParts(span?: AgentTraceSpan | null): TraceTokenParts {
  if (!span) return { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, reasoning: 0 }
  const input = Number(span.inTok || 0) || numericAttr(span, 'trace_input_tokens', 'input_tokens', 'prompt_tokens')
  const output = Number(span.outTok || 0) || numericAttr(span, 'trace_output_tokens', 'output_tokens', 'completion_tokens')
  const total = input + output || numericAttr(span, 'trace_total_tokens', 'total_tokens')
  return {
    input,
    output,
    total,
    cached: numericAttr(span, 'trace_cached_tokens', 'cached_tokens', 'cache_read_tokens'),
    cacheWrite: numericAttr(span, 'trace_cache_write_tokens', 'cache_write_tokens', 'cache_creation_input_tokens'),
    reasoning: numericAttr(span, 'trace_reasoning_output_tokens', 'reasoning_output_tokens', 'reasoning_tokens')
  }
}

function spanTokenParts(run: AgentTraceRun, span?: AgentTraceSpan | null): TraceTokenParts {
  const own = ownTokenParts(span)
  if (span && Number(span.depth || 0) === 0) {
    return descendantSpansOf(run, span).reduce((sum, child) => addTokenParts(sum, ownTokenParts(child)), own)
  }
  if (own.total || own.cached || own.cacheWrite || !span) return own
  return descendantSpansOf(run, span).reduce((sum, child) => addTokenParts(sum, ownTokenParts(child)), own)
}

function formatTokenParts(parts: TraceTokenParts) {
  if (!parts.total && !parts.cached && !parts.cacheWrite) return '-'
  const base = parts.total ? formatToken(parts.total) : '-'
  const cache = []
  if (parts.cached > 0) cache.push(`cache ${formatToken(parts.cached)}`)
  if (parts.cacheWrite > 0) cache.push(`write ${formatToken(parts.cacheWrite)}`)
  return cache.length ? `${base} (${cache.join(', ')})` : base
}

function tokenMetricItems(parts: TraceTokenParts) {
  if (!parts.total && !parts.cached && !parts.cacheWrite) return []
  return [
    { label: 'Token', value: formatOptionalToken(parts.total) },
    { label: '输入', value: formatOptionalToken(parts.input) },
    { label: '输出', value: formatOptionalToken(parts.output) },
    { label: '推理', value: formatToken(parts.reasoning) },
    { label: 'Cache', value: formatToken(parts.cached) },
    { label: 'Cache写', value: formatToken(parts.cacheWrite) }
  ]
}

function scopeTokenParts(run: AgentTraceRun, spans: AgentTraceSpan[]) {
  const empty: TraceTokenParts = { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, reasoning: 0 }
  return spans.reduce((sum, span) => addTokenParts(sum, spanTokenParts(run, span)), empty)
}

function spanKindCount(spans: AgentTraceSpan[], kind: string) {
  return spans.filter((span) => String(span.kind || '') === kind).length
}

function spanAttrText(span: AgentTraceSpan, key: string) {
  const value = span.attrs?.[key]
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function spanMetricItems(run: AgentTraceRun, span: AgentTraceSpan) {
  const tokens = spanTokenParts(run, span)
  const duration = Number(span.durMs || 0)
  const model = String(span.model || spanAttrText(span, 'model_id') || '').trim()
  const channel = spanAttrText(span, 'channel')
  const format = spanAttrText(span, 'format')
  const category = spanAttrText(span, 'msg_category')
  const childCount = childSpansOf(run, span).length
  const items: Array<{ label: string; value: string }> = []

  if (Number.isFinite(duration) && duration > 0) items.push({ label: '耗时', value: formatDuration(duration) })
  items.push(...tokenMetricItems(tokens))
  if (model && model !== 'primary') items.push({ label: '模型', value: model })
  if (channel) items.push({ label: '通道', value: channel })
  if (format) items.push({ label: '格式', value: format })
  if (category) items.push({ label: '类型', value: category })
  if (childCount > 0) items.push({ label: '子调用', value: String(childCount) })
  if (!items.length) items.push({ label: '类型', value: KIND_LABEL[String(span.kind || '')] || span.kind || 'SPAN' })
  return items
}

function userQuestionText(run: AgentTraceRun) {
  const explicit = compactText(run.question?.questionText)
  if (explicit) return explicit
  const input = compactText(rootSpan(run)?.input)
  if (input) return input
  return '用户问题'
}

function jsonText(value: unknown) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatDetailValue(value: unknown) {
  if (value == null || value === '') return { text: '', format: '' }
  if (typeof value !== 'string') {
    try {
      return { text: JSON.stringify(value, null, 2), format: 'JSON' }
    } catch {
      return { text: String(value), format: '' }
    }
  }
  const raw = value.trim()
  if (!raw) return { text: '', format: '' }
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return { text: JSON.stringify(JSON.parse(raw), null, 2), format: 'JSON' }
    } catch {
      return { text: value, format: '' }
    }
  }
  return { text: value, format: '' }
}

function EmptyState({
  icon,
  title,
  detail
}: {
  icon: React.ReactNode
  title: string
  detail?: string
}) {
  return (
    <Stack align="center" gap={8} py={42} px="lg" style={{ color: 'var(--mantine-color-dimmed)' }}>
      {icon}
      <Text size="13px" fw={600} c="dimmed" ta="center">
        {title}
      </Text>
      {detail && (
        <Text size="11.5px" c="dimmed" ta="center" style={{ maxWidth: 280, lineHeight: 1.5 }}>
          {detail}
        </Text>
      )}
    </Stack>
  )
}

function locateQuestion(run: AgentTraceRun) {
  const questionNo = Number(run.question?.questionNo || 0)
  if (!questionNo) return
  eventBus.emit(EVENT_TYPES.LOCATE_AGENT_QUESTION, {
    sessionId: run.sessionId,
    questionNo
  })
}

function RoundHeader({
  run,
  expanded,
  onToggle
}: {
  run: AgentTraceRun
  expanded: boolean
  onToggle: () => void
}) {
  const question = run.question
  const trace = run.trace
  const status = trace?.status || run.status
  const questionText = userQuestionText(run)
  const questionNo = Number(question?.questionNo || 0)
  const traceTokenText = trace ? formatTokenParts(spanTokenParts(run, rootSpan(run))) : ''
  const meta = [
    trace ? `${trace.spanCount} spans` : '0 spans',
    trace ? formatDuration(trace.durMs) : '',
    traceTokenText === '-' ? '' : `${traceTokenText} tokens`,
    formatTime(run.updatedAt || run.createdAt)
  ].filter(Boolean).join(' · ')

  return (
    <>
      <Group gap={9} align="center" wrap="nowrap" px={10} pt={9} pb={6}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            alignItems: 'center',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            padding: 0,
            textAlign: 'left'
          }}
        >
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="nowrap">
              <Text size="11px" fw={760} c="var(--dsh-text)">
                {questionNo ? `第 ${questionNo} 问` : '用户问题'}
              </Text>
              <Badge size="xs" variant="light" color={statusColor(status)}>
                {statusLabel(status)}
              </Badge>
            </Group>
            <Text size="12px" fw={620} truncate title={questionText}>
              {questionText}
            </Text>
            {meta && (
              <Text size="10.5px" c="dimmed" truncate>
                {meta}
              </Text>
            )}
          </Stack>
        </button>
        <ActionIcon variant="subtle" color="gray" size="sm" onClick={onToggle} aria-label={expanded ? '折叠本轮 Trace' : '展开本轮 Trace'}>
          <IconChevronRight
            size={15}
            style={{
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.14s ease'
            }}
          />
        </ActionIcon>
      </Group>
      {questionNo > 0 && (
        <Box px={10} pb={8}>
          <button
            type="button"
            onClick={() => locateQuestion(run)}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--dsh-muted)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 11,
              lineHeight: 1.4,
              padding: 0,
              textAlign: 'left'
            }}
          >
            定位到用户问题
          </button>
        </Box>
      )}
    </>
  )
}

function KindChip({ span }: { span: AgentTraceSpan }) {
  const kind = String(span.kind || 'span')
  const color = isError(span.status) ? 'var(--mantine-color-red-6)' : KIND_COLOR[kind] || 'var(--mantine-color-gray-6)'
  return (
    <Text
      component="span"
      size="9.5px"
      fw={760}
      style={{
        flex: '0 0 auto',
        minWidth: 34,
        color,
        border: `1px solid color-mix(in srgb, ${color} 42%, transparent)`,
        borderRadius: 5,
        padding: '1px 4px',
        textAlign: 'center',
        lineHeight: 1.35
      }}
    >
      {KIND_LABEL[kind] || kind.toUpperCase().slice(0, 5)}
    </Text>
  )
}

function WaterfallRow({
  run,
  span,
  maxEnd,
  scopeStart,
  depthOffset,
  childCount,
  active,
  onSelect,
  onDrill
}: {
  run: AgentTraceRun
  span: AgentTraceSpan
  maxEnd: number
  scopeStart: number
  depthOffset: number
  childCount: number
  active: boolean
  onSelect: () => void
  onDrill: () => void
}) {
  const start = Math.max(0, Number(span.startMs || 0) - scopeStart)
  const duration = Number(span.durMs || 0)
  const left = Math.max(0, Math.min(99, (start / maxEnd) * 100))
  const width = Math.max(1.2, Math.min(100 - left, (Math.max(duration, 1) / maxEnd) * 100))
  const color = isError(span.status) ? 'var(--mantine-color-red-6)' : KIND_COLOR[String(span.kind || '')] || 'var(--dsh-accent)'
  const tokens = spanTokenParts(run, span)
  const displayDepth = Math.max(0, Number(span.depth || 0) - depthOffset)

  return (
    <Box style={{ position: 'relative', minWidth: 0 }}>
      {childCount > 0 && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size={22}
          aria-label={`进入 ${span.name} 的子流程`}
          onClick={onDrill}
          style={{
            position: 'absolute',
            zIndex: 2,
            left: Math.min(28, displayDepth * 10) + 4,
            top: 5,
            color: active ? 'var(--dsh-text)' : 'var(--mantine-color-dimmed)',
            border: '1px solid color-mix(in srgb, var(--app-border) 76%, transparent)',
            background: active ? 'color-mix(in srgb, var(--dsh-accent) 12%, transparent)' : 'color-mix(in srgb, var(--dsh-surface) 76%, transparent)'
          }}
        >
          <IconChevronRight size={12} />
        </ActionIcon>
      )}
      <button
        type="button"
        onClick={onSelect}
      style={{
        width: '100%',
        minWidth: 0,
        minHeight: 32,
        display: 'grid',
        gridTemplateColumns: 'minmax(104px, 34%) minmax(86px, 1fr) minmax(44px, auto)',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        border: 0,
        borderRadius: 7,
        background: active ? 'color-mix(in srgb, var(--dsh-accent) 10%, transparent)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left'
      }}
    >
      <Group
        gap={6}
        wrap="nowrap"
        style={{
          minWidth: 0,
          paddingLeft: Math.min(28, displayDepth * 10) + (childCount > 0 ? 22 : 0)
        }}
      >
        <KindChip span={span} />
        <Text size="11.5px" fw={580} truncate title={span.name}>
          {span.name}
        </Text>
        {childCount > 0 && (
          <Badge size="xs" variant="light" color="gray" style={{ flex: '0 0 auto', fontSize: 9, height: 16 }}>
            {childCount} 子调用
          </Badge>
        )}
      </Group>
      <Box
        style={{
          position: 'relative',
          height: 12,
          borderRadius: 4,
          background: 'color-mix(in srgb, var(--app-border) 64%, transparent)',
          overflow: 'hidden'
        }}
      >
        <Box
          style={{
            position: 'absolute',
            left: `${left}%`,
            width: `${width}%`,
            top: 2,
            bottom: 2,
            borderRadius: 4,
            background: color
          }}
        />
      </Box>
      <Stack gap={0} align="flex-end" style={{ minWidth: 0 }}>
        <Text size="10.5px" c="dimmed">
          {formatDuration(span.durMs)}
        </Text>
        <Text size="9.5px" c="dimmed">
          {formatTokenParts(tokens)}
        </Text>
      </Stack>
      </button>
    </Box>
  )
}

function TraceScopeBar({
  currentSpan,
  breadcrumb,
  mode,
  scopeCount,
  onReset,
  onNavigate,
  onBack
}: {
  currentSpan?: AgentTraceSpan | null
  breadcrumb: AgentTraceSpan[]
  mode: 'list' | 'detail'
  scopeCount: number
  onReset: () => void
  onNavigate: (span: AgentTraceSpan) => void
  onBack: () => void
}) {
  const visiblePath = breadcrumb.filter((span) => Number(span.depth || 0) > 0)
  const crumbButton = (label: string, active: boolean, onClick: () => void, title?: string) => (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      style={{
        minWidth: 0,
        maxWidth: active ? 220 : 156,
        border: active ? '1px solid color-mix(in srgb, var(--dsh-accent) 32%, var(--app-border))' : '1px solid transparent',
        borderRadius: 6,
        background: active ? 'color-mix(in srgb, var(--dsh-accent) 10%, var(--dsh-surface))' : 'transparent',
        color: active ? 'var(--dsh-text)' : 'var(--dsh-text-soft)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 11,
        fontWeight: active ? 740 : 620,
        lineHeight: '18px',
        padding: '1px 6px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </button>
  )

  return (
    <Group
      justify="space-between"
      gap={8}
      wrap="nowrap"
      px="sm"
      py={6}
      style={{
        minWidth: 0,
        borderBottom: '1px solid var(--app-border)',
        background: 'color-mix(in srgb, var(--dsh-bg) 32%, transparent)'
      }}
    >
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
        {crumbButton('全部 Trace', !currentSpan, onReset)}
        {visiblePath.map((span, index) => {
          const current = currentSpan && spanKey(span) === spanKey(currentSpan)
          return (
            <Group key={spanRenderKey(span, index)} gap={4} wrap="nowrap" style={{ minWidth: 0, flex: current ? '1 1 auto' : '0 1 auto' }}>
              <IconChevronRight size={12} color="var(--mantine-color-dimmed)" style={{ flex: '0 0 auto' }} />
              {crumbButton(span.name, Boolean(current), () => onNavigate(span), span.name)}
            </Group>
          )
        })}
      </Group>
      <Group gap={6} wrap="nowrap" style={{ flex: '0 0 auto' }}>
        <Text size="10.5px" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {mode === 'detail' ? '详情' : `${scopeCount} 子调用`}
        </Text>
        {currentSpan && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size={24}
            aria-label="返回上一级 Trace"
            onClick={onBack}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
        )}
      </Group>
    </Group>
  )
}

function Waterfall({
  run,
  selectedSpanId,
  onSelectSpan
}: {
  run: AgentTraceRun
  selectedSpanId?: string
  onSelectSpan: (span: AgentTraceSpan | null) => void
}) {
  const trace = run.trace
  const spans = trace?.spans || []
  const selectedSpan = selectedSpanId
    ? spans.find((span) => spanKey(span) === selectedSpanId) || null
    : null
  const traceRoot = useMemo(() => rootSpan(run), [run])
  const visibleSpans = useMemo(
    () => {
      const rootChildren = traceRoot ? childSpansOf(run, traceRoot) : []
      return rootChildren.length ? rootChildren : spans
    },
    [run, traceRoot, spans]
  )
  const breadcrumb = useMemo(
    () => (selectedSpan ? spanPath(run, selectedSpan) : []),
    [run, selectedSpan]
  )
  const scopeStart = Number(traceRoot?.startMs || 0)
  const depthOffset = traceRoot ? Number(traceRoot.depth || 0) + 1 : 0
  const maxEnd = useMemo(
    () => Math.max(
      1,
      Number(traceRoot?.durMs || trace?.durMs || 0),
      ...visibleSpans.map((span) => Math.max(0, Number(span.startMs || 0) - scopeStart) + Number(span.durMs || 0))
    ),
    [traceRoot?.durMs, trace?.durMs, visibleSpans, scopeStart]
  )
  const tokenParts = useMemo(
    () => scopeTokenParts(run, visibleSpans),
    [run, visibleSpans]
  )
  const toolCount = spanKindCount(visibleSpans, 'tool')
  const llmCount = spanKindCount(visibleSpans, 'llm')
  const errorCount = visibleSpans.filter((span) => isError(span.status)).length
  const scopeName = '本轮'
  const showDetail = (span: AgentTraceSpan) => {
    onSelectSpan(span)
  }
  const navigateToSpan = (span: AgentTraceSpan) => {
    showDetail(span)
  }
  const resetDrill = () => {
    onSelectSpan(null)
  }
  const drillUp = () => {
    if (!selectedSpan) return
    const parent = parentSpanOf(run, selectedSpan)
    if (!parent || Number(parent.depth || 0) <= 0) {
      onSelectSpan(null)
      return
    }
    onSelectSpan(parent)
  }

  if (!trace) {
    return <EmptyState icon={<IconClock size={18} />} title="这一轮暂无 Trace" />
  }
  if (!spans.length) {
    return <EmptyState icon={<IconChartBar size={18} />} title="这一轮还没有 span" />
  }

  return (
    <Box
      style={{
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden'
      }}
    >
      <TraceScopeBar
        currentSpan={selectedSpan}
        breadcrumb={breadcrumb}
        mode={selectedSpan ? 'detail' : 'list'}
        scopeCount={visibleSpans.length}
        onReset={resetDrill}
        onNavigate={navigateToSpan}
        onBack={drillUp}
      />
      {selectedSpan ? (
        <Box style={{ minWidth: 0 }}>
          <SpanDetail
            run={run}
            span={selectedSpan}
            onSelectSpan={showDetail}
            onDrillSpan={showDetail}
            showChildList
          />
        </Box>
      ) : (
        <>
          <Box px="sm" py={8} style={{ borderBottom: '1px solid var(--app-border)', minWidth: 0 }}>
            <Group justify="space-between" gap={8} wrap="nowrap" mb={6} style={{ minWidth: 0 }}>
              <Text size="11px" fw={720} truncate title={scopeName}>
                {scopeName}
              </Text>
              {errorCount > 0 && (
                <Badge size="xs" variant="light" color="red">
                  {errorCount} 错误
                </Badge>
              )}
            </Group>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(62px, 1fr))',
                gap: 7,
                minWidth: 0
              }}
            >
              <Metric label="耗时" value={formatDuration(trace.durMs)} />
              {tokenMetricItems(tokenParts).map((item) => (
                <Metric key={item.label} label={item.label} value={item.value} />
              ))}
              <Metric label="Span" value={String(visibleSpans.length)} />
              <Metric label="Tool" value={String(toolCount)} />
              <Metric label="LLM" value={String(llmCount)} />
            </Box>
          </Box>
          <Box
            px="sm"
            py={5}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(104px, 34%) minmax(86px, 1fr) minmax(44px, auto)',
              gap: 8,
              borderBottom: '1px solid var(--app-border)',
              color: 'var(--mantine-color-dimmed)',
              minWidth: 0
            }}
          >
            <Text size="10.5px">Span</Text>
            <Group justify="space-between" gap={4}>
              {Array.from({ length: 4 }, (_, i) => (
                <Text key={i} size="10px">
                  {formatDuration((maxEnd / 3) * i)}
                </Text>
              ))}
            </Group>
            <Text size="10.5px" ta="right">
              指标
            </Text>
          </Box>
          <Stack gap={4} p={6}>
            {visibleSpans.length === 0 ? (
              <EmptyState icon={<IconChartBar size={18} />} title="这一轮还没有子调用" />
            ) : visibleSpans.map((span, index) => {
              const childCount = childSpansOf(run, span).length
              return (
                <WaterfallRow
                  key={spanRenderKey(span, index)}
                  run={run}
                  span={span}
                  maxEnd={maxEnd}
                  scopeStart={scopeStart}
                  depthOffset={depthOffset}
                  childCount={childCount}
                  active={false}
                  onSelect={() => navigateToSpan(span)}
                  onDrill={() => showDetail(span)}
                />
              )
            })}
          </Stack>
        </>
      )}
    </Box>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="10.5px" c="dimmed">
        {label}
      </Text>
      <Text size="12.5px" fw={720} truncate>
        {value}
      </Text>
    </Box>
  )
}

function DetailBlock({ label, value, empty }: { label: string; value?: unknown; empty: string }) {
  const [expanded, setExpanded] = useState(false)
  const { text, format } = formatDetailValue(value)
  const longText = text.length > 900 || text.split('\n').length > 14
  return (
    <Stack gap={5} style={{ minWidth: 0 }}>
      <Group justify="space-between" gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="10.5px" fw={680} c="dimmed">
            {label}
          </Text>
          {format && (
            <Badge size="xs" variant="light" color="gray" style={{ fontSize: 9, height: 16 }}>
              {format}
            </Badge>
          )}
        </Group>
        {text && (longText || expanded) && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size={22}
            aria-label={expanded ? `收起${label}` : `展开${label}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <IconMinimize size={13} /> : <IconMaximize size={13} />}
          </ActionIcon>
        )}
      </Group>
      {text ? (
        <Box
          component="pre"
          style={{
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: '100%',
            maxHeight: expanded ? 'min(68vh, 760px)' : 220,
            margin: 0,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderRadius: 7,
            background: 'var(--dsh-bg)',
            border: '1px solid color-mix(in srgb, var(--app-border) 72%, transparent)',
            color: 'var(--dsh-text-soft)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            padding: '8px 9px'
          }}
        >
          {text}
        </Box>
      ) : (
        <Text size="11.5px" c="dimmed" py={4}>
          {empty}
        </Text>
      )}
    </Stack>
  )
}

function ChildSpanList({
  run,
  parent,
  spans,
  onSelectSpan,
  onDrillSpan
}: {
  run: AgentTraceRun
  parent: AgentTraceSpan
  spans: AgentTraceSpan[]
  onSelectSpan?: (span: AgentTraceSpan) => void
  onDrillSpan?: (span: AgentTraceSpan) => void
}) {
  if (!spans.length) return null
  const scopeStart = Number(parent.startMs || 0)
  const depthOffset = Number(parent.depth || 0) + 1
  const maxEnd = Math.max(
    1,
    Number(parent.durMs || 0),
    ...spans.map((span) => Math.max(0, Number(span.startMs || 0) - scopeStart) + Number(span.durMs || 0))
  )
  return (
    <Stack gap={6} style={{ minWidth: 0 }}>
      <Text size="10.5px" fw={680} c="dimmed">
        子调用
      </Text>
      <Box
        px={2}
        py={4}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(104px, 34%) minmax(86px, 1fr) minmax(44px, auto)',
          gap: 8,
          color: 'var(--mantine-color-dimmed)',
          minWidth: 0
        }}
      >
        <Text size="10.5px">Span</Text>
        <Group justify="space-between" gap={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Text key={i} size="10px">
              {formatDuration((maxEnd / 3) * i)}
            </Text>
          ))}
        </Group>
        <Text size="10.5px" ta="right">
          指标
        </Text>
      </Box>
      <Stack gap={4} style={{ minWidth: 0 }}>
        {spans.map((span, index) => {
          const childCount = childSpansOf(run, span).length
          return (
            <WaterfallRow
              key={spanRenderKey(span, index)}
              run={run}
              span={span}
              maxEnd={maxEnd}
              scopeStart={scopeStart}
              depthOffset={depthOffset}
              childCount={childCount}
              active={false}
              onSelect={() => onSelectSpan?.(span)}
              onDrill={() => onDrillSpan?.(span)}
            />
          )
        })}
      </Stack>
    </Stack>
  )
}

function SpanDetail({
  run,
  span,
  onSelectSpan,
  onDrillSpan,
  showChildList = false
}: {
  run: AgentTraceRun
  span?: AgentTraceSpan | null
  onSelectSpan?: (span: AgentTraceSpan) => void
  onDrillSpan?: (span: AgentTraceSpan) => void
  showChildList?: boolean
}) {
  const trace = run.trace
  if (!trace) return <EmptyState icon={<IconClock size={18} />} title="这一轮暂无 Trace" />
  if (!span) return <EmptyState icon={<IconChartBar size={18} />} title="选择一个 span 查看详情" />

  const childSpans = childSpansOf(run, span)
  const metrics = spanMetricItems(run, span)
  return (
    <Stack gap={10} p={10} style={{ minWidth: 0 }}>
      <Group justify="space-between" gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <KindChip span={span} />
          <Text size="12px" fw={700} truncate title={span.name}>
            {span.name}
          </Text>
        </Group>
        <Badge size="xs" variant="light" color={statusColor(span.status)}>
          {statusLabel(span.status)}
        </Badge>
      </Group>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))',
          gap: 8,
          minWidth: 0
        }}
      >
        {metrics.map((item) => (
          <Metric key={item.label} label={item.label} value={item.value} />
        ))}
      </Box>
      <DetailBlock label="输入" value={span.input} empty="没有输入快照" />
      <DetailBlock label="输出" value={span.output} empty="没有输出快照" />
      {showChildList && (
        <ChildSpanList
          run={run}
          parent={span}
          spans={childSpans}
          onSelectSpan={onSelectSpan}
          onDrillSpan={onDrillSpan}
        />
      )}
      <DetailBlock label="日志" value={span.logs} empty="没有日志" />
      <DetailBlock label="属性" value={span.attrs} empty="没有属性" />
    </Stack>
  )
}

function TraceRound({
  run,
  expanded,
  onToggle,
  selectedSpanId,
  onSelectSpan
}: {
  run: AgentTraceRun
  expanded: boolean
  onToggle: () => void
  selectedSpanId?: string
  onSelectSpan: (span: AgentTraceSpan | null) => void
}) {
  return (
    <Box
      style={{
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        border: '1px solid var(--app-border)',
        borderRadius: 8,
        background: 'var(--dsh-surface)',
        overflow: 'hidden'
      }}
    >
      <RoundHeader run={run} expanded={expanded} onToggle={onToggle} />
      <Box
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 150ms ease',
          minWidth: 0
        }}
      >
        <Box style={{ overflow: 'hidden', minWidth: 0 }}>
          <Box
            style={{
              boxSizing: 'border-box',
              minWidth: 0,
              width: '100%',
              borderTop: '1px solid var(--app-border)',
              background: 'color-mix(in srgb, var(--dsh-bg) 38%, transparent)'
            }}
          >
            <Waterfall run={run} selectedSpanId={selectedSpanId} onSelectSpan={onSelectSpan} />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default function Workstation(props: WorkstationProps) {
  const { projectId, sessionId, running = false, onRefresh, onCollapse, hideHeader = false, reviewTarget } = props
  const runNodesRef = useRef<Record<string, HTMLDivElement | null>>({})
  const [traceData, setTraceData] = useState<AgentSessionTraceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedRunIds, setExpandedRunIds] = useState<string[]>([])
  const [activeRunId, setActiveRunId] = useState('')
  const [selectedSpanIds, setSelectedSpanIds] = useState<Record<string, string>>({})
  const [activeView, setActiveView] = useState<'runs' | 'trace'>('runs')

  useEffect(() => {
    const onOpenReview = (payload?: { view?: 'runs' | 'trace'; runId?: string | null }) => {
      const view = payload?.view === 'trace' ? 'trace' : 'runs'
      setActiveView(view)
      const runId = String(payload?.runId || '').trim()
      if (view === 'trace' && runId) {
        setActiveRunId(runId)
        setExpandedRunIds((current) => current.includes(runId) ? current : [...current, runId])
      }
    }
    eventBus.on(EVENT_TYPES.OPEN_AGENT_REVIEW, onOpenReview)
    return () => eventBus.off(EVENT_TYPES.OPEN_AGENT_REVIEW, onOpenReview)
  }, [])

  useEffect(() => {
    if (!reviewTarget) return
    setActiveView(reviewTarget.view === 'trace' ? 'trace' : 'runs')
    const runId = String(reviewTarget.runId || '').trim()
    if (reviewTarget.view === 'trace' && runId) {
      setActiveRunId(runId)
      setExpandedRunIds((current) => current.includes(runId) ? current : [...current, runId])
    }
  }, [reviewTarget])

  const loadTrace = useCallback(async () => {
    if (!projectId || !sessionId) {
      setTraceData(null)
      setExpandedRunIds([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const res: any = await getAgentSessionTraces(projectId, sessionId)
      const next: AgentSessionTraceResponse = res?.data || res || { enabled: false, items: [] }
      setTraceData(next)
    } catch (err: any) {
      setError(err?.message || 'Trace 加载失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, sessionId])

  useEffect(() => {
    loadTrace()
  }, [loadTrace])

  useEffect(() => {
    if (!running || !projectId || !sessionId) return undefined
    const id = window.setInterval(() => loadTrace(), 4000)
    return () => window.clearInterval(id)
  }, [loadTrace, projectId, running, sessionId])

  const runs = useMemo(
    () => (traceData?.items || []).map((run, index) => ({ run, index }))
      .sort(compareRuns)
      .map((item) => item.run),
    [traceData?.items]
  )
  const traceMarkers = useMemo<TurnLocatorMarker[]>(
    () => runs.map((run) => {
      const questionNo = Number(run.question?.questionNo || 0)
      return {
        id: run.runId,
        title: questionNo ? `第 ${questionNo} 问` : '用户问题',
        excerpt: userQuestionText(run),
        meta: '定位到 Trace'
      }
    }),
    [runs]
  )
  const runIdsKey = runs.map((run) => run.runId).join('|')
  const hasTraceDetail = runs.some((run) => Boolean(selectedSpanIds[run.runId]))

  useEffect(() => {
    setExpandedRunIds((prev) => {
      const currentIds = new Set(runs.map((run) => run.runId))
      const kept = prev.filter((id) => currentIds.has(id))
      if (kept.length) return kept
      const latest = [...runs].reverse().find((run) => run.trace)?.runId || runs[runs.length - 1]?.runId
      return latest ? [latest] : []
    })
    setActiveRunId((prev) => {
      const currentIds = new Set(runs.map((run) => run.runId))
      if (prev && currentIds.has(prev)) return prev
      return [...runs].reverse().find((run) => run.trace)?.runId || runs[runs.length - 1]?.runId || ''
    })
    setSelectedSpanIds((prev) => {
      const next: Record<string, string> = {}
      for (const run of runs) {
        const spans = run.trace?.spans || []
        if (!spans.length) continue
        const hasCurrent = Object.prototype.hasOwnProperty.call(prev, run.runId)
        const current = prev[run.runId]
        if (hasCurrent && !current) {
          next[run.runId] = ''
          continue
        }
        const currentStillExists = current && spans.some((span) => spanKey(span) === current)
        next[run.runId] = currentStillExists ? current : ''
      }
      return next
    })
  }, [runIdsKey, runs])

  const toggleRun = (runId: string) => {
    setActiveRunId(runId)
    setExpandedRunIds((prev) => (prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId]))
  }

  const setRunNode = useCallback(
    (runId: string) => (node: HTMLDivElement | null) => {
      runNodesRef.current[runId] = node
    },
    []
  )

  const selectRun = useCallback((runId: string) => {
    setActiveRunId(runId)
    setExpandedRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId]))
    window.requestAnimationFrame(() => {
      runNodesRef.current[runId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  const selectSpan = (runId: string, span: AgentTraceSpan | null) => {
    const id = spanKey(span)
    setSelectedSpanIds((prev) => ({ ...prev, [runId]: id && prev[runId] !== id ? id : '' }))
  }

  const refresh = () => {
    onRefresh?.()
    loadTrace()
  }

  return (
    <Stack h="100%" gap={0} style={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Group
        justify="space-between"
        px="md"
        h={hideHeader ? 42 : 52}
        style={{ borderBottom: '1px solid var(--app-border)', flex: '0 0 auto', minWidth: 0 }}
      >
        <Group gap={8} wrap="nowrap">
          {activeView === 'runs'
            ? <IconActivityHeartbeat size={15} stroke={1.8} color="var(--dsh-accent)" />
            : <IconChartBar size={15} stroke={1.8} color="var(--dsh-accent)" />}
          <Text fw={650} size={hideHeader ? '13px' : '14px'}>
            {activeView === 'runs' ? '运行审查' : '执行过程'}
          </Text>
          {running && (
            <Badge size="xs" variant="light" color="orange" leftSection={<IconLoader2 size={10} />}>
              运行中
            </Badge>
          )}
        </Group>
        <Group gap={2}>
          <Button
            size="compact-xs"
            variant={activeView === 'runs' ? 'light' : 'subtle'}
            color={activeView === 'runs' ? 'blue' : 'gray'}
            onClick={() => setActiveView('runs')}
            data-workstation-view="runs"
            data-active={activeView === 'runs' ? 'true' : undefined}
          >
            运行
          </Button>
          <Button
            size="compact-xs"
            variant={activeView === 'trace' ? 'light' : 'subtle'}
            color={activeView === 'trace' ? 'blue' : 'gray'}
            onClick={() => setActiveView('trace')}
            data-workstation-view="trace"
            data-active={activeView === 'trace' ? 'true' : undefined}
          >
            过程
          </Button>
          {activeView === 'trace' && (
            <ActionIcon variant="subtle" color="gray" onClick={refresh} aria-label="刷新 Trace" loading={loading}>
              <IconRefresh size={16} />
            </ActionIcon>
          )}
          {!hideHeader && (
            <ActionIcon variant="subtle" color="gray" onClick={onCollapse} aria-label="折叠">
              <IconChevronsRight size={16} />
            </ActionIcon>
          )}
        </Group>
      </Group>

      {activeView === 'runs' ? (
        <RunCenter
          projectId={projectId}
          sessionId={sessionId}
          running={running}
          requestedRunId={reviewTarget?.view === 'runs' ? reviewTarget.runId : null}
        />
      ) : !projectId || !sessionId ? (
        <EmptyState icon={<IconChartBar size={18} />} title="选择一个对话后查看 Trace" />
      ) : error ? (
        <EmptyState icon={<IconAlertTriangle size={18} />} title={error} />
      ) : traceData && traceData.enabled === false ? (
        <EmptyState
          icon={<IconDatabaseOff size={18} />}
          title="Trace DB 未启用"
          detail={traceData.dataDir ? `数据目录: ${traceData.dataDir}` : undefined}
        />
      ) : loading && !traceData ? (
        <EmptyState icon={<IconLoader2 size={18} />} title="正在加载 Trace" />
      ) : runs.length === 0 ? (
        <EmptyState icon={<IconChartBar size={18} />} title={running ? 'Trace 将在本轮结束后写入' : '当前会话还没有 Trace'} />
      ) : (
        <ScrollArea style={{ flex: 1, minHeight: 0, minWidth: 0, width: '100%', background: 'var(--dsh-bg)' }} type="hover" scrollbarSize={7}>
          <Box
            p="sm"
            style={{
              boxSizing: 'border-box',
              display: 'grid',
              gridTemplateColumns: hasTraceDetail ? 'minmax(0, 1fr)' : '44px minmax(0, 1fr)',
              columnGap: hasTraceDetail ? 0 : 4,
              minWidth: 0,
              width: '100%'
            }}
          >
            {!hasTraceDetail && (
              <TurnLocator
                markers={traceMarkers}
                activeId={activeRunId}
                ariaLabel="Trace 轮次导航"
                variant="inline"
                onSelect={selectRun}
              />
            )}
            <Stack gap={10} style={{ minWidth: 0, width: '100%' }}>
              {runs.map((run) => (
                <Box key={run.runId} ref={setRunNode(run.runId)} style={{ minWidth: 0, scrollMarginTop: 10 }}>
                  <TraceRound
                    run={run}
                    expanded={expandedRunIds.includes(run.runId)}
                    onToggle={() => toggleRun(run.runId)}
                    selectedSpanId={selectedSpanIds[run.runId]}
                    onSelectSpan={(span) => selectSpan(run.runId, span)}
                  />
                </Box>
              ))}
            </Stack>
          </Box>
        </ScrollArea>
      )}
    </Stack>
  )
}
