import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  MultiSelect,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconAlertTriangle,
  IconCalendarTime,
  IconChevronRight,
  IconClock,
  IconExternalLink,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTrash
} from '@tabler/icons-react'
import {
  createAgentAutomation,
  deleteAgentAutomation,
  getAgentModel,
  listAgentAutomationRuns,
  listAgentAutomations,
  markAllAgentAutomationRunsRead,
  markAgentAutomationRunRead,
  runAgentAutomation,
  setAgentAutomationStatus,
  updateAgentAutomation,
  type AgentAutomation,
  type AgentAutomationInput,
  type AgentAutomationRun,
  type AgentAutomationSchedule
} from '@/api/agent'
import { getEnabledSkillsReq } from '@/api/skills'
import { isSkillRunnable } from '../skills/skillAvailability'
import styles from './AutomationCenter.module.scss'

export interface ScheduledTaskProject {
  id: string
  name: string
}

interface AutomationCenterProps {
  projects: ScheduledTaskProject[]
  initialProjectId?: string | null
  requestedTaskId?: string | null
  requestedDraft?: { prompt: string; nonce: number } | null
  onOpenRun?: (run: AgentAutomationRun) => void
  onOpenModelSettings?: () => void
}

interface ModelOption {
  id: string
  model_name: string
  display_name?: string | null
  is_enabled?: boolean
  source?: 'project' | 'system'
  capabilities?: {
    reasoning_efforts?: string[]
    reasoning_effort_options?: Array<{ value: string; label?: string }>
  }
}

interface Draft {
  name: string
  prompt: string
  projectId: string
  modelId: string
  modelName: string
  reasoningEffort: string
  destinationType: 'standalone' | 'conversation'
  skills: string[]
  scheduleType: AgentAutomationSchedule['type']
  intervalMinutes: number
  onceAt: string
  time: string
  weekday: string
  timezone: string
  rrule: string
  eventName: string
  debounceSeconds: number
  missedMode: 'run_once' | 'skip' | 'within_grace'
  graceMinutes: number
  monitorMode: 'always' | 'change_only'
  maxFailures: number
}

interface SkillOption {
  name: string
  selection_key?: string | null
  qualified_name?: string | null
  description?: string
  plugin_name?: string | null
  version?: string | null
  effective_enabled?: boolean
  availability?: string
}

type ScheduledTask = AgentAutomation & { project_name: string }
type ScheduledRun = AgentAutomationRun & { project_name: string }
type TaskFilter = 'all' | 'enabled' | 'paused' | 'attention'

const EMPTY_DRAFT: Draft = {
  name: '',
  prompt: '',
  projectId: '',
  modelId: '',
  modelName: '',
  reasoningEffort: '',
  destinationType: 'standalone',
  skills: [],
  scheduleType: 'manual',
  intervalMinutes: 60,
  onceAt: '',
  time: '09:00',
  weekday: '1',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  eventName: 'app.started',
  debounceSeconds: 30,
  missedMode: 'run_once',
  graceMinutes: 60,
  monitorMode: 'always',
  maxFailures: 3
}

const TEMPLATES: Array<{ id: string; name: string; description: string; draft: Partial<Draft> }> = [
  {
    id: 'daily-brief',
    name: '每日项目简报',
    description: '每天汇总项目进展、待办和需要关注的问题。',
    draft: {
      name: '每日项目简报',
      prompt: '汇总最近一个完整自然日的项目进展、已完成事项、剩余待办和需要关注的问题。结果要简洁，并标明依据来自哪些文件或对话。',
      scheduleType: 'daily'
    }
  },
  {
    id: 'project-risk',
    name: '项目风险巡检',
    description: '定时检查阻塞、失败记录和长期未处理的事项。',
    draft: {
      name: '项目风险巡检',
      prompt: '检查项目中是否存在失败记录、长期未处理的待办、缺失文件或其他阻塞。只报告有依据的问题，并给出建议的排查方向。',
      scheduleType: 'daily',
      time: '10:00'
    }
  },
  {
    id: 'workspace-readiness',
    name: '工作区准备检查',
    description: '检查项目文件和运行环境是否已经准备好。',
    draft: {
      name: '工作区准备检查',
      prompt: '检查当前项目的文件、来源目录、模型配置和运行环境是否已经准备好。列出阻塞项、影响范围和下一步修复建议；没有问题时明确说明。',
      scheduleType: 'interval',
      intervalMinutes: 60
    }
  }
]

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const TIMEZONES = (() => {
  try {
    return (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') || ['UTC', 'Asia/Shanghai']
  } catch {
    return ['UTC', 'Asia/Shanghai']
  }
})()
const PROJECT_DEFAULT_MODEL = '__project_default_model__'
const MODEL_DEFAULT_EFFORT = '__model_default_effort__'
const REASONING_LABELS: Record<string, string> = {
  none: '无', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大'
}

function timeLabel(value?: string | null) {
  if (!value) return '未排期'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未排期'
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function localDateTimeValue(value?: string | null) {
  if (value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value.slice(0, 16)
  const date = new Date(Date.now() + 60 * 60_000)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function scheduleLabel(schedule: AgentAutomationSchedule) {
  if (schedule.type === 'manual') return '仅手动运行'
  if (schedule.type === 'once') return `一次 · ${schedule.local_at?.replace('T', ' ') || timeLabel(schedule.run_at)}`
  if (schedule.type === 'interval') return `每 ${schedule.interval_minutes} 分钟`
  if (schedule.type === 'daily') return `每天 ${schedule.time} · ${schedule.timezone || '本机时区'}`
  if (schedule.type === 'weekly') return `每${WEEKDAYS[Number(schedule.weekday || 0)]} ${schedule.time} · ${schedule.timezone || '本机时区'}`
  if (schedule.type === 'rrule') return `${schedule.rrule} · ${schedule.timezone || '本机时区'}`
  return `事件 · ${schedule.event_name}`
}

function draftFromTask(task: ScheduledTask): Draft {
  return {
    name: task.name,
    prompt: task.prompt,
    projectId: task.project_id,
    modelId: task.model_id || '',
    modelName: task.model_name || '',
    reasoningEffort: task.reasoning_effort || '',
    destinationType: task.destination?.type || 'standalone',
    skills: [...(task.skills || [])],
    scheduleType: task.schedule.type,
    intervalMinutes: Number(task.schedule.interval_minutes || 60),
    onceAt: localDateTimeValue(task.schedule.local_at || task.schedule.run_at),
    time: task.schedule.time || '09:00',
    weekday: String(task.schedule.weekday ?? 1),
    timezone: task.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    rrule: task.schedule.rrule || 'FREQ=WEEKLY;BYDAY=MO',
    eventName: task.schedule.event_name || 'app.started',
    debounceSeconds: Number(task.schedule.debounce_seconds ?? 30),
    missedMode: task.missed_policy?.mode || 'run_once',
    graceMinutes: Number(task.missed_policy?.grace_minutes || 60),
    monitorMode: task.monitor_policy?.mode || 'always',
    maxFailures: Number(task.max_consecutive_failures || 3)
  }
}

function scheduleFromDraft(draft: Draft): AgentAutomationSchedule {
  if (draft.scheduleType === 'once') return { type: 'once', local_at: draft.onceAt, timezone: draft.timezone }
  if (draft.scheduleType === 'interval') return { type: 'interval', interval_minutes: draft.intervalMinutes }
  if (draft.scheduleType === 'daily') return { type: 'daily', time: draft.time, timezone: draft.timezone }
  if (draft.scheduleType === 'weekly') return { type: 'weekly', time: draft.time, weekday: Number(draft.weekday), timezone: draft.timezone }
  if (draft.scheduleType === 'rrule') return { type: 'rrule', rrule: draft.rrule, timezone: draft.timezone }
  if (draft.scheduleType === 'event') return { type: 'event', event_name: draft.eventName, debounce_seconds: draft.debounceSeconds }
  return { type: 'manual' }
}

function runStatus(run: ScheduledRun) {
  if (run.status === 'completed') return { label: '成功', color: 'teal' }
  if (run.status === 'failed') return { label: '失败', color: 'red' }
  if (run.status === 'needs_attention') return { label: '需要处理', color: 'yellow' }
  if (run.status === 'skipped') return { label: '已跳过', color: 'gray' }
  if (run.status === 'running') return { label: '运行中', color: 'blue' }
  return { label: run.status || '未知', color: 'gray' }
}

export default function AutomationCenter({ projects, initialProjectId, requestedTaskId, requestedDraft, onOpenRun, onOpenModelSettings }: AutomationCenterProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [runs, setRuns] = useState<ScheduledRun[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'detail' | 'create' | 'edit'>('detail')
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionId, setActionId] = useState('')
  const [error, setError] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [defaultModelId, setDefaultModelId] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')

  const defaultProjectId = useMemo(
    () => projects.some((project) => project.id === initialProjectId) ? String(initialProjectId) : projects[0]?.id || '',
    [initialProjectId, projects]
  )

  const load = useCallback(async () => {
    if (!projects.length) {
      setTasks([])
      setRuns([])
      return
    }
    setLoading(true)
    setError('')
    const results = await Promise.allSettled(projects.map(async (project) => {
      const [taskResponse, runResponse]: any[] = await Promise.all([
        listAgentAutomations(project.id),
        listAgentAutomationRuns(project.id)
      ])
      const projectTasks = (taskResponse?.data?.items || taskResponse?.items || []).map((task: AgentAutomation) => ({ ...task, project_name: project.name }))
      const projectRuns = (runResponse?.data?.items || runResponse?.items || []).map((run: AgentAutomationRun) => ({ ...run, project_name: project.name }))
      return { projectTasks, projectRuns }
    }))
    const nextTasks: ScheduledTask[] = []
    const nextRuns: ScheduledRun[] = []
    let failed = 0
    for (const result of results) {
      if (result.status === 'fulfilled') {
        nextTasks.push(...result.value.projectTasks)
        nextRuns.push(...result.value.projectRuns)
      } else failed += 1
    }
    nextTasks.sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at))
    nextRuns.sort((a, b) => Date.parse(b.finished_at || b.started_at || b.created_at) - Date.parse(a.finished_at || a.started_at || a.created_at))
    setTasks(nextTasks)
    setRuns(nextRuns)
    setSelectedTaskId((current) => {
      const requested = String(requestedTaskId || '').trim()
      if (requested && nextTasks.some((task) => task.id === requested)) return requested
      if (nextTasks.some((task) => task.id === current)) return current
      return nextTasks[0]?.id || ''
    })
    if (failed) setError(`${failed} 个项目的定时任务暂时无法读取`)
    setLoading(false)
  }, [projects, requestedTaskId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let alive = true
    if ((mode !== 'create' && mode !== 'edit') || !draft.projectId) {
      setModels([])
      setDefaultModelId('')
      setModelsError('')
      setModelsLoading(false)
      return () => { alive = false }
    }
    setModelsLoading(true)
    setModelsError('')
    getAgentModel(draft.projectId)
      .then((response: any) => {
        if (!alive) return
        const data = response?.data || response || {}
        const items = (Array.isArray(data.items) ? data.items : []).filter((model: ModelOption) => model.is_enabled !== false)
        setModels(items)
        setDefaultModelId(String(data.default_model_id || data.model_id || ''))
        setDraft((current) => {
          if (!current.modelId || items.some((model: ModelOption) => model.id === current.modelId)) return current
          return { ...current, modelId: '', modelName: '', reasoningEffort: '' }
        })
      })
      .catch(() => {
        if (!alive) return
        setModels([])
        setDefaultModelId('')
        setModelsError('模型列表读取失败')
      })
      .finally(() => { if (alive) setModelsLoading(false) })
    return () => { alive = false }
  }, [draft.projectId, mode])

  useEffect(() => {
    let alive = true
    if ((mode !== 'create' && mode !== 'edit') || !draft.projectId) {
      setSkills([])
      setSkillsError('')
      setSkillsLoading(false)
      return () => { alive = false }
    }
    setSkillsLoading(true)
    setSkillsError('')
    getEnabledSkillsReq(draft.projectId)
      .then((response: any) => {
        if (!alive) return
        const data = response?.data?.data || response?.data || response || []
        const items = (Array.isArray(data) ? data : []).filter((skill: SkillOption) => isSkillRunnable(skill))
        setSkills(items)
      })
      .catch(() => {
        if (!alive) return
        setSkills([])
        setSkillsError('Skill 列表读取失败')
      })
      .finally(() => { if (alive) setSkillsLoading(false) })
    return () => { alive = false }
  }, [draft.projectId, mode])

  const attentionTaskIds = useMemo(
    () => new Set(runs.filter((run) => run.requires_attention || run.status === 'needs_attention').map((run) => run.automation_id)),
    [runs]
  )
  const unreadCount = runs.filter((run) => run.inbox_status === 'unread').length
  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return tasks.filter((task) => {
      if (filter === 'enabled' && task.status !== 'enabled') return false
      if (filter === 'paused' && task.status !== 'paused') return false
      if (filter === 'attention' && !attentionTaskIds.has(task.id)) return false
      if (!query) return true
      return `${task.name} ${task.prompt} ${task.project_name}`.toLowerCase().includes(query)
    })
  }, [attentionTaskIds, filter, search, tasks])
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null
  const selectedRuns = selectedTask ? runs.filter((run) => run.automation_id === selectedTask.id) : []
  const selectedModel = models.find((model) => model.id === draft.modelId) || null
  const capabilityModel = selectedModel || models.find((model) => model.id === defaultModelId) || null
  const reasoningOptions = useMemo(() => {
    const configured = new Map((capabilityModel?.capabilities?.reasoning_effort_options || []).map((item) => [item.value, item.label]))
    return (capabilityModel?.capabilities?.reasoning_efforts || []).map((value) => ({
      value,
      label: configured.get(value)?.trim() || REASONING_LABELS[value] || value
    }))
  }, [capabilityModel])

  const openCreate = (template?: (typeof TEMPLATES)[number]) => {
    setDraft({
      ...EMPTY_DRAFT,
      projectId: defaultProjectId,
      skills: [...EMPTY_DRAFT.skills],
      onceAt: localDateTimeValue(),
      ...(template?.draft || {})
    })
    setMode('create')
  }

  useEffect(() => {
    if (!requestedDraft || !defaultProjectId) return
    setDraft({
      ...EMPTY_DRAFT,
      projectId: defaultProjectId,
      skills: [...EMPTY_DRAFT.skills],
      onceAt: localDateTimeValue(),
      prompt: requestedDraft.prompt
    })
    setMode('create')
  }, [defaultProjectId, requestedDraft?.nonce])

  const openEdit = () => {
    if (!selectedTask) return
    setDraft(draftFromTask(selectedTask))
    setMode('edit')
  }

  const save = async () => {
    if (!draft.projectId || !draft.name.trim() || !draft.prompt.trim()) return
    const payload: AgentAutomationInput = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      destination: draft.destinationType === 'conversation' && selectedTask?.destination?.session_id
        ? { type: 'conversation', session_id: selectedTask.destination.session_id }
        : { type: 'standalone' },
      skills: draft.skills,
      model_id: draft.modelId || null,
      model_name: draft.modelName || null,
      reasoning_effort: draft.reasoningEffort || null,
      schedule: scheduleFromDraft(draft),
      missed_policy: { mode: draft.missedMode, grace_minutes: draft.graceMinutes },
      monitor_policy: { mode: draft.monitorMode },
      max_consecutive_failures: draft.maxFailures
    }
    setSaving(true)
    try {
      const response: any = mode === 'edit' && selectedTask
        ? await updateAgentAutomation(selectedTask.id, payload)
        : await createAgentAutomation(draft.projectId, payload)
      const savedId = response?.data?.id || selectedTask?.id || ''
      notifications.show({ color: 'teal', message: mode === 'edit' ? '定时任务已更新' : '定时任务已创建' })
      setMode('detail')
      if (savedId) setSelectedTaskId(savedId)
      await load()
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.message || '保存定时任务失败' })
    } finally {
      setSaving(false)
    }
  }

  const toggle = async () => {
    if (!selectedTask) return
    setActionId(selectedTask.id)
    try {
      await setAgentAutomationStatus(selectedTask.id, selectedTask.status === 'enabled' ? 'paused' : 'enabled')
      await load()
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.message || '更新任务状态失败' })
    } finally {
      setActionId('')
    }
  }

  const runNow = async () => {
    if (!selectedTask) return
    setActionId(selectedTask.id)
    try {
      const response: any = await runAgentAutomation(selectedTask.id)
      const item: AgentAutomationRun = response?.data
      notifications.show({
        color: item?.requires_attention ? 'yellow' : item?.status === 'completed' ? 'teal' : 'red',
        message: item?.requires_attention ? '任务已暂停，等待你处理' : item?.status === 'completed' ? '定时任务运行完成' : '定时任务运行失败'
      })
      await load()
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.message || '运行定时任务失败' })
    } finally {
      setActionId('')
    }
  }

  const remove = () => {
    if (!selectedTask) return
    modals.openConfirmModal({
      title: '删除这个定时任务？',
      children: <Text size="sm">后续排期会停止，已经产生的运行记录和证据仍然保留。</Text>,
      labels: { confirm: '删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        setActionId(selectedTask.id)
        try {
          await deleteAgentAutomation(selectedTask.id)
          setSelectedTaskId('')
          await load()
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.message || '删除定时任务失败' })
        } finally {
          setActionId('')
        }
      }
    })
  }

  const openRun = async (run: ScheduledRun) => {
    if (run.inbox_status === 'unread') await markAgentAutomationRunRead(run.id).catch(() => null)
    onOpenRun?.(run)
    void load()
  }

  const markAllRead = async () => {
    await Promise.allSettled(projects.map((project) => markAllAgentAutomationRunsRead(project.id)))
    await load()
  }

  const form = (
    <Stack gap="md" className={styles.form} data-scheduled-task-form>
      <div>
        <Text fw={700} size="lg">{mode === 'edit' ? '编辑定时任务' : '创建定时任务'}</Text>
        <Text size="sm" c="dimmed" mt={3}>任务会在选定项目中运行，并遵守项目数据范围和工具权限。</Text>
      </div>
      <Select
        label="运行项目"
        data={projects.map((project) => ({ value: project.id, label: project.name }))}
        value={draft.projectId}
        onChange={(value) => setDraft((current) => ({
          ...current,
          projectId: value || '',
          modelId: '',
          modelName: '',
          reasoningEffort: ''
        }))}
        disabled={mode === 'edit'}
        required
      />
      <div className={styles.formGrid} data-scheduled-task-model-settings>
        <Select
          label="运行模型"
          data={[
            { value: PROJECT_DEFAULT_MODEL, label: '使用项目默认模型' },
            ...models.map((model) => ({
              value: model.id,
              label: `${model.display_name || model.model_name}${model.source === 'project' ? ' · 项目' : ''}`
            }))
          ]}
          value={draft.modelId || PROJECT_DEFAULT_MODEL}
          onChange={(value) => {
            const model = models.find((item) => item.id === value && value !== PROJECT_DEFAULT_MODEL)
            const supported = model?.capabilities?.reasoning_efforts || []
            setDraft((current) => ({
              ...current,
              modelId: model?.id || '',
              modelName: model?.model_name || '',
              reasoningEffort: supported.includes(current.reasoningEffort) ? current.reasoningEffort : ''
            }))
          }}
          disabled={modelsLoading || !models.length}
          searchable
          nothingFoundMessage="没有匹配的模型"
          description={modelsLoading ? '正在读取项目模型…' : modelsError || '不选择时会跟随项目默认模型。'}
        />
        <Select
          label="推理强度"
          data={[{ value: MODEL_DEFAULT_EFFORT, label: '使用模型默认值' }, ...reasoningOptions]}
          value={draft.reasoningEffort || MODEL_DEFAULT_EFFORT}
          onChange={(value) => setDraft((current) => ({
            ...current,
            reasoningEffort: value === MODEL_DEFAULT_EFFORT ? '' : value || ''
          }))}
          disabled={modelsLoading || !reasoningOptions.length}
          description={reasoningOptions.length ? '只影响这个定时任务。' : '当前模型没有可调的推理强度。'}
        />
      </div>
      {!modelsLoading && (!models.length || modelsError) && (
        <Group gap={8} className={styles.modelNotice}>
          <Text size="xs" c={modelsError ? 'red' : 'dimmed'}>{modelsError || '当前项目还没有可用模型。'}</Text>
          <Button variant="subtle" size="compact-xs" onClick={onOpenModelSettings}>去设置模型</Button>
        </Group>
      )}
      <Select
        label="对话方式"
        value={draft.destinationType}
        onChange={(value) => setDraft((current) => ({ ...current, destinationType: (value || 'standalone') as Draft['destinationType'] }))}
        data={[
          { value: 'standalone', label: '每次新建独立对话' },
          ...(selectedTask?.destination?.type === 'conversation' ? [{ value: 'conversation', label: '回到创建任务的原对话' }] : [])
        ]}
        description="独立对话不会把多次后台运行混在同一段上下文中。"
      />
      <TextInput label="任务名称" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))} required />
      <Textarea label="执行指令" minRows={6} autosize value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.currentTarget.value }))} required />
      <div className={styles.formGrid}>
        <Select
          label="重复"
          data-scheduled-task-schedule
          value={draft.scheduleType}
          onChange={(value) => setDraft((current) => ({ ...current, scheduleType: (value || 'manual') as Draft['scheduleType'] }))}
          data={[
            { value: 'manual', label: '仅手动运行' },
            { value: 'once', label: '运行一次' },
            { value: 'interval', label: '固定间隔' },
            { value: 'daily', label: '每天' },
            { value: 'weekly', label: '每周' },
            { value: 'rrule', label: '自定义重复规则' },
            { value: 'event', label: '本地事件触发' }
          ]}
        />
        {draft.scheduleType === 'once' && <TextInput type="datetime-local" label="运行时间" value={draft.onceAt} onChange={(event) => setDraft((current) => ({ ...current, onceAt: event.currentTarget.value }))} required />}
        {draft.scheduleType === 'interval' && <NumberInput label="间隔分钟" min={5} max={43200} value={draft.intervalMinutes} onChange={(value) => setDraft((current) => ({ ...current, intervalMinutes: Number(value || 60) }))} />}
        {(draft.scheduleType === 'daily' || draft.scheduleType === 'weekly') && <TextInput type="time" label="运行时间" value={draft.time} onChange={(event) => setDraft((current) => ({ ...current, time: event.currentTarget.value }))} />}
        {draft.scheduleType === 'weekly' && <Select label="星期" value={draft.weekday} onChange={(value) => setDraft((current) => ({ ...current, weekday: value || '1' }))} data={WEEKDAYS.map((label, value) => ({ value: String(value), label }))} />}
        {(['once', 'daily', 'weekly', 'rrule'] as AgentAutomationSchedule['type'][]).includes(draft.scheduleType) && (
          <Select
            label="时区"
            searchable
            data={TIMEZONES}
            value={draft.timezone}
            onChange={(value) => setDraft((current) => ({ ...current, timezone: value || 'UTC' }))}
          />
        )}
        {draft.scheduleType === 'rrule' && (
          <TextInput
            label="RRULE"
            value={draft.rrule}
            onChange={(event) => setDraft((current) => ({ ...current, rrule: event.currentTarget.value }))}
            description="RFC 5545，例如 FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9"
          />
        )}
        {draft.scheduleType === 'event' && (
          <TextInput
            label="本地事件名称"
            value={draft.eventName}
            onChange={(event) => setDraft((current) => ({ ...current, eventName: event.currentTarget.value }))}
            description="例如 app.started；事件由 DSH 宿主或本地接口发布。"
          />
        )}
        {draft.scheduleType === 'event' && <NumberInput label="相同事件去重秒数" min={0} max={86400} value={draft.debounceSeconds} onChange={(value) => setDraft((current) => ({ ...current, debounceSeconds: Number(value || 0) }))} />}
      </div>
      {!['manual', 'event'].includes(draft.scheduleType) && (
        <div className={styles.formGrid}>
          <Select
            label="错过排期后"
            value={draft.missedMode}
            onChange={(value) => setDraft((current) => ({ ...current, missedMode: (value || 'run_once') as Draft['missedMode'] }))}
            data={[
              { value: 'run_once', label: '恢复后补跑一次' },
              { value: 'within_grace', label: '在允许延迟内补跑' },
              { value: 'skip', label: '直接跳过' }
            ]}
          />
          {draft.missedMode === 'within_grace' && <NumberInput label="最多延迟分钟" min={1} max={10080} value={draft.graceMinutes} onChange={(value) => setDraft((current) => ({ ...current, graceMinutes: Number(value || 60) }))} />}
        </div>
      )}
      <Select
        label="结果通知"
        value={draft.monitorMode}
        onChange={(value) => setDraft((current) => ({ ...current, monitorMode: (value || 'always') as Draft['monitorMode'] }))}
        data={[
          { value: 'always', label: '每次运行都显示未读结果' },
          { value: 'change_only', label: '仅结果变化时提醒' }
        ]}
        description="变化判断使用完整运行摘要指纹；相同结果仍保留运行记录。"
      />
      <MultiSelect
        label="固定使用的 Skill"
        data={skills.map((skill) => ({
          value: skill.selection_key || skill.qualified_name || (skill.plugin_name ? `${skill.plugin_name}:${skill.name}` : skill.name),
          label: `${skill.plugin_name ? `${skill.plugin_name} · ` : ''}${skill.name}${skill.version ? ` · ${skill.version}` : ''}`
        }))}
        value={draft.skills}
        onChange={(value) => setDraft((current) => ({ ...current, skills: value }))}
        searchable
        disabled={skillsLoading}
        description={skillsLoading ? '正在读取可用 Skill…' : skillsError || '保存时固定版本和内容指纹；发生变化后任务会暂停，等你确认。'}
      />
      <NumberInput label="连续失败后暂停" min={1} max={20} value={draft.maxFailures} onChange={(value) => setDraft((current) => ({ ...current, maxFailures: Number(value || 3) }))} />
      <Group justify="space-between" className={styles.safetyNote} wrap="nowrap">
        <Group gap={7} wrap="nowrap"><IconSettings size={15} /><Text size="xs">每次运行走 DSH、系统沙箱和自动审查；需要登录或更高权限时会安全停止并提示处理。</Text></Group>
      </Group>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => setMode('detail')}>取消</Button>
        <Button loading={saving} disabled={!draft.projectId || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void save()}>{mode === 'edit' ? '保存修改' : '创建任务'}</Button>
      </Group>
    </Stack>
  )

  return (
    <div className={styles.root} data-automation-center data-scheduled-tasks-page>
      <header className={styles.pageHeader}>
        <div>
          <Text component="h1" className={styles.title}>定时任务</Text>
          <Text size="sm" c="dimmed">让 DeepSeek Harness Desktop App 在本机按计划工作，或者只在结果变化时提醒你。</Text>
        </div>
        <Group gap={6}>
          {unreadCount > 0 && <Button variant="subtle" size="compact-xs" onClick={() => void markAllRead()}>全部已读</Button>}
          <ActionIcon variant="subtle" color="gray" onClick={() => void load()} loading={loading} aria-label="刷新定时任务"><IconRefresh size={17} /></ActionIcon>
          <Button leftSection={<IconPlus size={15} />} onClick={() => openCreate()} data-automation-create-open>创建任务</Button>
        </Group>
      </header>

      {error && <div className={styles.error}><IconAlertTriangle size={16} /><span>{error}</span></div>}

      <div className={styles.workspace}>
        <aside className={styles.listPane} aria-label="定时任务列表">
          <div className={styles.searchWrap}>
            <IconSearch size={15} />
            <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜索定时任务" aria-label="搜索定时任务" />
          </div>
          <div className={styles.filters} role="tablist" aria-label="任务状态">
            {([['all', '全部'], ['enabled', '已启用'], ['paused', '已暂停'], ['attention', '需要处理']] as const).map(([value, label]) => (
              <button key={value} type="button" data-active={filter === value ? 'true' : undefined} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <ScrollArea className={styles.listScroll} type="hover" scrollbarSize={7}>
            <div className={styles.taskList}>
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={styles.taskRow}
                  data-active={selectedTaskId === task.id && mode === 'detail' ? 'true' : undefined}
                  data-status={task.status}
                  onClick={() => { setSelectedTaskId(task.id); setMode('detail') }}
                  data-scheduled-task-id={task.id}
                >
                  <span className={styles.statusDot} />
                  <span className={styles.taskText}>
                    <strong>{task.name}</strong>
                    <small>{scheduleLabel(task.schedule)} · {task.project_name}</small>
                  </span>
                  {attentionTaskIds.has(task.id) ? <Badge size="xs" color="yellow" variant="light">处理</Badge> : <IconChevronRight size={14} />}
                </button>
              ))}
              {!filteredTasks.length && !loading && (
                <div className={styles.listEmpty}>{tasks.length ? '没有符合条件的任务' : '还没有定时任务'}</div>
              )}
            </div>
          </ScrollArea>
          <div className={styles.listFooter}>{tasks.length} 个任务{unreadCount ? ` · ${unreadCount} 条未读结果` : ''}</div>
        </aside>

        <main className={styles.detailPane}>
          <ScrollArea h="100%" type="hover" scrollbarSize={7}>
            <div className={styles.detailContent}>
              {mode === 'create' || mode === 'edit' ? form : selectedTask ? (
                <>
                  <div className={styles.detailHeader}>
                    <div>
                      <Group gap={7} mb={5}>
                        <Badge size="sm" variant="light" color={selectedTask.status === 'enabled' ? 'teal' : 'gray'}>{selectedTask.status === 'enabled' ? '已启用' : selectedTask.status === 'completed' ? '已完成' : '已暂停'}</Badge>
                        {attentionTaskIds.has(selectedTask.id) && <Badge size="sm" variant="light" color="yellow">需要处理</Badge>}
                      </Group>
                      <Text component="h2" className={styles.detailTitle}>{selectedTask.name}</Text>
                      <Text size="sm" c="dimmed">{selectedTask.project_name}</Text>
                    </div>
                    <Group gap={5}>
                      <Button variant="default" size="xs" onClick={openEdit} data-scheduled-task-edit>编辑</Button>
                      <Button variant="default" size="xs" leftSection={selectedTask.status === 'enabled' ? <IconPlayerPause size={13} /> : <IconPlayerPlay size={13} />} loading={actionId === selectedTask.id} onClick={() => void toggle()} data-scheduled-task-toggle>{selectedTask.status === 'enabled' ? '暂停' : selectedTask.status === 'completed' ? '重新启用' : '启用'}</Button>
                      <Button size="xs" leftSection={<IconPlayerPlay size={13} />} loading={actionId === selectedTask.id} onClick={() => void runNow()} data-scheduled-task-run-now>立即运行</Button>
                      <ActionIcon variant="subtle" color="red" onClick={remove} aria-label="删除定时任务"><IconTrash size={16} /></ActionIcon>
                    </Group>
                  </div>

                  <section className={styles.section}>
                    <Text className={styles.sectionLabel}>执行指令</Text>
                    <Text className={styles.prompt}>{selectedTask.prompt}</Text>
                  </section>

                  <section className={styles.section}>
                    <Text className={styles.sectionLabel}>任务设置</Text>
                    <dl className={styles.definitionList}>
                      <div><dt>项目</dt><dd>{selectedTask.project_name}</dd></div>
                      <div><dt>模型</dt><dd>{selectedTask.model_name || '项目默认模型'}</dd></div>
                      <div><dt>推理强度</dt><dd>{selectedTask.reasoning_effort ? REASONING_LABELS[selectedTask.reasoning_effort] || selectedTask.reasoning_effort : '模型默认值'}</dd></div>
                      <div><dt>对话方式</dt><dd>{selectedTask.destination?.type === 'conversation' ? '回到原对话' : '每次新建独立对话'}</dd></div>
                      <div><dt>重复</dt><dd>{scheduleLabel(selectedTask.schedule)}</dd></div>
                      <div><dt>下次运行</dt><dd>{timeLabel(selectedTask.next_run_at)}</dd></div>
                      <div><dt>错过排期</dt><dd>{selectedTask.missed_policy.mode === 'run_once' ? '恢复后补跑一次' : selectedTask.missed_policy.mode === 'skip' ? '跳过' : `延迟 ${selectedTask.missed_policy.grace_minutes || 60} 分钟内补跑`}</dd></div>
                      <div><dt>结果通知</dt><dd>{selectedTask.monitor_policy.mode === 'change_only' ? '仅变化时提醒' : '每次都提醒'}</dd></div>
                      <div><dt>Skill</dt><dd>{selectedTask.skill_snapshot.length ? selectedTask.skill_snapshot.map((skill) => `${skill.qualified_name}${skill.version ? `@${skill.version}` : ''}`).join('、') : '未固定'}</dd></div>
                      <div><dt>工具</dt><dd>当前项目可用工具，由 DSH 运行时控制</dd></div>
                      <div><dt>失败处理</dt><dd>连续失败 {selectedTask.max_consecutive_failures} 次后暂停</dd></div>
                      <div><dt>运行环境</dt><dd>DSH · 系统沙箱 · 自动审查 · 开始时保存快照</dd></div>
                    </dl>
                  </section>

                  <section className={styles.section}>
                    <Group justify="space-between" mb={8}>
                      <Text className={styles.sectionLabel}>运行历史</Text>
                      <Text size="xs" c="dimmed">{selectedRuns.length} 次</Text>
                    </Group>
                    <div className={styles.runList}>
                      {selectedRuns.map((run) => {
                        const status = runStatus(run)
                        return (
                          <button type="button" key={run.id} onClick={() => void openRun(run)} data-automation-open-run={run.id}>
                            <span className={styles.runDot} data-status={run.status} />
                            <span><strong>{timeLabel(run.finished_at || run.started_at)}</strong><small>{run.error_message || run.summary || '暂无摘要'}</small></span>
                            {run.change_status === 'unchanged' && <Badge size="xs" color="gray" variant="light">无变化</Badge>}
                            {run.change_status === 'changed' && <Badge size="xs" color="blue" variant="light">有变化</Badge>}
                            {run.inbox_status === 'unread' && <Badge size="xs">未读</Badge>}
                            <Badge size="xs" color={status.color} variant="light">{status.label}</Badge>
                            <IconExternalLink size={14} />
                          </button>
                        )
                      })}
                      {!selectedRuns.length && <div className={styles.historyEmpty}><IconClock size={18} /><span>还没有运行记录</span></div>}
                    </div>
                  </section>
                </>
              ) : (
                <div className={styles.welcome}>
                  <IconCalendarTime size={24} />
                  <Text fw={700} size="lg">创建第一个定时任务</Text>
                  <Text size="sm" c="dimmed">选择一个常用模板，或者从空白任务开始。</Text>
                  <div className={styles.templateList} data-automation-templates>
                    {TEMPLATES.map((template) => (
                      <button key={template.id} type="button" onClick={() => openCreate(template)} data-template-id={template.id}>
                        <strong>{template.name}</strong><span>{template.description}</span><IconChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                  <Button variant="default" onClick={() => openCreate()}>从空白任务开始</Button>
                </div>
              )}
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  )
}
