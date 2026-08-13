import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActionIcon, Badge, Box, Button, Group, Loader, ScrollArea, Stack, Text, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconAlertTriangle,
  IconClock,
  IconFile,
  IconGitBranch,
  IconRefresh,
  IconTool
} from '@tabler/icons-react'
import {
  getAgentRun,
  getAgentSubagentThread,
  listAgentRuns,
  type AgentRunDetail,
  type AgentNativeSubagent,
  type AgentRunSummary
} from '@/api/agent'
import { revealInFinder } from './folders'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import {
  ACTIVE_RUN_STATUSES,
  compactRunValue,
  latestRunFailure,
  runArtifactName,
  runStatusColor,
  runStatusLabel,
  waitingRunMessage
} from './runCenterModel'

interface RunCenterProps {
  projectId?: string
  sessionId?: string | null
  running?: boolean
  requestedRunId?: string | null
}

const cardStyle = {
  border: '1px solid var(--app-border)',
  borderRadius: 8,
  background: 'var(--dsh-surface)'
} as const

function timeLabel(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function SectionTitle({ children, count }: { children: string; count?: number }) {
  return (
    <Group justify="space-between" gap={8} mb={6}>
      <Text size="xs" fw={700} c="var(--dsh-text-soft)">{children}</Text>
      {typeof count === 'number' && <Text size="10px" c="dimmed">{count}</Text>}
    </Group>
  )
}

function subagentMessages(thread: any): string[] {
  return (Array.isArray(thread?.turns) ? thread.turns : [])
    .flatMap((turn: any) => Array.isArray(turn?.items) ? turn.items : [])
    .filter((item: any) => item?.type === 'agentMessage' && String(item.text || '').trim())
    .map((item: any) => String(item.text).trim())
}

export default function RunCenter({ projectId, sessionId, running = false, requestedRunId }: RunCenterProps) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [detail, setDetail] = useState<AgentRunDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [subagentAction, setSubagentAction] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const onOpenReview = (payload?: { view?: 'runs' | 'trace'; runId?: string | null }) => {
      if (payload?.view === 'trace') return
      const runId = String(payload?.runId || '').trim()
      if (runId) setSelectedRunId(runId)
    }
    eventBus.on(EVENT_TYPES.OPEN_AGENT_REVIEW, onOpenReview)
    return () => eventBus.off(EVENT_TYPES.OPEN_AGENT_REVIEW, onOpenReview)
  }, [])

  useEffect(() => {
    const runId = String(requestedRunId || '').trim()
    if (runId) setSelectedRunId(runId)
  }, [requestedRunId])

  const loadRuns = useCallback(async () => {
    if (!projectId || !sessionId) {
      setRuns([])
      setSelectedRunId('')
      setDetail(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response: any = await listAgentRuns(projectId, sessionId)
      const items: AgentRunSummary[] = response?.data?.items || []
      setRuns(items)
      setSelectedRunId((current) => items.some((run) => run.id === current) ? current : items[0]?.id || '')
    } catch (err: any) {
      setError(err?.message || '运行记录加载失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, sessionId])

  const loadDetail = useCallback(async (runId = selectedRunId) => {
    if (!runId) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    try {
      const response: any = await getAgentRun(runId)
      setDetail(response?.data || null)
    } catch (err: any) {
      setError(err?.message || '运行详情加载失败')
    } finally {
      setDetailLoading(false)
    }
  }, [selectedRunId])

  useEffect(() => { void loadRuns() }, [loadRuns])
  useEffect(() => { void loadDetail() }, [loadDetail])

  const hasActiveRun = running || runs.some((run) => ACTIVE_RUN_STATUSES.has(String(run.status || '')))
  useEffect(() => {
    if (!hasActiveRun || !projectId || !sessionId) return undefined
    const timer = window.setInterval(() => { void loadRuns(); void loadDetail() }, 3000)
    return () => window.clearInterval(timer)
  }, [hasActiveRun, loadDetail, loadRuns, projectId, sessionId])

  const selectedRun = useMemo(
    () => detail?.run || runs.find((run) => run.id === selectedRunId) || null,
    [detail?.run, runs, selectedRunId]
  )
  const failure = latestRunFailure(detail?.events || [])
  const waitingMessage = waitingRunMessage(selectedRun)

  const refresh = async () => {
    await loadRuns()
    await loadDetail()
  }

  const inspectSubagent = async (subagent: AgentNativeSubagent) => {
    if (!selectedRun) return
    setSubagentAction(`read:${subagent.thread_id}`)
    try {
      const response: any = await getAgentSubagentThread(selectedRun.id, subagent.thread_id)
      const thread = response?.data?.thread
      const messages = subagentMessages(thread)
      modals.open({
        title: subagent.title || '协作子任务',
        size: 'lg',
        children: (
          <Stack gap="sm" data-native-subagent-detail>
            <Group gap={6}>
              <Badge size="sm" variant="light" color={runStatusColor(subagent.status)}>{runStatusLabel(subagent.status)}</Badge>
              {subagent.model && <Badge size="sm" variant="light" color="gray">{subagent.model}</Badge>}
            </Group>
            {subagent.prompt && <Text size="sm">{subagent.prompt}</Text>}
            <Text size="10px" c="dimmed" style={{ wordBreak: 'break-all' }}>thread · {subagent.thread_id}</Text>
            {messages.length ? messages.slice(-6).map((message, index) => (
              <Box key={index} p="sm" style={cardStyle}>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{message}</Text>
              </Box>
            )) : <Text size="sm" c="dimmed">这个子任务还没有返回文字结果。</Text>}
          </Stack>
        )
      })
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.message || '协作子任务详情加载失败' })
    } finally {
      setSubagentAction('')
    }
  }

  if (!projectId || !sessionId) {
    return <Stack h="100%" align="center" justify="center" gap={8}><IconClock size={20} /><Text size="sm" c="dimmed">选择一个对话后查看运行</Text></Stack>
  }

  return (
    <Stack h="100%" gap={0} data-run-center>
      <Group justify="space-between" px="sm" py={8} style={{ borderBottom: '1px solid var(--app-border)' }}>
        <Group gap={7}>
          <Text size="xs" fw={700}>运行记录</Text>
          {runs.length > 0 && <Badge size="xs" variant="light" color="gray">{runs.length}</Badge>}
        </Group>
        <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => void refresh()} loading={loading} aria-label="刷新运行记录">
          <IconRefresh size={15} />
        </ActionIcon>
      </Group>

      {error ? (
        <Stack align="center" justify="center" h="100%" gap={8} px="md">
          <IconAlertTriangle size={20} color="var(--mantine-color-red-6)" />
          <Text size="sm" ta="center" c="red">{error}</Text>
          <Button size="xs" variant="light" onClick={() => void refresh()}>重试</Button>
        </Stack>
      ) : loading && !runs.length ? (
        <Stack align="center" justify="center" h="100%"><Loader size="sm" /></Stack>
      ) : !runs.length ? (
        <Stack align="center" justify="center" h="100%" gap={8} px="md">
          <IconClock size={20} color="var(--dsh-faint)" />
          <Text size="sm" c="dimmed">当前会话还没有运行记录</Text>
        </Stack>
      ) : (
        <ScrollArea style={{ flex: 1, minHeight: 0, background: 'var(--dsh-bg)' }} type="hover" scrollbarSize={7}>
          <Stack p="sm" gap="sm">
            {runs.length > 1 && (
              <ScrollArea type="never" offsetScrollbars={false}>
                <Group gap={6} wrap="nowrap" pb={2}>
                  {runs.map((run, index) => (
                    <Button
                      key={run.id}
                      size="compact-xs"
                      variant={run.id === selectedRunId ? 'light' : 'subtle'}
                      color={runStatusColor(run.status)}
                      onClick={() => setSelectedRunId(run.id)}
                      style={{ flex: 'none' }}
                    >
                      {index === 0 ? '最近' : `#${runs.length - index}`} · {runStatusLabel(run.status)}
                    </Button>
                  ))}
                </Group>
              </ScrollArea>
            )}

            {selectedRun && (
              <Box p="sm" style={cardStyle} data-run-id={selectedRun.id} data-run-status={selectedRun.status}>
                <Group justify="space-between" align="flex-start" gap={8}>
                  <Box style={{ minWidth: 0 }}>
                    <Text size="sm" fw={700}>{selectedRun.skill_name || selectedRun.mode || 'Agent 运行'}</Text>
                    <Text size="10px" c="dimmed" mt={2}>{timeLabel(selectedRun.created_at)}</Text>
                  </Box>
                  <Badge size="sm" variant="light" color={runStatusColor(selectedRun.status)}>{runStatusLabel(selectedRun.status)}</Badge>
                </Group>
                <Text size="10px" c="dimmed" mt={8} style={{ wordBreak: 'break-all' }}>run_id · {selectedRun.id}</Text>
                {waitingMessage && (
                  <Box mt="sm" px="sm" py={8} style={{ borderRadius: 7, background: 'color-mix(in srgb, var(--mantine-color-yellow-1) 70%, transparent)' }}>
                    <Text size="xs">{waitingMessage}</Text>
                  </Box>
                )}
              </Box>
            )}

            {detailLoading && !detail ? <Loader size="xs" mx="auto" /> : detail && (
              <>
                {failure && (
                  <Box p="sm" style={{ ...cardStyle, borderColor: 'color-mix(in srgb, var(--mantine-color-red-6) 45%, var(--app-border))' }}>
                    <SectionTitle>失败原因</SectionTitle>
                    <Text size="xs" c="red" fw={600}>{failure.error_code || failure.event_type}</Text>
                    <Text size="xs" mt={4}>{failure.error_message || failure.output_summary || '运行被中断，请查看事件记录。'}</Text>
                  </Box>
                )}

                {(detail.subagents || []).length > 0 && (
                  <Box p="sm" style={cardStyle} data-native-subagents>
                    <SectionTitle count={detail.subagents?.length || 0}>协作子任务</SectionTitle>
                    <Stack gap={6}>
                      {(detail.subagents || []).map((subagent) => (
                        <Box key={subagent.thread_id} px={8} py={7} style={{ borderRadius: 7, background: 'var(--dsh-bg)' }} data-subagent-thread-id={subagent.thread_id} data-subagent-status={subagent.status}>
                          <Group justify="space-between" gap={8} wrap="nowrap">
                            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                              <IconGitBranch size={13} />
                              <Text size="xs" fw={650} truncate>{subagent.title || '协作子任务'}</Text>
                            </Group>
                            <Badge size="xs" variant="dot" color={runStatusColor(subagent.status)}>{runStatusLabel(subagent.status)}</Badge>
                          </Group>
                          {subagent.prompt && <Text size="10px" c="dimmed" mt={4} lineClamp={2}>{subagent.prompt}</Text>}
                          {subagent.message && <Text size="10px" mt={4} lineClamp={2}>{subagent.message}</Text>}
                          <Group gap={6} mt={6}>
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="gray"
                              loading={subagentAction === `read:${subagent.thread_id}`}
                              onClick={() => void inspectSubagent(subagent)}
                            >
                              查看
                            </Button>
                            <Text size="10px" c="dimmed">thread · {subagent.thread_id.slice(0, 8)}</Text>
                          </Group>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                )}

                <Box p="sm" style={cardStyle}>
                  <SectionTitle count={detail.tools.length}>工具调用</SectionTitle>
                  {detail.tools.length ? (
                    <Stack gap={6}>
                      {[...detail.tools].reverse().slice(0, 12).map((tool) => (
                        <Box key={tool.id} px={8} py={7} style={{ borderRadius: 7, background: 'var(--dsh-bg)' }}>
                          <Group justify="space-between" gap={8} wrap="nowrap">
                            <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                              <IconTool size={13} />
                              <Text size="xs" fw={650} truncate>{tool.tool_name}</Text>
                            </Group>
                            <Badge size="xs" variant="dot" color={runStatusColor(tool.status)}>{runStatusLabel(tool.status)}</Badge>
                          </Group>
                          {compactRunValue(tool.input) && <Text size="10px" c="dimmed" mt={4} lineClamp={2}>{compactRunValue(tool.input)}</Text>}
                          {Number(tool.attempt_count || 0) > 1 && <Text size="10px" c="orange" mt={3}>已尝试 {tool.attempt_count} 次</Text>}
                        </Box>
                      ))}
                    </Stack>
                  ) : <Text size="xs" c="dimmed">还没有工具调用</Text>}
                </Box>

                {detail.artifacts.length > 0 && (
                  <Box p="sm" style={cardStyle}>
                    <SectionTitle count={detail.artifacts.length}>产物</SectionTitle>
                    <Stack gap={5}>
                      {detail.artifacts.map((artifact) => (
                        <Tooltip key={artifact.id} label={artifact.path || ''} disabled={!artifact.path}>
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            justify="flex-start"
                            leftSection={<IconFile size={13} />}
                            onClick={() => artifact.path && void revealInFinder(artifact.path)}
                            style={{ width: '100%' }}
                          >
                            {runArtifactName(artifact.path)}
                          </Button>
                        </Tooltip>
                      ))}
                    </Stack>
                  </Box>
                )}

                <Box p="sm" style={cardStyle}>
                  <SectionTitle count={detail.events.length}>最近事件</SectionTitle>
                  <Stack gap={7}>
                    {[...detail.events].reverse().slice(0, 12).map((event) => (
                      <Group key={event.id} align="flex-start" gap={8} wrap="nowrap">
                        <Text size="10px" c="dimmed" w={24} style={{ flex: 'none' }}>#{event.seq}</Text>
                        <Box style={{ minWidth: 0 }}>
                          <Text size="xs" fw={600}>{event.event_type}</Text>
                          {(event.output_summary || event.error_message) && <Text size="10px" c={event.error_message ? 'red' : 'dimmed'} lineClamp={2}>{event.error_message || event.output_summary}</Text>}
                        </Box>
                      </Group>
                    ))}
                  </Stack>
                </Box>
              </>
            )}
          </Stack>
        </ScrollArea>
      )}
    </Stack>
  )
}
