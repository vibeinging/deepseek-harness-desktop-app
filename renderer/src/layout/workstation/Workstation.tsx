import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActionIcon, Badge, Box, Button, Collapse, Group, ScrollArea, Stack, Text } from '@mantine/core'
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronsRight,
  IconClock,
  IconCode,
  IconDatabase,
  IconLoader2,
  IconMessage,
  IconRefresh,
  IconRobot,
  IconTerminal2,
  IconTool,
  IconUser
} from '@tabler/icons-react'
import {
  getDshSessionTrajectory,
  type DshSessionTrajectory,
  type DshTrajectoryEvent
} from '@/api/agent'

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

interface TrajectorySection {
  id: string
  title: string
  turn: number | null
  status: string
  startedAt: number
  endedAt: number
  entries: DshTrajectoryEvent[]
  rawChunkCount: number
}

interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

const HIDDEN_EVENT_TYPES = new Set(['assistant/chunk'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}

function compactText(value: unknown, limit = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value || '')
  }
}

function blockText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(blockText).filter(Boolean).join('\n')
  if (!isObject(value)) return ''
  if (typeof value.text === 'string') return value.text
  if (Array.isArray(value.content)) return blockText(value.content)
  return ''
}

function eventData(entry: DshTrajectoryEvent) {
  return asObject(entry.event.data)
}

function eventView(entry: DshTrajectoryEvent) {
  return asObject(entry.view?.view)
}

function eventUsage(entry: DshTrajectoryEvent): TokenUsage {
  if (entry.event.type !== 'assistant/message') {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  }
  const data = eventData(entry)
  const usage = asObject(data.usage || asObject(data.message).usage)
  return {
    input: Number(usage.inputTokens || 0) || 0,
    output: Number(usage.outputTokens || 0) || 0,
    cacheRead: Number(usage.cacheReadTokens || 0) || 0,
    cacheWrite: Number(usage.cacheWriteTokens || 0) || 0,
    reasoning: Number(usage.reasoningTokens || 0) || 0
  }
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    reasoning: total.reasoning + next.reasoning
  }
}

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(start: number, end: number) {
  const duration = end - start
  if (!Number.isFinite(duration) || duration <= 0) return ''
  if (duration < 1000) return `${Math.round(duration)} ms`
  return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} s`
}

function turnEndStatus(entry: DshTrajectoryEvent) {
  const reason = asObject(eventData(entry).reason)
  return String(reason.kind || 'completed')
}

function sectionStatusLabel(status: string) {
  if (['completed', 'success', 'stop'].includes(status)) return '完成'
  if (['running', 'inProgress'].includes(status)) return '运行中'
  if (['aborted', 'cancelled', 'canceled', 'interrupted'].includes(status)) return '已中断'
  if (status === 'session') return '会话'
  return status || '未知'
}

function statusColor(status: string) {
  if (['completed', 'success', 'stop'].includes(status)) return 'teal'
  if (['running', 'inProgress'].includes(status)) return 'orange'
  if (status === 'session') return 'gray'
  return 'red'
}

function buildSections(entries: DshTrajectoryEvent[]): TrajectorySection[] {
  const sections: TrajectorySection[] = []
  let current: TrajectorySection | null = null
  let sessionIndex = 0

  const flush = () => {
    if (!current || current.entries.length === 0) return
    sections.push(current)
    current = null
  }

  for (const entry of entries) {
    const event = entry.event
    const time = Number(event.time || 0)
    if (event.type === 'turn/start') {
      flush()
      const turn = Number(eventData(entry).turn || 0) || sections.filter((section) => section.turn !== null).length + 1
      current = {
        id: `turn:${turn}:${event.seq}`,
        title: `第 ${turn} 轮`,
        turn,
        status: 'running',
        startedAt: time,
        endedAt: time,
        entries: [entry],
        rawChunkCount: 0
      }
      continue
    }
    if (!current) {
      sessionIndex += 1
      current = {
        id: `session:${sessionIndex}:${event.seq}`,
        title: '会话状态',
        turn: null,
        status: 'session',
        startedAt: time,
        endedAt: time,
        entries: [],
        rawChunkCount: 0
      }
    }
    current.entries.push(entry)
    current.endedAt = time || current.endedAt
    if (event.type === 'assistant/chunk') current.rawChunkCount += 1
    if (event.type === 'turn/end') {
      current.status = turnEndStatus(entry)
      flush()
    }
  }
  flush()
  return sections
}

function eventLabel(entry: DshTrajectoryEvent) {
  const data = eventData(entry)
  const view = eventView(entry)
  switch (entry.event.type) {
    case 'turn/start': return '开始本轮'
    case 'turn/end': return `结束本轮: ${sectionStatusLabel(turnEndStatus(entry))}`
    case 'step/start': return `开始步骤 ${String(data.step || '')}`.trim()
    case 'step/end': return `结束步骤 ${String(data.step || '')}`.trim()
    case 'user/message': return compactText(blockText(data.content || asObject(data.message).content)) || '用户消息'
    case 'assistant/message': return compactText(blockText(asObject(data.message).content)) || '模型完成回复'
    case 'tool/call': return String(view.title || data.name || '调用工具')
    case 'tool/result': return String(view.title || (data.error ? '工具执行失败' : '工具返回结果'))
    case 'todo/write': return `更新计划，共 ${Array.isArray(data.todos) ? data.todos.length : 0} 项`
    case 'request/context': {
      const provider = String(data.provider || '')
      const model = String(data.model || '')
      return [provider, model].filter(Boolean).join(' / ') || '记录模型上下文'
    }
    case 'request/header': return '记录本轮请求配置'
    case 'permission/preset': return `权限: ${String(data.preset || data.value || '')}`.trim()
    case 'sandbox/mode': return `沙箱: ${String(data.mode || data.value || '')}`.trim()
    case 'approval/policy': return `审批: ${String(data.policy || data.value || '')}`.trim()
    case 'session/title': return `标题: ${String(data.title || '')}`.trim()
    default: return entry.event.type
  }
}

function eventMeta(entry: DshTrajectoryEvent) {
  const data = eventData(entry)
  const view = eventView(entry)
  if (entry.event.type === 'tool/call') {
    const card = String(view.card || 'generic')
    const name = String(data.name || 'tool')
    return `${name} / ${card}`
  }
  if (entry.event.type === 'tool/result') {
    const error = asObject(data.error)
    if (error.code || error.name) return [error.name, error.code].filter(Boolean).join(' / ')
    return String(view.card || 'result')
  }
  if (entry.event.type === 'assistant/message') {
    const usage = eventUsage(entry)
    const total = usage.input + usage.output
    return total > 0 ? `${formatNumber(total)} token` : '模型输出'
  }
  return ''
}

function eventIcon(type: string) {
  if (type === 'user/message') return <IconUser size={14} />
  if (type === 'assistant/message') return <IconRobot size={14} />
  if (type === 'tool/call' || type === 'tool/result') return <IconTool size={14} />
  if (type === 'request/context' || type === 'request/header') return <IconCode size={14} />
  if (type.includes('sandbox') || type.includes('permission') || type.includes('approval')) return <IconTerminal2 size={14} />
  return <IconMessage size={14} />
}

function projectionText(value: unknown) {
  if (value == null) return '未设置'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} 项`
  if (isObject(value)) {
    if (value.currentValue != null) return String(value.currentValue)
    if (value.model != null) return [value.provider, value.model].filter(Boolean).join(' / ')
    if (value.mode != null) return String(value.mode)
    if (value.status != null) return String(value.status)
  }
  return '已记录'
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box style={{ minWidth: 0 }}>
      <Text size="10px" c="dimmed">{label}</Text>
      <Text size="13px" fw={720} truncate>{value}</Text>
    </Box>
  )
}

function TrajectoryEventRow({ entry }: { entry: DshTrajectoryEvent }) {
  const [expanded, setExpanded] = useState(false)
  const meta = eventMeta(entry)
  return (
    <Box
      data-dsh-trajectory-event
      data-dsh-event-type={entry.event.type}
      style={{
        border: '1px solid color-mix(in srgb, var(--app-border) 78%, transparent)',
        borderRadius: 7,
        background: 'var(--dsh-surface)',
        overflow: 'hidden'
      }}
    >
      <Button
        variant="subtle"
        color="gray"
        fullWidth
        justify="space-between"
        h="auto"
        px={9}
        py={7}
        onClick={() => setExpanded((value) => !value)}
        rightSection={<IconChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 120ms ease' }} />}
        styles={{ inner: { width: '100%' }, label: { width: '100%', overflow: 'hidden' } }}
      >
        <Group justify="space-between" wrap="nowrap" gap={8} style={{ width: '100%', minWidth: 0 }}>
          <Group wrap="nowrap" gap={7} style={{ minWidth: 0, overflow: 'hidden' }}>
            <Box c="dimmed" style={{ display: 'flex', flex: '0 0 auto' }}>{eventIcon(entry.event.type)}</Box>
            <Box style={{ minWidth: 0, textAlign: 'left' }}>
              <Text size="11.5px" fw={620} truncate title={eventLabel(entry)}>{eventLabel(entry)}</Text>
              <Text size="9.5px" c="dimmed" truncate>{entry.event.type}{meta ? ` / ${meta}` : ''}</Text>
            </Box>
          </Group>
          <Text size="9.5px" c="dimmed" ff="monospace" style={{ flex: '0 0 auto' }}>#{entry.event.seq}</Text>
        </Group>
      </Button>
      <Collapse in={expanded}>
        <Box
          component="pre"
          m={0}
          p={9}
          style={{
            maxHeight: 340,
            overflow: 'auto',
            borderTop: '1px solid var(--app-border)',
            background: 'var(--dsh-bg)',
            color: 'var(--dsh-text-soft)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 10.5,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {safeJson(entry)}
        </Box>
      </Collapse>
    </Box>
  )
}

function TrajectorySectionCard({ section, initialExpanded }: { section: TrajectorySection; initialExpanded: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const visibleEntries = section.entries.filter((entry) => !HIDDEN_EVENT_TYPES.has(entry.event.type))
  const usage = section.entries.reduce((total, entry) => addUsage(total, eventUsage(entry)), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0
  })
  const toolCount = section.entries.filter((entry) => entry.event.type === 'tool/call').length

  return (
    <Box
      data-dsh-turn={section.turn == null ? 'session' : section.turn}
      style={{ border: '1px solid var(--app-border)', borderRadius: 9, background: 'var(--dsh-surface)', overflow: 'hidden' }}
    >
      <Button
        variant="subtle"
        color="gray"
        fullWidth
        h="auto"
        px={10}
        py={9}
        onClick={() => setExpanded((value) => !value)}
        rightSection={<IconChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 120ms ease' }} />}
        styles={{ inner: { width: '100%' }, label: { width: '100%' } }}
      >
        <Group justify="space-between" wrap="nowrap" gap={8} style={{ width: '100%', minWidth: 0 }}>
          <Box style={{ minWidth: 0, textAlign: 'left' }}>
            <Group gap={6} wrap="nowrap">
              <Text size="12px" fw={720}>{section.title}</Text>
              <Badge size="xs" variant="light" color={statusColor(section.status)}>{sectionStatusLabel(section.status)}</Badge>
            </Group>
            <Text size="9.5px" c="dimmed" truncate>
              {[formatTime(section.startedAt), formatDuration(section.startedAt, section.endedAt), `${visibleEntries.length} 个事件`].filter(Boolean).join(' / ')}
            </Text>
          </Box>
          <Group gap={5} wrap="nowrap" style={{ flex: '0 0 auto' }}>
            {toolCount > 0 && <Badge size="xs" variant="outline" color="gray">{toolCount} 工具</Badge>}
            {usage.input + usage.output > 0 && <Badge size="xs" variant="outline" color="gray">{formatNumber(usage.input + usage.output)} token</Badge>}
          </Group>
        </Group>
      </Button>
      <Collapse in={expanded}>
        <Stack gap={6} p={7} style={{ borderTop: '1px solid var(--app-border)', background: 'color-mix(in srgb, var(--dsh-bg) 54%, transparent)' }}>
          {visibleEntries.map((entry) => <TrajectoryEventRow key={`${entry.event.seq}:${entry.event.type}`} entry={entry} />)}
          {section.rawChunkCount > 0 && (
            <Text size="10px" c="dimmed" ta="center" py={3}>已收起 {section.rawChunkCount} 个原始流分片，最终模型消息仍保留在轨迹中</Text>
          )}
        </Stack>
      </Collapse>
    </Box>
  )
}

function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <Stack flex={1} align="center" justify="center" gap={7} p="lg" c="dimmed">
      {icon}
      <Text size="12px" ta="center">{title}</Text>
      {detail && <Text size="10px" ta="center">{detail}</Text>}
    </Stack>
  )
}

export default function Workstation(props: WorkstationProps) {
  const { projectId, sessionId, running = false, onRefresh, onCollapse, hideHeader = false, reviewTarget } = props
  const [trajectory, setTrajectory] = useState<DshSessionTrajectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!projectId || !sessionId) {
      setTrajectory(null)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    try {
      const response: any = await getDshSessionTrajectory(projectId, sessionId)
      setTrajectory(response?.data || null)
    } catch (cause: any) {
      setError(cause?.msg || cause?.message || 'DSH 轨迹加载失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, sessionId])

  useEffect(() => { void load() }, [load, reviewTarget?.nonce])

  useEffect(() => {
    if (!running || !projectId || !sessionId) return undefined
    const timer = window.setInterval(() => void load(), 2500)
    return () => window.clearInterval(timer)
  }, [load, projectId, running, sessionId])

  const sections = useMemo(() => buildSections(trajectory?.events || []), [trajectory?.events])
  const usage = useMemo(() => (trajectory?.events || []).reduce((total, entry) => addUsage(total, eventUsage(entry)), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0
  }), [trajectory?.events])
  const turnCount = sections.filter((section) => section.turn !== null).length
  const toolCount = (trajectory?.events || []).filter((entry) => entry.event.type === 'tool/call').length
  const errorCount = (trajectory?.events || []).filter((entry) => (
    entry.event.type === 'tool/result' && Boolean(eventData(entry).error)
  ) || (
    entry.event.type === 'turn/end' && !['completed', 'success', 'stop'].includes(turnEndStatus(entry))
  )).length
  const projectionEntries = Object.entries(trajectory?.projections?.values || {}).slice(0, 8)

  const refresh = () => {
    onRefresh?.()
    void load()
  }

  return (
    <Stack
      h="100%"
      gap={0}
      data-dsh-trajectory
      data-dsh-trajectory-source={trajectory?.source || 'session.history'}
      style={{ minHeight: 0, minWidth: 0, width: '100%' }}
    >
      <Group
        justify="space-between"
        px="md"
        h={hideHeader ? 42 : 52}
        style={{ borderBottom: '1px solid var(--app-border)', flex: '0 0 auto', minWidth: 0 }}
      >
        <Group gap={7} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconDatabase size={15} stroke={1.8} color="var(--dsh-accent)" />
          <Text fw={680} size={hideHeader ? '13px' : '14px'} truncate>DSH 轨迹</Text>
          <Badge size="xs" variant="light" color="gray">session.history</Badge>
          {running && <Badge size="xs" variant="light" color="orange" leftSection={<IconLoader2 size={10} />}>实时</Badge>}
        </Group>
        <Group gap={2} wrap="nowrap">
          <ActionIcon variant="subtle" color="gray" onClick={refresh} aria-label="刷新 DSH 轨迹" loading={loading}>
            <IconRefresh size={16} />
          </ActionIcon>
          {!hideHeader && (
            <ActionIcon variant="subtle" color="gray" onClick={onCollapse} aria-label="折叠">
              <IconChevronsRight size={16} />
            </ActionIcon>
          )}
        </Group>
      </Group>

      {!projectId || !sessionId ? (
        <EmptyState icon={<IconMessage size={20} />} title="选择一个对话后查看 DSH 轨迹" />
      ) : error ? (
        <EmptyState icon={<IconAlertTriangle size={20} />} title={error} detail="轨迹直接读取 DSH session.history" />
      ) : loading && !trajectory ? (
        <EmptyState icon={<IconLoader2 size={20} />} title="正在读取 DSH 轨迹" />
      ) : !trajectory || trajectory.events.length === 0 ? (
        <EmptyState icon={<IconClock size={20} />} title={running ? 'DSH 正在记录本轮轨迹' : '这个会话还没有 DSH 轨迹'} />
      ) : (
        <ScrollArea style={{ flex: 1, minHeight: 0, background: 'var(--dsh-bg)' }} type="hover" scrollbarSize={7}>
          <Stack gap={9} p="sm">
            <Box
              p={10}
              style={{ border: '1px solid var(--app-border)', borderRadius: 9, background: 'var(--dsh-surface)' }}
            >
              <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(58px, 1fr))', gap: 8 }}>
                <Metric label="轮次" value={String(turnCount)} />
                <Metric label="事件" value={String(trajectory.events.length)} />
                <Metric label="工具" value={String(toolCount)} />
                <Metric label="输入" value={formatNumber(usage.input)} />
                <Metric label="输出" value={formatNumber(usage.output)} />
                <Metric label="缓存" value={formatNumber(usage.cacheRead + usage.cacheWrite)} />
                <Metric label="推理" value={formatNumber(usage.reasoning)} />
                <Metric label="错误" value={String(errorCount)} />
              </Box>
              {projectionEntries.length > 0 && (
                <Group gap={5} mt={9} data-dsh-trajectory-projections>
                  {projectionEntries.map(([key, value]) => (
                    <Badge key={key} size="xs" variant="outline" color="gray" title={safeJson(value)}>
                      {key}: {projectionText(value)}
                    </Badge>
                  ))}
                </Group>
              )}
            </Box>

            {sections.map((section, index) => (
              <TrajectorySectionCard
                key={section.id}
                section={section}
                initialExpanded={index === sections.length - 1}
              />
            ))}
          </Stack>
        </ScrollArea>
      )}
    </Stack>
  )
}
