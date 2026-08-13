// Composer "+" actions: attach local files/folders, reference a project file, or
// reference another conversation.
import { useEffect, useRef, useState } from 'react'
import { IconFile, IconHash, IconPaperclip, IconPlus } from '@tabler/icons-react'
import { basename, isDesktop, pickFilesOrFolders } from './folders'
import MentionPicker, { type PickItem, type PickMode } from './MentionPicker'
import styles from './agent.module.scss'

export interface ArtifactSelectionMetadata {
  format: string
  anchor: string
  label: string
  page?: number
  sheet?: string
  address?: string
  rect?: { x: number; y: number; width: number; height: number }
  objectId?: string
  kind?: string
}

export interface Attachment {
  path: string
  name: string
  isDir?: boolean
  mimeType?: string
  size?: number
  width?: number
  height?: number
  dshAttachment?: {
    appSessionId: string
    attachmentId: string
  }
  artifactId?: string
  artifactVersionId?: string
  artifactVersionNumber?: number
  /** Exact regions selected in a managed artifact. */
  artifactSelections?: ArtifactSelectionMetadata[]
  /** Legacy single-selection field kept while older drafts/messages are migrated. */
  artifactSelection?: ArtifactSelectionMetadata
}

interface Props {
  projectId: string
  sessionId?: string | null
  conversations?: { id: string; title: string }[]
  disabled?: boolean
  onAddAttachments: (files: Attachment[]) => void
  /** Insert text at cursor when an @ mention or # conversation item is chosen. */
  onInsert: (text: string) => void
}

type Action = 'attach' | PickMode
const MENU: { action: Action; icon: typeof IconPlus; label: string }[] = [
  { action: 'attach', icon: IconPaperclip, label: '添加文件 / 文件夹' },
  { action: 'file', icon: IconFile, label: '引用项目文件' },
  { action: 'conv', icon: IconHash, label: '插入 # 会话' }
]

export default function ComposerActions({
  projectId,
  sessionId,
  conversations = [],
  disabled,
  onAddAttachments,
  onInsert
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [picker, setPicker] = useState<PickMode | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const closeAll = () => {
    setMenuOpen(false)
    setPicker(null)
  }

  useEffect(() => {
    if (!menuOpen && !picker) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeAll()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen, picker])

  // Add file/folder action: selected items are attachments, not project source folders.
  const addAttachment = async () => {
    closeAll()
    if (!isDesktop()) {
      // No native picker in browser mode, so fall back to @ file chooser.
      setPicker('file')
      return
    }
    const picked = await pickFilesOrFolders()
    if (picked.length)
      onAddAttachments(picked.map((p) => ({ path: p.path, name: basename(p.path), isDir: p.isDir })))
  }

  const onMenu = (action: Action) => {
    setMenuOpen(false)
    if (action === 'attach') addAttachment()
    else setPicker(action)
  }

  const handlePick = (it: PickItem) => {
    // Files become @path, conversations become #title
    onInsert(picker === 'file' ? `@${it.value} ` : `#${it.value} `)
    setPicker(null)
  }

  return (
    <div className={styles.caWrap} ref={ref}>
      <button
        type="button"
        className={styles.caPlus}
        disabled={disabled}
        onClick={() => {
          setPicker(null)
          setMenuOpen((o) => !o)
        }}
        title="添加文件 / 引用"
      >
        <IconPlus size={18} stroke={2} className={menuOpen ? styles.caPlusOpen : undefined} />
      </button>

      {menuOpen && (
        <div className={styles.caMenu}>
          {MENU.map((m) => {
            const Icon = m.icon
            return (
              <button key={m.action} type="button" className={styles.caMenuItem} onClick={() => onMenu(m.action)}>
                <Icon size={16} stroke={1.7} className={styles.caMenuIcon} />
                <span>{m.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {picker && (
        <MentionPicker
          mode={picker}
          projectId={projectId}
          sessionId={sessionId}
          conversations={conversations}
          onPick={handlePick}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
