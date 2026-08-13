// Agent left rail: New conversation, pinned section, workspace tree (workspace/folder with child conversations), and settings entry.
// Workspace and conversation rows support context menu actions (pin / rename / remove); pinned items are grouped at the top.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertCircle,
  IconArchive,
  IconChevronRight,
  IconCircleCheckFilled,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconLoader2,
  IconMessage,
  IconMessageOff,
  IconMessageQuestion,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPlayerStop,
  IconPlus,
  IconRestore,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
  IconTrash
} from '@tabler/icons-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { conversationStatusBadge, type ConversationStatusKind } from './conversationStatusModel'
import { isPinned, loadPins, savePins, togglePin, type Pins } from './pins'
import { applyWsOrder, loadWsOrder, saveWsOrder } from './wsOrder'
import styles from './agent.module.scss'
import { DshLogo } from '@/components/DshLogo'
import { useAppName } from '@/store/brand'

export interface Workspace {
  id: string
  name: string
  description?: string | null
  conversation_count?: number
  unread_count?: number
  data_source_count?: number
  source_folders?: { id?: string; path: string; name?: string; available?: boolean }[]
}

export interface AgentNavConversation {
  id: string
  title: string
  latest_run_id?: string | null
  latest_run_status?: string | null
  latest_run_viewed_at?: string | null
  live_interaction_status?: string | null
}

function ConversationStatusIcon({ kind }: { kind: ConversationStatusKind }) {
  if (kind === 'needs_confirmation') return <IconShieldCheck size={14} stroke={2} aria-hidden="true" />
  if (kind === 'needs_reply') return <IconMessageQuestion size={14} stroke={2} aria-hidden="true" />
  if (kind === 'ready') return <IconCircleCheckFilled size={14} aria-hidden="true" />
  if (kind === 'failed') return <IconAlertCircle size={14} stroke={2.2} aria-hidden="true" />
  if (kind === 'stopped') return <IconPlayerStop size={14} stroke={2} aria-hidden="true" />
  return <IconLoader2 size={14} stroke={2} aria-hidden="true" />
}

function NavMarqueeText({
  text,
  actionOverlayWidth,
  className
}: {
  text: string
  actionOverlayWidth: number
  className: string
}) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [travel, setTravel] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current
      const text = textRef.current
      if (!viewport || !text) return
      const visibleWidth = Math.max(0, viewport.clientWidth - actionOverlayWidth)
      setTravel(Math.max(0, Math.ceil(text.scrollWidth - visibleWidth)))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }

    const observer = new ResizeObserver(measure)
    if (viewportRef.current) observer.observe(viewportRef.current)
    if (textRef.current) observer.observe(textRef.current)
    return () => observer.disconnect()
  }, [actionOverlayWidth, text])

  const duration = Math.min(9, Math.max(3.2, travel / 28 + 2.4))
  return (
    <span
      ref={viewportRef}
      className={`${className} ${travel > 0 ? styles.navMarqueeOverflow : ''}`}
    >
      <span
        ref={textRef}
        className={styles.navMarqueeText}
        style={{
          '--ws-marquee-distance': `${travel}px`,
          '--ws-marquee-duration': `${duration}s`
        } as React.CSSProperties}
      >
        {text}
      </span>
    </span>
  )
}

// Wrapper for one sortable workspace row: pass @dnd-kit ref/style/drag handle to caller with render-prop.
// Reuses existing DOM structure and avoids calling hooks inside map.
function SortableWs({
  id,
  children
}: {
  id: string
  children: (p: {
    setNodeRef: (el: HTMLElement | null) => void
    style: React.CSSProperties
    isDragging: boolean
    handleProps: Record<string, unknown>
  }) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  return <>{children({ setNodeRef, style, isDragging, handleProps: { ...attributes, ...listeners } })}</>
}

export interface AgentNavProps {
  workspaces?: Workspace[]
  convByWs?: Record<string, AgentNavConversation[]>
  archivedConvByWs?: Record<string, AgentNavConversation[]>
  activeWs?: string
  activeId?: string
  runningWorkspaceId?: string | null
  runningConversationId?: string | null
  onNewConv?: (wsId: string) => void
  onNewTemporary?: () => void
  onSelectConv?: (wsId: string, convId: string) => void
  onRenameConv?: (wsId: string, convId: string, title: string) => void
  onArchiveConv?: (wsId: string, convId: string) => void
  onRestoreConv?: (wsId: string, convId: string) => void
  onMoveConv?: (wsId: string, convId: string, title: string, status: 'active' | 'archived') => void
  onRemoveConv?: (wsId: string, convId: string) => void
  onRemoveWorkspace?: (wsId: string) => void
  onShowInFinder?: (wsId: string) => void
  /** Open a specific project's settings page (only available for project workspaces). */
  onConfigureWorkspace?: (wsId: string) => void
  onOpenSettings?: () => void
  onOpenSearch?: () => void
  onOpenPlugins?: () => void
  pluginsActive?: boolean
  temporaryActive?: boolean
}

const wsKind = (id: string) => (id === '__chat__' ? 'chat' : 'project')

export default function AgentNav({
  workspaces = [],
  convByWs = {},
  archivedConvByWs = {},
  activeWs,
  activeId,
  runningWorkspaceId = null,
  runningConversationId = null,
  onNewConv,
  onNewTemporary,
  onSelectConv,
  onRenameConv,
  onArchiveConv,
  onRestoreConv,
  onMoveConv,
  onRemoveConv,
  onRemoveWorkspace,
  onShowInFinder,
  onConfigureWorkspace,
  onOpenSettings,
  onOpenSearch,
  onOpenPlugins,
  pluginsActive = false,
  temporaryActive = false
}: AgentNavProps) {
  const appName = useAppName()
  // Expanded state: current workspace opens by default.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false)
  useEffect(() => {
    if (activeWs) setExpanded((e) => (e[activeWs] ? e : { ...e, [activeWs]: true }))
  }, [activeWs])
  const isOpen = (id: string) => expanded[id] ?? id === activeWs
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !isOpen(id) }))

  // Pinning, context menu, and inline rename.
  const [pins, setPins] = useState<Pins>(loadPins)
  const applyPins = (p: Pins) => {
    setPins(p)
    savePins(p)
  }
  const [ctx, setCtx] = useState<{ x: number; y: number; targetKey: string; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<{ wsId: string; convId: string } | null>(null)
  const [draft, setDraft] = useState('')

  // Project drag sort (@dnd-kit). Global chats are shown separately and are not draggable.
  const [wsOrder, setWsOrder] = useState<string[]>(loadWsOrder)
  const orderedWs = useMemo(() => applyWsOrder(workspaces, wsOrder), [workspaces, wsOrder])
  const sortableIds = useMemo(
    () => orderedWs.filter((w) => wsKind(w.id) !== 'chat').map((w) => w.id),
    [orderedWs]
  )
  // Distance activation: drag starts only after 5px move so click actions (expand/collapse, settings gear, plus) still work.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const onWsDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = sortableIds.indexOf(String(active.id))
    const newIndex = sortableIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(sortableIds, oldIndex, newIndex)
    setWsOrder(next)
    saveWsOrder(next)
  }

  // Index all conversations: convId -> { wsId, title } (used by pinned section name resolution).
  const convIndex = useMemo(() => {
    const m: Record<string, { wsId: string; conversation: AgentNavConversation }> = {}
    for (const ws of workspaces) {
      for (const c of convByWs[ws.id] || []) m[c.id] = { wsId: ws.id, conversation: c }
      for (const c of archivedConvByWs[ws.id] || []) m[c.id] = { wsId: ws.id, conversation: c }
    }
    return m
  }, [workspaces, convByWs, archivedConvByWs])

  const startRename = (wsId: string, convId: string, cur: string) => {
    setExpanded((e) => ({ ...e, [wsId]: true }))
    setRenaming({ wsId, convId })
    setDraft(cur)
  }
  const commitRename = () => {
    if (renaming && draft.trim()) onRenameConv?.(renaming.wsId, renaming.convId, draft)
    setRenaming(null)
  }

  const contextMenuPoint = (e: React.MouseEvent, fromTrigger: boolean) => {
    if (!fromTrigger) return { x: e.clientX, y: e.clientY }
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: rect.left - 4, y: rect.bottom + 4 }
  }

  const workspaceMenuItems = (ws: Workspace): MenuItem[] => {
    const pinned = isPinned(pins, 'ws', ws.id)
    const kind = wsKind(ws.id)
    const removable = kind !== 'chat'
    const isProject = kind === 'project'
    return [
      {
        key: 'pin',
        icon: pinned ? <IconPinnedOff size={16} stroke={1.7} /> : <IconPin size={16} stroke={1.7} />,
        label: pinned ? '取消置顶' : '置顶项目',
        onClick: () => applyPins(togglePin(pins, 'ws', ws.id))
      },
      ...(isProject
        ? [
            {
              key: 'configure',
              icon: <IconSettings size={16} stroke={1.7} />,
              label: '项目设置',
              ariaLabel: `打开${ws.name}的项目设置`,
              onClick: () => onConfigureWorkspace?.(ws.id)
            } as MenuItem
          ]
        : []),
      {
        key: 'finder',
        icon: <IconFolderOpen size={16} stroke={1.7} />,
        label: '在 Finder 中显示',
        disabled: wsKind(ws.id) === 'chat',
        onClick: () => onShowInFinder?.(ws.id)
      },
      {
        key: 'remove',
        icon: <IconTrash size={16} stroke={1.7} />,
        label: isProject ? '删除项目' : '移除',
        danger: true,
        dividerBefore: true,
        disabled: !removable,
        onClick: () => onRemoveWorkspace?.(ws.id)
      }
    ]
  }

  const openWsMenu = (e: React.MouseEvent, ws: Workspace, fromTrigger = false) => {
    e.preventDefault()
    e.stopPropagation()
    const point = contextMenuPoint(e, fromTrigger)
    setCtx({
      ...point,
      targetKey: `workspace:${ws.id}`,
      items: workspaceMenuItems(ws)
    })
  }

  const conversationMenuItems = (wsId: string, c: AgentNavConversation, archived: boolean): MenuItem[] => {
    const pinned = isPinned(pins, 'conv', c.id)
    return [
      ...(archived
        ? []
        : [
            {
              key: 'pin',
              icon: pinned ? <IconPinnedOff size={16} stroke={1.7} /> : <IconPin size={16} stroke={1.7} />,
              label: pinned ? '取消置顶' : '置顶对话',
              onClick: () => applyPins(togglePin(pins, 'conv', c.id))
            } as MenuItem
          ]),
      {
        key: 'rename',
        icon: <IconPencil size={16} stroke={1.7} />,
        label: '重命名',
        onClick: () => startRename(wsId, c.id, c.title)
      },
      {
        key: 'move',
        icon: <IconFolderOpen size={16} stroke={1.7} />,
        label: '移到项目…',
        disabled: !workspaces.some((workspace) => wsKind(workspace.id) === 'project' && workspace.id !== wsId),
        onClick: () => onMoveConv?.(wsId, c.id, c.title, archived ? 'archived' : 'active')
      },
      archived
        ? {
            key: 'restore',
            icon: <IconRestore size={16} stroke={1.7} />,
            label: '恢复对话',
            dividerBefore: true,
            onClick: () => onRestoreConv?.(wsId, c.id)
          }
        : {
            key: 'archive',
            icon: <IconArchive size={16} stroke={1.7} />,
            label: '归档',
            dividerBefore: true,
            onClick: () => onArchiveConv?.(wsId, c.id)
          },
      {
        key: 'remove',
        icon: <IconTrash size={16} stroke={1.7} />,
        label: '移除',
        danger: true,
        onClick: () => onRemoveConv?.(wsId, c.id)
      }
    ]
  }

  const openConvMenu = (
    e: React.MouseEvent,
    wsId: string,
    c: AgentNavConversation,
    archived = false,
    fromTrigger = false
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const point = contextMenuPoint(e, fromTrigger)
    setCtx({
      ...point,
      targetKey: `conversation:${wsId}:${c.id}:${archived ? 'archived' : 'active'}`,
      items: conversationMenuItems(wsId, c, archived)
    })
  }

  // Shared conversation row renderer for tree and pinned section; rename input is rendered here only.
  const convRow = (wsId: string, c: AgentNavConversation, keyPrefix = '', archived = false) => {
    const editing = renaming?.convId === c.id
    const title = c.title || '新对话'
    const menuTargetKey = `conversation:${wsId}:${c.id}:${archived ? 'archived' : 'active'}`
    const menuOpen = ctx?.targetKey === menuTargetKey
    const statusBadge = conversationStatusBadge({
      latestRunStatus: c.latest_run_status,
      latestRunViewedAt: c.latest_run_viewed_at,
      liveInteractionStatus: c.live_interaction_status,
      locallyRunning: wsId === runningWorkspaceId && c.id === runningConversationId
    })
    return (
      <div
        key={keyPrefix + c.id}
        className={`${styles.convItem} ${c.id === activeId && wsId === activeWs ? styles.convItemActive : ''} ${menuOpen ? styles.convItemActionsOpen : ''}`}
        data-agent-conv-id={c.id}
        data-agent-ws-id={wsId}
        role="button"
        tabIndex={editing ? -1 : 0}
        aria-current={c.id === activeId && wsId === activeWs ? 'page' : undefined}
        aria-label={`打开对话 ${title}${statusBadge ? `，状态：${statusBadge.label}` : ''}`}
        onClick={() => !editing && onSelectConv?.(wsId, c.id)}
        onKeyDown={(event) => {
          if (editing || event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onSelectConv?.(wsId, c.id)
        }}
        onContextMenu={(e) => openConvMenu(e, wsId, c, archived)}
        title={title}
      >
        <IconMessage size={13} stroke={1.7} />
        {editing ? (
          <input
            className={styles.renameInput}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={commitRename}
          />
        ) : (
          <>
            <NavMarqueeText
              text={title}
              actionOverlayWidth={39}
              className={styles.convName}
            />
            {statusBadge && (
              <span
                className={styles.convStatus}
                data-status={statusBadge.kind}
                data-agent-conv-status={statusBadge.kind}
                data-agent-conv-status-icon
                title={statusBadge.description}
                role="img"
                aria-label={`对话状态：${statusBadge.label}`}
              >
                <ConversationStatusIcon kind={statusBadge.kind} />
              </span>
            )}
            <div className={styles.convActions}>
              <button
                type="button"
                className={styles.convAction}
                data-agent-conversation-menu-trigger
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => openConvMenu(event, wsId, c, archived, true)}
                aria-label={`更多对话操作：${title}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="更多操作"
              >
                <IconDots size={15} stroke={1.8} />
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  // Workspace row body includes collapsible header plus nested conversations; sortable wrapper passes drag handle props to header.
  const wsInner = (
    ws: Workspace,
    open: boolean,
    convs: AgentNavConversation[],
    archivedConvs: AgentNavConversation[],
    handleProps?: Record<string, unknown>
  ) => {
    return (
      <>
      <div
        className={`${styles.wsFolder} ${ws.id === activeWs ? styles.wsFolderActive : ''} ${ctx?.targetKey === `workspace:${ws.id}` ? styles.wsFolderActionsOpen : ''}`}
        data-agent-workspace-id={ws.id}
        onClick={() => toggle(ws.id)}
        onContextMenu={(e) => openWsMenu(e, ws)}
        title={ws.name}
        {...(handleProps || {})}
      >
        <IconChevronRight size={13} className={open ? styles.wsCaretOpen : styles.wsCaret} />
        <IconFolder size={15} stroke={1.7} className={styles.wsFolderIcon} />
        <NavMarqueeText
          text={ws.name}
          actionOverlayWidth={wsKind(ws.id) === 'project' ? 56 : 28}
          className={styles.wsName}
        />
        <div className={styles.wsActions}>
          {wsKind(ws.id) === 'project' && (
            <button
              type="button"
              className={styles.wsMore}
              data-agent-workspace-menu-trigger
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => openWsMenu(event, ws, true)}
              aria-label={`查看项目 ${ws.name}`}
              aria-haspopup="menu"
              aria-expanded={ctx?.targetKey === `workspace:${ws.id}`}
              title="更多操作"
            >
              <IconDots size={15} stroke={1.8} />
            </button>
          )}
          <button
            type="button"
            className={styles.wsPlus}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onNewConv?.(ws.id)
            }}
            aria-label={`在${ws.name}中新建对话`}
            title="新建对话"
          >
            <IconPlus size={14} stroke={1.9} />
          </button>
        </div>
      </div>
      {open && (
        <div className={styles.convNest}>
          {convs.length === 0 && archivedConvs.length === 0 ? (
            <div className={styles.convNestEmpty}>暂无对话</div>
          ) : (
            <>
              {convs.map((c) => convRow(ws.id, c))}
            </>
          )}
          {archivedConvs.length > 0 && (
            <>
              <div className={styles.archiveLabel}>
                <IconArchive size={12} stroke={1.7} />
                <span>归档</span>
                <span>{archivedConvs.length}</span>
              </div>
              {archivedConvs.map((c) => convRow(ws.id, c, 'archived-', true))}
            </>
          )}
        </div>
      )}
      </>
    )
  }

  const hasPins = pins.ws.length > 0 || pins.conv.length > 0
  const visibleOrderedWs = useMemo(() => {
    if (showAllWorkspaces || orderedWs.length <= 12) return orderedWs
    const alwaysVisible = new Set([activeWs, '__chat__', ...pins.ws].filter(Boolean))
    return orderedWs.filter((workspace, index) => index < 12 || alwaysVisible.has(workspace.id))
  }, [activeWs, orderedWs, pins.ws, showAllWorkspaces])

  return (
    <>
      <div className={styles.navActionList}>
        <button
          type="button"
          className={styles.navAction}
          onClick={() => onNewConv?.('__chat__')}
          title="新建对话"
        >
          <IconPlus size={16} stroke={1.9} />
          <span>新建</span>
          <kbd className={styles.navActionKbd}>⌘N</kbd>
        </button>
        <button
          type="button"
          className={`${styles.navAction} ${temporaryActive ? styles.navActionActive : ''}`}
          onClick={() => onNewTemporary?.()}
          title="临时对话不会出现在历史记录中"
          aria-current={temporaryActive ? 'page' : undefined}
          data-agent-nav="temporary-chat"
        >
          <IconMessageOff size={16} stroke={1.7} />
          <span>临时对话</span>
        </button>
        <button type="button" className={styles.navAction} onClick={() => onOpenSearch?.()} title="搜索项目或对话">
          <IconSearch size={16} stroke={1.7} />
          <span>搜索</span>
          <kbd className={styles.navActionKbd}>⌘K</kbd>
        </button>
        <button
          type="button"
          className={`${styles.navAction} ${pluginsActive ? styles.navActionActive : ''}`}
          onClick={() => onOpenPlugins?.()}
          title="插件"
          aria-current={pluginsActive ? 'page' : undefined}
          data-agent-nav="plugins"
        >
          <IconSparkles size={16} stroke={1.7} />
          <span>插件</span>
        </button>
      </div>

      {hasPins && (
        <>
          <div className={styles.secLabel}>置顶</div>
          <div className={styles.pinList}>
            {pins.ws.filter((id) => id !== '__chat__').map((id) => {
              const ws = workspaces.find((w) => w.id === id)
              if (!ws) return null
              return (
                <div
                  key={'pw' + id}
                  className={`${styles.convItem} ${id === activeWs ? styles.convItemActive : ''}`}
                  onClick={() => toggle(id)}
                  onContextMenu={(e) => openWsMenu(e, ws)}
                  title={ws.name}
                >
                  <IconFolder size={13} stroke={1.7} />
                  <span className={styles.convTitle}>{ws.name}</span>
                  <IconPin size={12} stroke={1.7} />
                </div>
              )
            })}
            {pins.conv.map((id) => {
              const info = convIndex[id]
              if (!info) return null
              return convRow(info.wsId, info.conversation, 'pc')
            })}
          </div>
        </>
      )}

      <div className={styles.secLabel}>对话</div>
      <div className={`${styles.wsTree} ${styles.chatTree}`}>
        {(convByWs.__chat__ || []).length === 0 && (archivedConvByWs.__chat__ || []).length === 0 ? (
          <div className={styles.convNestEmpty}>还没有对话。</div>
        ) : (
          <div className={styles.convNest}>
            {(convByWs.__chat__ || []).map((conversation) => convRow('__chat__', conversation, 'chat-'))}
            {(archivedConvByWs.__chat__ || []).length > 0 && (
              <>
                <div className={styles.archiveLabel}>
                  <IconArchive size={12} stroke={1.7} />
                  <span>归档</span>
                  <span>{(archivedConvByWs.__chat__ || []).length}</span>
                </div>
                {(archivedConvByWs.__chat__ || []).map((conversation) => convRow('__chat__', conversation, 'chat-archived-', true))}
              </>
            )}
          </div>
        )}
      </div>

      <div className={styles.secLabel}>项目</div>
      <div className={styles.wsTree}>
        {visibleOrderedWs.every((workspace) => wsKind(workspace.id) === 'chat') ? (
          <div className={styles.convNestEmpty}>还没有项目。</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onWsDragEnd}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {visibleOrderedWs
                .filter((ws) => wsKind(ws.id) !== 'chat')
                .map((ws) => (
                  <SortableWs key={ws.id} id={ws.id}>
                    {({ setNodeRef, style, isDragging, handleProps }) => (
                      <div
                        ref={setNodeRef}
                        style={style}
                        className={`${styles.wsGroup} ${isDragging ? styles.wsDragging : ''}`}
                      >
                        {wsInner(ws, isOpen(ws.id), convByWs[ws.id] || [], archivedConvByWs[ws.id] || [], handleProps)}
                      </div>
                    )}
                  </SortableWs>
                ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
      {sortableIds.length > 12 && (
        <button
          type="button"
          className={styles.wsShowAll}
          onClick={() => setShowAllWorkspaces((value) => !value)}
        >
          {showAllWorkspaces ? '收起项目' : `显示全部 ${sortableIds.length} 个项目`}
        </button>
      )}

      <div className={styles.railFoot}>
        <div className={styles.brand}>
          <DshLogo className={styles.brandMark} />
          <span className={styles.brandName}>{appName}</span>
        </div>
        <button type="button" className={styles.settingsBtn} onClick={() => onOpenSettings?.()} title="设置">
          <IconSettings size={17} stroke={1.7} className={styles.settingsGear} />
          <span>设置</span>
        </button>
      </div>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </>
  )
}
