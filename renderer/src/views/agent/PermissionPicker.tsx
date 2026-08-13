// DSH owns the permission preset catalog and the current session value. This
// component only renders that projection and asks its caller to run the host
// `/permission <preset>` command.
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconAlertTriangle, IconCheck, IconHandStop, IconLockOpen, IconShieldCheck } from '@tabler/icons-react'
import type { DshPermissionOption, DshPermissionSelect } from '@/api/agent'
import styles from './agent.module.scss'

export type { DshPermissionOption, DshPermissionSelect } from '@/api/agent'

const KNOWN_LABELS: Record<string, string> = {
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
  custom: '自定义'
}

const KNOWN_DESCRIPTIONS: Record<string, string> = {
  'workspace-write': '可修改当前工作区；需要提升权限时由 DSH 请求确认',
  'danger-full-access': '不受工作区沙箱限制；仅在你信任当前任务时使用',
  custom: '当前 DSH 权限组合不属于可直接选择的预设'
}

function labelOf(option: DshPermissionOption) {
  return KNOWN_LABELS[option.value] || option.name || option.value
}

function descriptionOf(option: DshPermissionOption) {
  return KNOWN_DESCRIPTIONS[option.value] || option.description || '由当前 DSH Profile 提供'
}

function iconOf(value: string) {
  if (value === 'danger-full-access') return IconLockOpen
  if (value === 'workspace-write') return IconShieldCheck
  return IconHandStop
}

interface Props {
  value: DshPermissionSelect
  disabled?: boolean
  onChange: (preset: string) => void | Promise<void>
}

export default function PermissionPicker({ value, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [riskPreset, setRiskPreset] = useState<DshPermissionOption | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const active = useMemo(
    () => value.options.find((option) => option.value === value.currentValue)
      || { value: value.currentValue, name: value.currentValue },
    [value]
  )

  useEffect(() => {
    if (!open) setRiskPreset(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const select = async (option: DshPermissionOption) => {
    if (option.value === 'custom' || option.value === value.currentValue) {
      setOpen(false)
      return
    }
    if (option.value === 'danger-full-access' && riskPreset?.value !== option.value) {
      setRiskPreset(option)
      return
    }
    await onChange(option.value)
    setOpen(false)
  }

  const ActiveIcon = iconOf(active.value)
  return (
    <div
      className={styles.permPick}
      ref={ref}
      data-testid="dsh-permission-picker"
      data-dsh-permission-value={active.value}
    >
      <button
        type="button"
        data-testid="dsh-permission-trigger"
        className={styles.permBtn}
        onClick={() => setOpen((current) => !current)}
        title="DSH 会话权限"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
      >
        <ActiveIcon size={14} stroke={1.7} />
        <span>{labelOf(active)}</span>
      </button>

      {open && (
        <div className={styles.permPanel} role="menu" aria-label="DSH 会话权限">
          {riskPreset ? (
            <div className={styles.permRisk}>
              <div className={styles.permRiskTitle}>
                <IconAlertTriangle size={16} stroke={1.8} />
                确认启用完全访问
              </div>
              <p>DSH 将不再把文件操作限制在当前工作区。只应在你信任当前项目和任务时启用。</p>
              <div className={styles.permRiskActions}>
                <button type="button" onClick={() => setRiskPreset(null)}>返回</button>
                <button
                  type="button"
                  data-danger="true"
                  data-testid="dsh-confirm-full-access"
                  onClick={() => void select(riskPreset)}
                >确认启用</button>
              </div>
            </div>
          ) : (
            <>
              <div className={styles.permHd}>DSH 如何限制当前会话？</div>
              {value.options.map((option) => {
                const Icon = iconOf(option.value)
                const selected = option.value === value.currentValue
                const selectable = option.value !== 'custom'
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.permItem}
                    role="menuitemradio"
                    aria-checked={selected}
                    data-dsh-permission-option={option.value}
                    disabled={!selectable}
                    onClick={() => void select(option)}
                  >
                    <Icon size={17} stroke={1.6} className={styles.permItemIcon} />
                    <span className={styles.permItemBody}>
                      <span className={styles.permItemLabel}>{labelOf(option)}</span>
                      <span className={styles.permItemDesc}>{descriptionOf(option)}</span>
                    </span>
                    {selected && <IconCheck size={15} stroke={2} className={styles.permCheck} />}
                  </button>
                )
              })}
              <div className={styles.permNote}>列表和当前值来自 DSH Session；修改会写入同一条会话日志。</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
