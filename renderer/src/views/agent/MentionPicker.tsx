// Picker above the composer: @ references a project file and # references a conversation.
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconFile, IconMessage, IconSearch } from '@tabler/icons-react'
import { listAgentFiles, type AgentFileRoot, type FileNode } from '@/api/agent'
import styles from './agent.module.scss'

export type PickMode = 'file' | 'conv'

export interface PickItem {
  value: string
  label: string
  hint?: string
  description?: string
}

function joinLocalPath(root: string, rel: string) {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`
}

function flattenFiles(roots: AgentFileRoot[]): PickItem[] {
  const out: PickItem[] = []
  const walk = (root: AgentFileRoot, nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.type === 'dir') walk(root, node.children || [])
      else out.push({
        value: joinLocalPath(root.path, node.path),
        label: node.name,
        hint: `${root.name}/${node.path}`
      })
    }
  }
  for (const root of roots || []) walk(root, root.tree || [])
  return out
}

interface Props {
  mode: PickMode
  projectId: string
  sessionId?: string | null
  conversations?: { id: string; title: string }[]
  query?: string
  onPick: (item: PickItem) => void
  onClose: () => void
}

const TITLE: Record<PickMode, string> = { file: '项目文件', conv: '会话' }
const PLACEHOLDER: Record<PickMode, string> = { file: '搜索项目文件', conv: '搜索会话' }

export default function MentionPicker({
  mode,
  projectId,
  sessionId,
  conversations = [],
  query,
  onPick,
  onClose
}: Props) {
  const [files, setFiles] = useState<PickItem[]>([])
  const [filesLoading, setFilesLoading] = useState(mode === 'file')
  const [localQ, setLocalQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inline = query !== undefined
  const q = (inline ? query : localQ) || ''

  useEffect(() => {
    if (mode !== 'file') return
    let alive = true
    setFilesLoading(true)
    listAgentFiles(projectId, sessionId)
      .then((response: any) => {
        if (alive) setFiles(flattenFiles(response?.data?.roots || []))
      })
      .catch(() => alive && setFiles([]))
      .finally(() => alive && setFilesLoading(false))
    return () => { alive = false }
  }, [mode, projectId, sessionId])

  useEffect(() => {
    if (inline) return
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => document.removeEventListener('mousedown', onDocumentMouseDown)
  }, [inline, onClose])

  const items = useMemo<PickItem[]>(() => {
    const base: PickItem[] = mode === 'file'
      ? files
      : conversations.map((conversation) => ({
          value: conversation.title || '新对话',
          label: conversation.title || '新对话',
          hint: '会话'
        }))
    const keyword = q.trim().toLowerCase()
    if (!keyword) return base
    return base.filter((item) => (
      `${item.label} ${item.description || ''} ${item.hint || ''}`.toLowerCase().includes(keyword)
    ))
  }, [conversations, files, mode, q])

  const Icon = mode === 'file' ? IconFile : IconMessage
  const emptyText = mode === 'file' ? '项目还没有文件' : '还没有会话'

  return (
    <div className={styles.mentionPanel} ref={ref} data-mention-picker={mode}>
      {!inline && (
        <div className={styles.wsPickSearch}>
          <IconSearch size={14} stroke={1.7} />
          <input
            autoFocus
            className={styles.wsPickInput}
            placeholder={PLACEHOLDER[mode]}
            value={localQ}
            onChange={(event) => setLocalQ(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Escape' && onClose()}
          />
        </div>
      )}
      <div className={styles.mentionHd}>{TITLE[mode]}</div>
      <div className={styles.wsPickList}>
        {filesLoading ? (
          <div className={styles.wsPickEmpty}>加载中…</div>
        ) : items.length === 0 ? (
          <div className={styles.wsPickEmpty}>{emptyText}</div>
        ) : items.slice(0, 60).map((item, index) => (
          <button
            key={`${item.value}-${index}`}
            type="button"
            className={styles.wsPickItem}
            onClick={() => onPick(item)}
            title={item.description || item.hint || item.label}
          >
            <Icon size={15} stroke={1.6} className={styles.wsPickItemIcon} />
            <span className={styles.wsPickItemBody}>
              <span className={styles.wsPickItemName}>{item.label}</span>
              {item.description && <span className={styles.wsPickItemDescription}>{item.description}</span>}
            </span>
            {item.hint && item.hint !== item.label && (
              <span className={styles.wsPickItemMeta}>{item.hint}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
