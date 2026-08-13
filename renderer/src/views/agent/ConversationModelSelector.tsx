import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@mantine/core'
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconMessageCircle,
  IconSettings,
} from '@tabler/icons-react'
import { getAgentModel } from '@/api/agent'
import { subscribeDshModelSettingsEvents } from '@/api/dsh-models'
import styles from './ConversationModelSelector.module.scss'

export interface ConversationModelRuntime {
  modelId: string
  modelName: string
  reasoningEffort: string
  reasoningSummary: string
  verbosity: string
  /** null means the DSH catalog did not declare a per-model modality. */
  supportsImageInput: boolean | null
}

interface ModelOption {
  id: string
  model_name: string
  display_name?: string | null
  api_format?: string | null
  source?: 'dsh'
  provider?: string
  provider_name?: string
  is_enabled?: boolean
  capabilities?: {
    supports_image_input?: boolean
    reasoning_efforts?: string[]
    reasoning_effort_options?: CapabilityOption[]
    reasoning_effort_default?: string
    reasoning_summaries?: string[]
    reasoning_summary_options?: CapabilityOption[]
    reasoning_summary_default?: string
    verbosity_levels?: string[]
    verbosity_options?: CapabilityOption[]
    verbosity_default?: string
  }
}

interface CapabilityOption {
  value: string
  label?: string
}

interface Props {
  projectId: string
  conversationId: string | null
  onChange: (runtime: ConversationModelRuntime | null) => void
  onOpenSettings: () => void
  openRequest?: number
}

function imageInputCapability(model: ModelOption | null | undefined): boolean | null {
  const declared = model?.capabilities?.supports_image_input
  if (declared === true || declared === false) return declared
  return model?.source === 'dsh' ? null : false
}

type Section = 'model' | 'reasoning' | 'summary' | 'verbosity'

const REASONING_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'minimal', label: '最少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

const SUMMARY_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'concise', label: '简短' },
  { value: 'detailed', label: '详细' },
  { value: 'none', label: '不显示' },
]

const VERBOSITY_OPTIONS = [
  { value: 'low', label: '简洁' },
  { value: 'medium', label: '适中' },
  { value: 'high', label: '详细' },
]

function capabilityOptions(
  configured: CapabilityOption[] | undefined,
  supported: string[],
  fallback: CapabilityOption[]
) {
  const configuredByValue = new Map(
    (configured || []).map((option) => [String(option.value), option])
  )
  const fallbackByValue = new Map(fallback.map((option) => [option.value, option.label]))
  return supported.map((value) => ({
    value,
    label: configuredByValue.get(value)?.label?.trim() || fallbackByValue.get(value) || value,
  }))
}

export default function ConversationModelSelector({ projectId, conversationId, onChange, onOpenSettings, openRequest = 0 }: Props) {
  const [opened, setOpened] = useState(false)
  const [section, setSection] = useState<Section>('model')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [reasoningSummary, setReasoningSummary] = useState('')
  const [verbosity, setVerbosity] = useState('')
  const [catalogRevision, setCatalogRevision] = useState(0)
  const handledOpenRequest = useRef(0)

  const selected = useMemo(
    () => models.find((model) => model.id === selectedId) || null,
    [models, selectedId]
  )

  useEffect(() => {
    if (!openRequest || loading || handledOpenRequest.current === openRequest) return
    handledOpenRequest.current = openRequest
    if (failed || models.length === 0) {
      onOpenSettings()
      return
    }
    setSection('model')
    setOpened(true)
  }, [failed, loading, models.length, onOpenSettings, openRequest])

  useEffect(() => {
    const controller = new AbortController()
    void subscribeDshModelSettingsEvents((event) => {
      if (event.type === 'dsh_models.changed') setCatalogRevision((value) => value + 1)
    }, controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setFailed(false)
    setModels([])
    setSelectedId('')
    onChange(null)
    if (!projectId) {
      setLoading(false)
      return () => { alive = false }
    }
    getAgentModel(projectId, conversationId)
      .then((res: any) => {
        if (!alive) return
        const items = Array.isArray(res?.data?.items) ? res.data.items : []
        const currentId = String(res?.data?.default_model_id || res?.data?.model_id || '')
        const initial = items.find((item: ModelOption) => item.id === currentId)
          || items[0]
          || null
        const initialEffort = initial?.capabilities?.reasoning_effort_default || ''
        const initialSummary = initial?.capabilities?.reasoning_summary_default || ''
        const initialVerbosity = initial?.capabilities?.verbosity_default || ''
        setModels(items)
        setSelectedId(initial?.id || '')
        setReasoningEffort(initialEffort)
        setReasoningSummary(initialSummary)
        setVerbosity(initialVerbosity)
        if (initial) {
          onChange({
            modelId: initial.id,
            modelName: initial.model_name,
            reasoningEffort: initialEffort,
            reasoningSummary: initialSummary,
            verbosity: initialVerbosity,
            supportsImageInput: imageInputCapability(initial),
          })
        }
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [catalogRevision, conversationId, projectId, onChange])

  const publish = (
    model: ModelOption | null,
    effort = reasoningEffort,
    summary = reasoningSummary,
    detail = verbosity
  ) => {
    if (!model) return onChange(null)
    const runtime = {
      modelId: model.id,
      modelName: model.model_name,
      reasoningEffort: effort,
      reasoningSummary: summary,
      verbosity: detail,
      supportsImageInput: imageInputCapability(model),
    }
    onChange(runtime)
  }

  const chooseModel = (model: ModelOption) => {
    const effort = model.capabilities?.reasoning_effort_default
      || ''
    const summary = model.capabilities?.reasoning_summary_default
      || ''
    const detail = model.capabilities?.verbosity_default
      || ''
    setSelectedId(model.id)
    setReasoningEffort(effort)
    setReasoningSummary(summary)
    setVerbosity(detail)
    publish(model, effort, summary, detail)
    setOpened(false)
  }

  const chooseReasoning = (value: string) => {
    setReasoningEffort(value)
    publish(selected, value, reasoningSummary, verbosity)
  }

  const chooseSummary = (value: string) => {
    setReasoningSummary(value)
    publish(selected, reasoningEffort, value, verbosity)
  }

  const chooseVerbosity = (value: string) => {
    setVerbosity(value)
    publish(selected, reasoningEffort, reasoningSummary, value)
  }

  const modelLabel = loading
    ? '读取模型…'
    : failed
      ? '检查模型设置'
      : selected?.display_name || selected?.model_name || '去设置模型'
  const supportedReasoning = selected?.capabilities?.reasoning_efforts || []
  const supportedSummaries = selected?.capabilities?.reasoning_summaries || []
  const supportedVerbosity = selected?.capabilities?.verbosity_levels || []
  const reasoningOptions = capabilityOptions(
    selected?.capabilities?.reasoning_effort_options,
    supportedReasoning,
    REASONING_OPTIONS
  )
  const summaryOptions = capabilityOptions(
    selected?.capabilities?.reasoning_summary_options,
    supportedSummaries,
    SUMMARY_OPTIONS
  )
  const verbosityOptions = capabilityOptions(
    selected?.capabilities?.verbosity_options,
    supportedVerbosity,
    VERBOSITY_OPTIONS
  )
  const effortLabel = reasoningOptions.find((item) => item.value === reasoningEffort)?.label
  const label = selected && !loading && effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel

  const open = () => {
    if (!loading && (failed || models.length === 0)) {
      onOpenSettings()
      return
    }
    setSection('model')
    setOpened((value) => !value)
  }

  const rightTitle = section === 'model'
    ? '选择模型'
    : section === 'reasoning'
      ? '推理强度'
      : section === 'summary'
        ? '思考摘要'
        : '回答详细度'
  const activeOptions = (section === 'reasoning'
    ? reasoningOptions
    : section === 'summary'
      ? summaryOptions
      : verbosityOptions)
  const activeValue = section === 'reasoning' ? reasoningEffort : section === 'summary' ? reasoningSummary : verbosity

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="top-end"
      offset={8}
      width={448}
      shadow="md"
      withinPortal
      classNames={{ dropdown: styles.dropdown }}
    >
      <Popover.Target>
        <button
          type="button"
          className={styles.trigger}
          data-state={failed || (!loading && models.length === 0) ? 'needs-setup' : 'configured'}
          onClick={open}
          aria-label={selected ? `当前模型：${label}，点击切换模型` : label}
          title={selected ? `当前模型：${label}，点击切换模型` : label}
        >
          <span>{label}</span>
          <IconChevronDown size={12} stroke={2} aria-hidden="true" />
        </button>
      </Popover.Target>

      <Popover.Dropdown>
        <div className={styles.panel}>
          <div className={styles.menu}>
            <button className={section === 'model' ? styles.activeMenu : ''} onClick={() => setSection('model')}>
              <IconMessageCircle size={14} />
              <span><strong>模型</strong><small>{selected?.display_name || selected?.model_name || '未配置'}</small></span>
              <IconChevronRight size={12} />
            </button>
            {supportedReasoning.length > 0 && (
              <button className={section === 'reasoning' ? styles.activeMenu : ''} onClick={() => setSection('reasoning')}>
                <IconAdjustmentsHorizontal size={14} />
                <span><strong>推理强度</strong><small>{reasoningOptions.find((item) => item.value === reasoningEffort)?.label}</small></span>
                <IconChevronRight size={12} />
              </button>
            )}
            {supportedSummaries.length > 0 && (
              <button className={section === 'summary' ? styles.activeMenu : ''} onClick={() => setSection('summary')}>
                <IconAdjustmentsHorizontal size={14} />
                <span><strong>思考摘要</strong><small>{summaryOptions.find((item) => item.value === reasoningSummary)?.label}</small></span>
                <IconChevronRight size={12} />
              </button>
            )}
            {supportedVerbosity.length > 0 && (
              <button className={section === 'verbosity' ? styles.activeMenu : ''} onClick={() => setSection('verbosity')}>
                <IconAdjustmentsHorizontal size={14} />
                <span><strong>回答详细度</strong><small>{verbosityOptions.find((item) => item.value === verbosity)?.label}</small></span>
                <IconChevronRight size={12} />
              </button>
            )}
            <button className={styles.manage} onClick={() => { setOpened(false); onOpenSettings() }}>
              <IconSettings size={14} />
              <span><strong>管理模型</strong><small>连接与密钥</small></span>
            </button>
          </div>

          <div className={styles.options}>
            <div className={styles.optionsTitle}>{rightTitle}</div>
            {section === 'model' ? models.map((model) => (
              <button
                key={model.id}
                className={`${styles.option} ${model.id === selectedId ? styles.selectedOption : ''}`}
                onClick={() => chooseModel(model)}
              >
                <span>
                  <strong>{model.display_name || model.model_name}</strong>
                  <small>{model.provider_name || model.provider || 'DSH'}</small>
                </span>
                {model.id === selectedId && <IconCheck size={16} />}
              </button>
            )) : activeOptions.map((option) => (
              <button
                key={option.value}
                className={styles.option}
                onClick={() => section === 'reasoning'
                  ? chooseReasoning(option.value)
                  : section === 'summary'
                    ? chooseSummary(option.value)
                    : chooseVerbosity(option.value)}
              >
                <span><strong>{option.label}</strong></span>
                {option.value === activeValue && <IconCheck size={16} />}
              </button>
            ))}
          </div>
        </div>
      </Popover.Dropdown>
    </Popover>
  )
}
