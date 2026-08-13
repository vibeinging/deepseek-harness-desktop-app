import { useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { IconCopy, IconDownload, IconFile, IconFolderOpen } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { copyToClipboard } from '@/utils/clipboard'
import ContextMenu, { type MenuItem } from '../ContextMenu'

export type ArtifactAction = 'open' | 'reveal' | 'copy' | 'download'

export type ArtifactActionTarget = {
  kind: string
  path: string
  dataUrl: string
  copyText: string
  actions: ArtifactAction[]
}

type BlockLike = {
  type?: string
  content?: string
  metadata?: Record<string, any>
}

const ACTION_ORDER: ArtifactAction[] = ['open', 'reveal', 'copy', 'download']
const ACTION_SET = new Set<ArtifactAction>(ACTION_ORDER)

function localPath(value: unknown) {
  const raw = String(value || '').trim()
  if (raw.startsWith('file://')) {
    try { return decodeURIComponent(raw.slice('file://'.length)) } catch { return '' }
  }
  return raw.startsWith('/') || /^[a-z]:[\\/]/i.test(raw) ? raw : ''
}

function legacyActions(target: Omit<ArtifactActionTarget, 'actions'>, materialization: string) {
  if (materialization === 'client-download') return ['download'] as ArtifactAction[]
  const actions: ArtifactAction[] = []
  if (target.path && target.kind !== 'image') actions.push('open')
  if (target.path) actions.push('reveal')
  if (target.kind === 'image' ? Boolean(target.path || target.dataUrl) : Boolean(target.copyText)) actions.push('copy')
  return actions
}

export function artifactActionTarget(block: BlockLike, options: Partial<Omit<ArtifactActionTarget, 'actions'>> & {
  materialization?: string
} = {}): ArtifactActionTarget {
  const delivery = block.metadata?.output_delivery
  const outputArtifact = block.metadata?.output_artifact
  const kind = String(options.kind || delivery?.kind || outputArtifact?.type || block.type || 'file').trim().toLowerCase()
  const path = [options.path, block.metadata?.saved_path, delivery?.path, outputArtifact?.path]
    .map(localPath)
    .find(Boolean) || ''
  const dataUrl = String(options.dataUrl || '').startsWith('data:image/') ? String(options.dataUrl) : ''
  const copyText = String(options.copyText || '')
  const base = { kind, path, dataUrl, copyText }
  const declared = delivery?.actions ?? outputArtifact?.actions ?? block.metadata?.artifact_actions
  const actions = Array.isArray(declared)
    ? ACTION_ORDER.filter((action) => declared.map((value: unknown) => String(value || '').trim().toLowerCase()).includes(action) && ACTION_SET.has(action))
    : legacyActions(base, String(options.materialization || outputArtifact?.materialization || ''))
  return { ...base, actions }
}

type ExtraActions = Partial<Record<ArtifactAction, () => Promise<boolean | void> | boolean | void>>

const ACTION_LABELS: Record<ArtifactAction, string> = {
  open: '打开',
  reveal: '在 Finder 中显示',
  copy: '复制',
  download: '下载'
}

function actionIcon(action: ArtifactAction) {
  if (action === 'copy') return <IconCopy size={15} stroke={1.7} />
  if (action === 'download') return <IconDownload size={15} stroke={1.7} />
  if (action === 'reveal') return <IconFolderOpen size={15} stroke={1.7} />
  return <IconFile size={15} stroke={1.7} />
}

function actionLabel(target: ArtifactActionTarget, action: ArtifactAction) {
  if (action === 'copy' && target.kind === 'image') return '复制图片'
  if (action === 'copy' && ['table', 'chart', 'json'].includes(target.kind)) return '复制数据'
  if (action === 'download' && target.kind === 'pdf') return '下载 PDF'
  return ACTION_LABELS[action]
}

export async function executeArtifactAction(
  target: ArtifactActionTarget,
  action: ArtifactAction,
  extraActions: ExtraActions = {}
) {
  try {
    let ok = false
    if (extraActions[action]) {
      ok = (await extraActions[action]?.()) !== false
    } else if (action === 'copy' && target.kind !== 'image') {
      ok = Boolean(target.copyText) && await copyToClipboard(target.copyText)
    } else if (action !== 'download') {
      const runNative = (window as any)?.electronAPI?.runArtifactAction
      ok = typeof runNative === 'function' && await runNative({
        action,
        path: target.path || undefined,
        dataUrl: target.dataUrl || undefined,
        kind: target.kind
      }) === true
    }

    if (!ok) {
      notifications.show({ color: 'red', message: `${actionLabel(target, action)}失败` })
    } else if (action === 'copy') {
      notifications.show({ color: 'green', message: target.kind === 'image' ? '图片已复制' : '数据已复制' })
    }
    return ok
  } catch {
    notifications.show({ color: 'red', message: `${actionLabel(target, action)}失败` })
    return false
  }
}

export function ArtifactActionSurface({
  as: Element = 'section',
  target,
  extraActions = {},
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  as?: 'section' | 'figure' | 'div'
  target: ArtifactActionTarget
  extraActions?: ExtraActions
  children: ReactNode
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const showNativeMenu = (window as any)?.electronAPI?.showArtifactContextMenu
  const menuItems: MenuItem[] = target.actions.map((action) => ({
    key: action,
    icon: actionIcon(action),
    label: actionLabel(target, action),
    onClick: () => { void executeArtifactAction(target, action, extraActions) }
  }))
  const hasNativeMenu = Boolean(target.path) && typeof showNativeMenu === 'function'
  const hasMenu = hasNativeMenu || menuItems.length > 0
  const openMenu = (x: number, y: number) => {
    if (!hasNativeMenu) {
      setMenu({ x, y })
      return
    }
    void showNativeMenu({ path: target.path, kind: target.kind, x, y })
      .then((shown: boolean) => {
        if (!shown && menuItems.length) setMenu({ x, y })
      })
      .catch(() => {
        if (menuItems.length) setMenu({ x, y })
      })
  }

  return (
    <Element
      {...props}
      ref={surfaceRef as any}
      tabIndex={hasMenu ? 0 : props.tabIndex}
      title={hasMenu ? '右键打开产物操作' : props.title}
      data-native-artifact-context={hasNativeMenu ? 'true' : undefined}
      onContextMenu={(event) => {
        props.onContextMenu?.(event)
        if (!hasMenu || event.defaultPrevented) return
        event.preventDefault()
        openMenu(event.clientX, event.clientY)
      }}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (!hasMenu || event.defaultPrevented || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        openMenu(rect.left + 16, rect.top + 16)
      }}
    >
      {children}
      {menu && menuItems.length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => {
            setMenu(null)
            window.requestAnimationFrame(() => surfaceRef.current?.focus())
          }}
        />
      )}
    </Element>
  )
}
