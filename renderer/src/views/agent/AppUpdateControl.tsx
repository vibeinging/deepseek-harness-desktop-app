import { useEffect, useMemo, useState } from 'react'
import { IconAlertCircle, IconDownload, IconRefresh } from '@tabler/icons-react'
import { Popover, Progress } from '@mantine/core'
import styles from './AppUpdateControl.module.scss'

type ReleaseNotes = {
  id: string
  version: string
  released_at: string
  notes: {
    features: string[]
    improvements: string[]
    fixes: string[]
  }
}

type UpdateState = {
  enabled: boolean
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'installing' | 'error'
  currentVersion: string
  latest?: (ReleaseNotes & {
    update_available: boolean
    mandatory: boolean
    min_supported_version?: string
  }) | null
  progress?: { percent?: number; transferred?: number; total?: number } | null
  error?: string | null
}

type DesktopUpdateApi = {
  appUpdateGetState?: () => Promise<UpdateState>
  appUpdateCheck?: () => Promise<UpdateState>
  appUpdateDownloadAndInstall?: () => Promise<UpdateState>
  onAppUpdateState?: (listener: (state: UpdateState) => void) => (() => void)
}

const bytes = (value?: number) => {
  if (!value || value < 1) return ''
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

const releasedDate = (raw?: string) => {
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

export default function AppUpdateControl() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [opened, setOpened] = useState(false)
	const api = useMemo(() => (((window as any).electronAPI || {}) as DesktopUpdateApi), [])

  useEffect(() => {
    let active = true
    void api.appUpdateGetState?.().then((next) => { if (active && next) setState(next) })
    const dispose = api.onAppUpdateState?.((next) => { if (active) setState(next) })
    return () => {
      active = false
      dispose?.()
    }
	}, [api])

  const percent = Math.round(state?.progress?.percent || 0)
  const busy = state?.status === 'downloading' || state?.status === 'downloaded' || state?.status === 'installing'
  const visible = Boolean(
    state?.enabled && state.latest && (
      state.latest.update_available || busy || state.status === 'error'
    )
  )
  const buttonLabel = useMemo(() => {
    if (state?.status === 'downloading') return `下载 ${percent}%`
    if (state?.status === 'downloaded' || state?.status === 'installing') return '正在重启'
    return '更新'
  }, [percent, state?.status])

  if (!visible || !state?.latest) return null
  const latest = state.latest

  const startDownload = () => {
    setOpened(true)
    if (state.status === 'available' || state.status === 'error') {
      void api.appUpdateDownloadAndInstall?.().then((next) => { if (next) setState(next) })
    }
  }
  const retryCheck = () => {
    void api.appUpdateCheck?.().then((next) => { if (next) setState(next) })
  }

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" offset={9} withinPortal shadow="md">
      <Popover.Target>
        <button
          type="button"
          className={styles.trigger}
          data-busy={busy ? 'true' : undefined}
          aria-label={`升级到 ${latest.version}`}
          onClick={startDownload}
        >
          {busy ? <IconDownload size={14} stroke={2} /> : <IconRefresh size={14} stroke={2} />}
          <span>{buttonLabel}</span>
        </button>
      </Popover.Target>
      <Popover.Dropdown className={styles.popover} data-app-update-popover>
        <div className={styles.heading}>
          <div>
            <strong>v{latest.version} 更新日志</strong>
            <div>{releasedDate(latest.released_at)}</div>
          </div>
          {latest.mandatory && <span className={styles.required}>需要升级</span>}
        </div>

        {state.status === 'downloading' && (
          <div className={styles.downloadProgress} aria-live="polite">
            <div><span>正在下载安装包</span><strong>{percent}%</strong></div>
            <Progress value={percent} size="sm" color="green" radius="xl" />
            {state.progress?.total ? <small>{bytes(state.progress.transferred)} / {bytes(state.progress.total)}</small> : null}
          </div>
        )}
        {(state.status === 'downloaded' || state.status === 'installing') && (
          <div className={styles.installing} aria-live="polite">下载完成，正在关闭本地服务并重启应用…</div>
        )}
        {state.status === 'error' && (
          <div className={styles.error} role="alert">
            <IconAlertCircle size={16} />
            <span>{state.error || '更新失败，请稍后重试'}</span>
            <button type="button" onClick={retryCheck}>重试</button>
          </div>
        )}

        <ReleaseSection title="新功能" items={latest.notes.features} />
        <ReleaseSection title="改进" items={latest.notes.improvements} />
        <ReleaseSection title="问题修复" items={latest.notes.fixes} />
        <div className={styles.footer}>下载完成后会自动重启；项目、对话、插件和设置会继续保留。</div>
      </Popover.Dropdown>
    </Popover>
  )
}

function ReleaseSection({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <section className={styles.section}>
      <h3>{title}</h3>
      <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
    </section>
  )
}
