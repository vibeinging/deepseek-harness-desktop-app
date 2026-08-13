// Project selector at top of the composer. Local folders are resources inside a project,
// never standalone project identities.
import { useEffect, useRef, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconFolderPlus,
  IconMessage,
  IconPlus,
  IconSearch
} from '@tabler/icons-react'
import type { Workspace } from './AgentNav'
import styles from './agent.module.scss'

interface Props {
  workspaces: Workspace[] // Includes app chat and real projects only.
  activeWs: string
  onSelect: (id: string) => void
  onOpenFolder: () => void
  /** Create a project and switch to it when done. */
  onCreateProject?: (name: string) => Promise<void> | void
}

export default function WorkspacePicker({ workspaces, activeWs, onSelect, onOpenFolder, onCreateProject }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // Inline project creation: clicking this button turns the footer into a name input.
  const [creating, setCreating] = useState(false)
  const [pname, setPname] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = workspaces.find((w) => w.id === activeWs)
  const filtered = workspaces.filter((w) => w.name.toLowerCase().includes(q.trim().toLowerCase()))

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Reset "create project" inline state when panel closes.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setPname('')
    }
  }, [open])

  const submitCreate = async () => {
    const name = pname.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      await onCreateProject?.(name)
      setPname('')
      setCreating(false)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const activeIsChat = active?.id === '__chat__'

  return (
    <div className={styles.wsPick} ref={ref}>
      <button type="button" className={styles.wsPickBtn} onClick={() => setOpen((o) => !o)}>
        {activeIsChat ? <IconMessage size={14} stroke={1.7} /> : <IconFolder size={14} stroke={1.7} />}
        <span className={styles.wsPickName}>{active?.name || '选择项目'}</span>
        <IconChevronDown size={13} className={open ? styles.wsPickCaretOpen : styles.wsPickCaret} />
      </button>

      {open && (
        <div className={styles.wsPickPanel}>
          <div className={styles.wsPickSearch}>
            <IconSearch size={14} stroke={1.7} />
            <input
              autoFocus
              className={styles.wsPickInput}
              placeholder="搜索项目"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className={styles.wsPickList}>
            {filtered.length === 0 ? (
              <div className={styles.wsPickEmpty}>没有匹配的项目</div>
            ) : (
              filtered.map((w) => {
                const isChat = w.id === '__chat__'
                return (
                  <button
                    key={w.id}
                    type="button"
                    className={`${styles.wsPickItem} ${w.id === activeWs ? styles.wsPickItemActive : ''}`}
                    onClick={() => {
                      onSelect(w.id)
                      setOpen(false)
                    }}
                    title={isChat ? '不使用项目' : w.name}
                  >
                    {isChat ? (
                      <IconMessage size={15} stroke={1.6} className={styles.wsPickItemIcon} />
                    ) : (
                      <IconFolder size={15} stroke={1.6} className={styles.wsPickItemIcon} />
                    )}
                    <span className={styles.wsPickItemName}>{w.name}</span>
                    {isChat && <span className={styles.wsPickItemHint}>不使用项目</span>}
                    {w.id === activeWs && <IconCheck size={14} stroke={2} className={styles.wsPickCheck} />}
                  </button>
                )
              })
            )}
          </div>

          <div className={styles.wsPickDivider} />
          <div className={styles.wsPickCreateGroup} role="group" aria-label="创建或扩展项目">
            <div className={styles.wsPickGroupTitle}>项目</div>
            <button
              type="button"
              className={styles.wsPickFoot}
              onClick={() => {
                onOpenFolder()
                setOpen(false)
              }}
            >
              <IconFolderPlus size={15} stroke={1.6} />
              <span>{activeIsChat ? '从文件夹创建项目…' : '添加文件夹到当前项目…'}</span>
            </button>
            {creating ? (
              <div className={styles.wsPickCreate}>
                <IconPlus size={15} stroke={1.6} />
                <input
                  autoFocus
                  className={styles.wsPickInput}
                  placeholder="项目名称，回车创建"
                  value={pname}
                  disabled={saving}
                  onChange={(e) => setPname(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitCreate()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setCreating(false)
                      setPname('')
                    }
                  }}
                />
              </div>
            ) : (
              <button type="button" className={styles.wsPickFoot} onClick={() => setCreating(true)}>
                <IconPlus size={15} stroke={1.6} />
                <span>创建项目…</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
