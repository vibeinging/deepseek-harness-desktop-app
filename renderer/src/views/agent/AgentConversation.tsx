// Center column for the Agent conversation stream. M2: real session (create/persist/history load), self-contained minimal rendering.
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  IconArrowUp,
  IconBox,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconMessageOff,
  IconPhoto,
  IconPencil,
  IconPlayerStopFilled,
  IconTrash,
  IconWorldSearch,
  IconX
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import TurnLocator, {
  type TurnLocatorMarker
} from '@/components/TurnLocator'
import {
  branchAgentMessage,
  compactAgentSession,
  createAgentSession,
  getAgentCurrentWorkspaceDiff,
  getDshSessionProtocolState,
  getAgentMessages,
  interruptAgentTurn,
  resolveAgentPendingAction,
  resolveAgentApproval,
  resolveAgentUserInput,
  promptDshSession,
  revertAgentWorkspaceChange,
  applyAgentWorkspaceEdit,
  startAgentTurn,
  startAgentReview,
  stopAgentRun,
  setDshSessionPlanMode,
  setDshSessionPermission,
  updateDshSessionQueueItem,
  watchDshSessionProtocol
} from '@/api/agent'
import type {
  AgentMessageBranchMode,
  AgentNativePendingInteraction,
  DshPermissionSelect,
  DshQueueItem,
  DshSessionProtocolState
} from '@/api/agent'
import { getDshSkillsReq, getEnabledAppSkillsReq } from '@/api/skills'
import { getProjectSourceFoldersReq } from '@/api/project'
import { subscribeStream } from '@/utils/api-stream'
import { copyToClipboard } from '@/utils/clipboard'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import type { Artifact, PlanStep, SkillTrace, ToolCall } from '@/layout/workstation/Workstation'
import type { Workspace } from './AgentNav'
import WorkspacePicker from './WorkspacePicker'
import ComposerActions, { type Attachment } from './ComposerActions'
import PermissionPicker from './PermissionPicker'
import CollaborationModePicker from './CollaborationModePicker'
import {
  collaborationModeFromDshPlan,
  normalizeCollaborationMode,
  type CollaborationMode
} from './collaborationMode'
import {
  ChangesButton,
  ChangesReviewPanel,
  type ReviewComment,
  type TurnDiffSnapshot
} from './WorkspaceChanges'
import MentionPicker, { type PickItem, type PickMode } from './MentionPicker'
import SlashMenu, { slashMenuItems, type SlashSkill } from './SlashMenu'
import {
  basename,
  CHAT_WS,
  isDesktop,
  mergeUniquePathItems,
  registerDroppedFiles
} from './folders'
import type {
  AgentBlock as Block,
  AgentMessage as Msg,
  AgentStreamTarget,
  AgentTurnPatch,
  DataWorkspaceEvent,
  WorkstationDraft,
  WorkstationPatch
} from './stream/types'
import { mapServerMessage, mergeServerMessages, mergeWorkspaceEvent, parseSseJsonLine } from './stream/streamAdapter'
import { applyWorkstationPatch, backfillWorkstationFromMessages, reduceStreamEvent } from './stream/reducer'
import { imageSrcFromPath } from './stream/uiCapabilities'
import { foldGenerativeUiBlocks, isGenerativeUiBlock } from './generative-ui/schema'
import ConversationModelSelector, { type ConversationModelRuntime } from './ConversationModelSelector'
import { buildAgentTurnInput, isImageAttachment } from './imageInput'
import { loadConversationDraft, persistConversationDraft, stripLegacyArtifactReferencePrompt } from './conversationDraft'
import {
  LARGE_PASTE_LIMIT_BYTES,
  LARGE_PASTE_NOTICE,
  applyBlockToMessages,
  applyTurnToMessages,
  attachmentArtifactSelections,
  attachmentBlock,
  attachmentFromBranchDraft,
  formatBytes,
  insertSteerUserMessage,
  messageText,
  messageTurnId,
  normalizeAttachmentsForRequest,
  optimisticSkillSelections,
  removeBlockFromMessages,
  sendTaskNotification,
  textByteLength
} from './conversation/messageState'
import { stopTurnAfterSettlement } from './conversation/turnStop'
import { conversationRuntimeState, isReviewableConversationRunStatus } from './conversationStatusModel'
import {
  agentRoutedSkillNames,
  isPersistentProjectSkill,
  promptWithRuntimeSkills
} from './conversationSkillSelection'
import {
  AttachmentPreview,
  clipText,
  isAcceptedApprovalDecision,
  parseUserInputPayload,
  type ApprovalDecision
} from './conversation/AssistantContent'
import { AssistantTurn, UserTurn } from './conversation/ConversationTurns'
import {
  VIRTUAL_MESSAGE_OVERSCAN,
  VIRTUAL_MESSAGE_PADDING_END,
  VIRTUAL_MESSAGE_PADDING_START,
  activeVirtualMarkerId,
  estimateVirtualMessageSize,
} from './conversation/virtualMessageList'
import type { FileReferenceOpenTarget } from './conversation/types'
import { useAppName } from '@/store/brand'
import { useSkinsStore } from '@/store/skins'
import { ANIME_PROFILE_SKIN_ID } from '@/theme/skins/builtin'
import HomeWelcome from './HomeWelcome'
import { useDshClientHost } from '@/dsh-client/DshClientHost'
import styles from './agent.module.scss'

export type { DataWorkspaceEvent } from './stream/types'
export type { FileReferenceOpenTarget } from './conversation/types'

export type ConversationSkillSelection = {
  name: string
  skillName?: string
  qualifiedName?: string
  label: string
  prompt?: string
  source?: string
  scope?: string
  pluginName?: string
  executionScope?: 'project' | 'runtime'
  version?: string
  digest?: string
  toolDependencies?: string[]
  artifactTemplate?: SlashSkill['artifactTemplate']
}

interface Props {
  projectId: string
  selectedId: string | null
  latestRunId?: string | null
  latestRunStatus?: string | null
  liveInteractionStatus?: string | null
  locallyRunning?: boolean
  onRunningChange?: (running: boolean, sessionId?: string | null) => void
  onSessionCreated?: (id: string) => void
  onAfterComplete?: () => void
  onWorkstation?: (ws: { tools: ToolCall[]; artifacts: Artifact[]; plan: PlanStep[]; skills: SkillTrace[] }) => void
  /** Expose stop callback to right-side workbench (abort current request). */
  stopRef?: React.MutableRefObject<(() => void) | null>
  /** Whether conversation has content; controls whether outer layout shows right workbench (empty home has none). */
  onHasContent?: (has: boolean) => void
  /** Workspace picker above composer when creating a new conversation: all workspaces, switch, open folder. */
  workspaces?: Workspace[]
  onSelectWorkspace?: (id: string) => void
  onOpenFolder?: () => void
  showThinking?: boolean
  showTodo?: boolean
  interactionMode?: 'steer' | 'queue'
  workspaceName?: string
  conversationTitle?: string
  /** The window shell owns the shared native-size titlebar; conversation actions are portaled into its runtime slot. */
  shellHeader?: boolean
  shellHeaderActionsTarget?: HTMLElement | null
  /** Create a Q&A project workspace via WorkspacePicker entry. */
  onCreateProject?: (name: string) => Promise<void> | void
  /** Workspace event from backend product tool, e.g. project created/ready. */
  onWorkspaceEvent?: (event: DataWorkspaceEvent) => boolean | void | Promise<boolean | void>
  /** Conversations in current workspace for "# conversation" references in input. */
  conversations?: { id: string; title: string }[]
  /** Open model configuration in app settings; the model capsule uses this entry in both configured/unconfigured states. */
  onOpenModelSettings: () => void
  selectedSkills?: ConversationSkillSelection[]
  onSelectSkill?: (skill: ConversationSkillSelection) => void
  onRemoveSelectedSkill?: (name: string) => void
  onClearSelectedSkills?: () => void
  onNewConversation?: () => void
  onOpenConversation?: (conversationId: string) => void
  onOpenFileReference?: (target: FileReferenceOpenTarget) => void | Promise<void>
  requestedBrowserPage?: { prompt: string; attachments: Attachment[]; nonce: number } | null
  onRequestedBrowserPageConsumed?: (nonce: number) => void
  requestedArtifactReference?: { prompt?: string; attachments: Attachment[]; nonce: number } | null
  onRequestedArtifactReferenceConsumed?: (nonce: number) => void
  /** Temporary conversations use an ephemeral runtime thread and do not persist message history. */
  temporary?: boolean
  onExitTemporary?: () => void
}


type DispatchExtra = Record<string, unknown>
type QueueItem = DshQueueItem
type SearchMode = 'auto' | 'required' | 'off'
const IMAGE_TEMPLATE_GALLERY_KIND = 'imagegen'
const IMAGE_GENERATION_TOOL = 'image_gen'

export function mergeArtifactReferenceAttachments(current: Attachment[], incoming: Attachment[]) {
  const incomingArtifactIds = new Set(incoming.map((item) => item.artifactId).filter(Boolean))
  const incomingPaths = new Set(incoming.map((item) => item.path).filter(Boolean))
  return [
    ...current.filter((item) => !incomingPaths.has(item.path) && !(item.artifactId && incomingArtifactIds.has(item.artifactId))),
    ...incoming
  ]
}

export function artifactSelectionBadgeLabel(attachment: Attachment) {
  const selections = attachmentArtifactSelections(attachment)
  if (!selections.length) return ''
  const pages = [...new Set(selections.map((selection) => selection.page).filter(Boolean))]
  const location = pages.length === 1 ? `第 ${pages[0]} 页 · ` : pages.length > 1 ? `${pages.length} 页 · ` : ''
  return `${location}${selections.length} 个选区`
}
function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function jsonRecord(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return {}
  try { return recordValue(JSON.parse(value)) } catch { return {} }
}

function catalogToolDependencies(skill: any): string[] {
  const declared = [
    ...(Array.isArray(skill?.tool_dependencies) ? skill.tool_dependencies : []),
    ...(Array.isArray(skill?.required_tools) ? skill.required_tools : []),
    ...(Array.isArray(skill?.dependencies?.tools)
      ? skill.dependencies.tools
          .filter((item: any) => String(item?.type || '').toLowerCase() === 'host')
          .map((item: any) => item?.value)
      : [])
  ]
  return [...new Set(declared.map((item) => String(item || '').trim()).filter(Boolean))]
}

function catalogSkill(skill: any): SlashSkill | null {
  const name = String(skill?.selection_key || skill?.qualified_name || skill?.name || '').trim()
  if (!name) return null
  return {
    name,
    skillName: String(skill?.name || ''),
    qualifiedName: String(skill?.qualified_name || skill?.name || ''),
    label: String(
      skill?.interface?.display_name
      || skill?.interface?.displayName
      || skill?.display_name
      || skill?.label
      || skill?.artifact_template?.name
      || skill?.name
      || '未命名技能'
    ),
    description: String(skill?.description || skill?.artifact_template?.description || ''),
    prompt: String(skill?.interface?.default_prompt || skill?.interface?.defaultPrompt || '') || undefined,
    source: String(skill?.source || '') || undefined,
    scope: String(skill?.scope || '') || undefined,
    pluginName: String(skill?.plugin_name || '') || undefined,
    version: String(skill?.version || '') || undefined,
    digest: String(skill?.digest || '') || undefined,
    availability: String(skill?.availability || 'enabled'),
    availabilityReason: String(skill?.availability_reason || skill?.availabilityReason || '') || undefined,
    toolDependencies: catalogToolDependencies(skill),
    artifactTemplate: skill?.artifact_template || null
  }
}

function selectionFromCatalogSkill(skill: SlashSkill): ConversationSkillSelection {
  return {
    name: skill.name,
    skillName: skill.skillName,
    qualifiedName: skill.qualifiedName,
    label: skill.label,
    ...(skill.prompt ? { prompt: skill.prompt } : {}),
    ...(skill.source ? { source: skill.source } : {}),
    ...(skill.scope ? { scope: skill.scope } : {}),
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
    ...(skill.version ? { version: skill.version } : {}),
    ...(skill.digest ? { digest: skill.digest } : {}),
    ...(skill.toolDependencies?.length ? { toolDependencies: skill.toolDependencies } : {}),
    ...(skill.artifactTemplate ? { artifactTemplate: skill.artifactTemplate } : {})
  }
}

/** Adds native runtime interactions to the in-memory history without persisting them as messages. */
export function mergeNativePendingInteractions(
  messages: Msg[],
  pendingInteractions: unknown,
  targetSessionId: string
): Msg[] {
  const sessionId = String(targetSessionId || '').trim()
  if (!sessionId || !Array.isArray(pendingInteractions)) return messages

  const seenBlockIds = new Set<string>()
  const seenRequestIds = new Set<string>()
  const blocks: Block[] = []
  let suspendedThreadId = ''
  let suspendedTurnId = ''

  for (const raw of pendingInteractions) {
    const item = recordValue(raw) as Partial<AgentNativePendingInteraction>
    const resolution = recordValue(item.resolution)
    const block = recordValue(item.block)
    const requestId = String(item.request_id || '').trim()
    const runId = String(item.run_id || '').trim()
    const blockId = String(block.id || '').trim()
    const blockType = String(block.type || '')
    const threadId = String(resolution.thread_id || '').trim()
    const turnId = String(resolution.turn_id || '').trim()
    const itemId = String(resolution.item_id || '').trim()
    if (
      item.version !== 1 || item.status !== 'pending' || item.session_id !== sessionId ||
      resolution.type !== 'native_turn' || !requestId || !runId || !blockId ||
      !threadId || !turnId || !itemId || !['confirm', 'user_input'].includes(blockType) ||
      seenBlockIds.has(blockId) || seenRequestIds.has(requestId)
    ) continue

    const metadata = recordValue(block.metadata)
    let hydratedBlock: Block
    if (blockType === 'confirm') {
      hydratedBlock = {
        id: blockId,
        type: 'confirm',
        content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        title: String(block.title || 'requested'),
        metadata: {
          ...metadata,
          request_id: requestId,
          run_id: runId,
          status: metadata.status || 'requested',
          approval_request: {
            ...recordValue(metadata.approval_request),
            threadId,
            turnId,
            itemId,
            thread_id: threadId,
            turn_id: turnId,
            item_id: itemId
          }
        }
      }
    } else {
      const content = JSON.stringify({
        ...jsonRecord(block.content),
        request_id: requestId,
        run_id: runId,
        thread_id: threadId,
        turn_id: turnId,
        item_id: itemId
      })
      // Never let malformed native data fall through to the durable pending-action resolver.
      if (!parseUserInputPayload(content).native) continue
      hydratedBlock = {
        id: blockId,
        type: 'user_input',
        content,
        title: String(block.title || 'requested'),
        metadata: {
          ...metadata,
          request_id: requestId,
          run_id: runId,
          status: metadata.status || 'requested'
        }
      }
    }

    seenRequestIds.add(requestId)
    seenBlockIds.add(blockId)
    blocks.push(hydratedBlock)
    suspendedThreadId ||= threadId
    suspendedTurnId ||= turnId
  }

  if (!blocks.length) return messages
  const baseMessages = messages
    .map((message) => {
      if (message.role !== 'assistant') return message
      const messageBlocks = message.blocks.filter((block) => !seenBlockIds.has(block.id))
      const workstationBlocks = (message.workstationBlocks || []).filter((block) => !seenBlockIds.has(block.id))
      if (messageBlocks.length === message.blocks.length && workstationBlocks.length === (message.workstationBlocks || []).length) {
        return message
      }
      return {
        ...message,
        blocks: messageBlocks,
        ...(message.workstationBlocks ? { workstationBlocks } : {})
      }
    })
    .filter((message) => message.role === 'user' || message.blocks.length > 0 || (message.workstationBlocks?.length || 0) > 0)
  return [
    ...baseMessages,
    {
      id: `pending-interactions:${sessionId}`,
      role: 'assistant',
      blocks,
      threadId: suspendedThreadId,
      turnId: suspendedTurnId,
      status: 'suspended'
    }
  ]
}

export function markNativeUserInputResolved(
  messages: Msg[],
  itemId: string,
  answers: Record<string, { answers: string[] }>
): Msg[] {
  const rawId = String(itemId || '').trim()
  if (!rawId) return messages
  const blockIds = new Set([rawId, rawId.startsWith('user_input:') ? rawId : `user_input:${rawId}`])
  let changed = false
  const updateBlocks = (blocks: Block[]) => blocks.map((block) => {
    if (!blockIds.has(block.id) || block.type !== 'user_input') return block
    changed = true
    return {
      ...block,
      title: 'resolved',
      metadata: { ...recordValue(block.metadata), status: 'answered', response: answers }
    }
  })
  const next = messages.map((message) => ({
    ...message,
    blocks: updateBlocks(message.blocks),
    ...(message.workstationBlocks ? { workstationBlocks: updateBlocks(message.workstationBlocks) } : {})
  }))
  return changed ? next : messages
}

function agentMessagesPayload(response: any) {
  const data = response?.data ?? response
  return {
    messages: Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [],
    pendingInteractions: Array.isArray(data?.pending_interactions) ? data.pending_interactions : [],
    dshRecovery: data?.dsh_recovery === true
  }
}

function currentClientCapabilities() {
  const desktop = isDesktop()
  return {
    surface: desktop ? 'desktop' as const : 'browser' as const,
    projectChatMemory: true,
    globalChatMemory: true,
    renderMarkdown: true,
    renderChart: true,
    renderGenerativeUi: true,
    pageDataResult: true,
    openLocalFile: desktop,
    reviewWorkspaceDiff: true,
    mutateWorkspace: desktop,
    downloadArtifact: desktop
  }
}

function isCompletedRunEvent(event: any) {
  const type = String(event?.type || '').replace(/^dsh\//, '')
  return type === 'turn/completed' && event?.payload?.turn?.status === 'completed'
}

function isFailedRunEvent(event: any) {
  const type = String(event?.type || '').replace(/^dsh\//, '')
  return type === 'turn/completed' && ['failed', 'interrupted'].includes(event?.payload?.turn?.status)
}

function DshWorkAgentConversation({
  projectId,
  selectedId,
  latestRunId = null,
  latestRunStatus = null,
  liveInteractionStatus = null,
  locallyRunning = false,
  onRunningChange,
  onSessionCreated,
  onAfterComplete,
  onWorkstation,
  stopRef,
  onHasContent,
  workspaces = [],
  onSelectWorkspace,
  onOpenFolder,
  showThinking = true,
  showTodo = true,
  interactionMode = 'steer',
  workspaceName = 'dsh-work',
  conversationTitle = '新对话',
  shellHeader = false,
  shellHeaderActionsTarget = null,
  onCreateProject,
  onWorkspaceEvent,
  conversations = [],
  onOpenModelSettings,
  selectedSkills = [],
  onSelectSkill,
  onRemoveSelectedSkill,
  onClearSelectedSkills,
  onNewConversation,
  onOpenConversation,
  onOpenFileReference,
  requestedBrowserPage,
  onRequestedBrowserPageConsumed,
  requestedArtifactReference,
  onRequestedArtifactReferenceConsumed,
  temporary = false,
  onExitTemporary
}: Props) {
  const wsTools = useRef<Map<string, ToolCall>>(new Map())
  const wsArtifacts = useRef<Map<string, Artifact>>(new Map())
  const wsSkills = useRef<Map<string, SkillTrace>>(new Map())
  const wsPlan = useRef<PlanStep[]>([])
  const pushWorkstation = () =>
    onWorkstation?.({
      tools: [...wsTools.current.values()],
      artifacts: [...wsArtifacts.current.values()],
      skills: [...wsSkills.current.values()],
      plan: wsPlan.current
    })
  const [messages, setMessages] = useState<Msg[]>([])
  const dshClientHost = useDshClientHost()
  const appName = useAppName()
  const showAnimeHome = useSkinsStore((state) => {
    const skin = state.getAppliedSkin()
    return skin?.id === ANIME_PROFILE_SKIN_ID
  })
  const [initialDraft] = useState(() => temporary
    ? { input: '', attachments: [], reviewComments: [], searchMode: 'auto' as const }
    : loadConversationDraft(projectId, selectedId))
  const [input, setInput] = useState(initialDraft.input)
  const [attachments, setAttachments] = useState<Attachment[]>(initialDraft.attachments)
  const [searchMode, setSearchMode] = useState<SearchMode>(initialDraft.searchMode)
  const [dropActive, setDropActive] = useState(false)
  const dropDepthRef = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    dshClientHost?.conversation.updateDraft(input)
  }, [dshClientHost, input])

  useEffect(() => {
    const selectedSkill = selectedSkills[selectedSkills.length - 1]
    if (!selectedSkill) return
    if (selectedSkill.prompt) setInput((current) => current.trim() ? current : selectedSkill.prompt || '')
    requestAnimationFrame(() => taRef.current?.focus())
  }, [selectedSkills])
  // Inline composer trigger (@ file / # conversation): track trigger char position and query text.
  const [trigger, setTrigger] = useState<{ mode: PickMode; start: number; query: string } | null>(null)
  // Slash commands (/compact etc.): show when input starts with "/" and user is still typing command name.
  const [slash, setSlash] = useState<{ query: string; args: string; skillsOnly?: boolean } | null>(null)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([])
  const [slashSkillsStatus, setSlashSkillsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [showTemplateGallery, setShowTemplateGallery] = useState(false)
  const [templateSkills, setTemplateSkills] = useState<SlashSkill[]>([])
  const [templateGalleryLoading, setTemplateGalleryLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const localBusyForSelectedConversation = busy && busySessionId === selectedId
  const runtimeState = conversationRuntimeState({
    localBusy: localBusyForSelectedConversation,
    conversationId: selectedId,
    latestRunId,
    latestRunStatus,
    liveInteractionStatus,
    locallyRunning
  })
  const effectiveBusy = runtimeState.busy
  const busyRef = useRef(false)
  busyRef.current = effectiveBusy
  const recoveredStopRequestRef = useRef<string | null>(null)
  const [conversationLoadState, setConversationLoadState] = useState<'idle' | 'loading' | 'error'>(
    selectedId ? 'loading' : 'idle'
  )
  const [messageActionPending, setMessageActionPending] = useState<string | null>(null)
  const [confirmDecided, setConfirmDecided] = useState<Record<string, 'approved' | 'rejected'>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [sessionId, setSessionId] = useState<string | null>(selectedId)
  const sessionIdRef = useRef<string | null>(selectedId)
  const newlyCreatedSessionIdRef = useRef<string | null>(null)
  const activeTurnIdRef = useRef<string | null>(null)
  const localContentStreamSessionRef = useRef<string | null>(null)
  const sendRef = useRef<(text?: string, extra?: DispatchExtra) => Promise<unknown> | undefined>(() => undefined)
  const [modelRuntime, setModelRuntime] = useState<ConversationModelRuntime | null>(null)
  const [modelMenuRequest, setModelMenuRequest] = useState(0)
  const pendingWorkspaceEventRef = useRef<DataWorkspaceEvent | null>(null)
  const [turnDiffs, setTurnDiffs] = useState<Record<string, TurnDiffSnapshot>>({})
  const [workspaceDiff, setWorkspaceDiff] = useState<TurnDiffSnapshot | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
  const workspaceRootAuthoritativeRef = useRef(false)
  const [reviewTurnId, setReviewTurnId] = useState<string | null>(null)
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>(initialDraft.reviewComments)
  const draftIdentity = temporary
    ? `${projectId}:__temporary__`
    : `${projectId}:${selectedId || '__new__'}`
  const draftIdentityRef = useRef(draftIdentity)
  const skipDraftPersistRef = useRef<string | null>(null)
  const consumedBrowserPageRef = useRef<number | null>(null)
  const consumedArtifactReferenceRef = useRef<number | null>(null)

  // Resolve the project write target so diff files can be opened in external editors.
  useEffect(() => {
    let cancelled = false
    workspaceRootAuthoritativeRef.current = false
    if (!projectId || projectId === CHAT_WS.id) { setWorkspaceRoot(null); return }
    void getProjectSourceFoldersReq(projectId)
      .then((res) => {
        if (cancelled) return
        const folders: any[] = Array.isArray(res?.data) ? res.data : []
        const writeTarget = folders.find((folder) => folder.write_target === true || folder.access_mode === 'write')
          || folders.find((folder) => folder.available !== false)
        if (!workspaceRootAuthoritativeRef.current) setWorkspaceRoot(writeTarget?.path || null)
      })
      .catch(() => {
        if (!cancelled && !workspaceRootAuthoritativeRef.current) setWorkspaceRoot(null)
      })
    return () => { cancelled = true }
  }, [projectId])

  useEffect(() => {
    if (draftIdentityRef.current === draftIdentity) return
    draftIdentityRef.current = draftIdentity
    skipDraftPersistRef.current = draftIdentity
    const draft = temporary
      ? { input: '', attachments: [], reviewComments: [], searchMode: 'auto' as const }
      : loadConversationDraft(projectId, selectedId)
    setInput(draft.input)
    setAttachments(draft.attachments)
    setReviewComments(draft.reviewComments)
    setSearchMode(draft.searchMode)
    setTrigger(null)
    setSlash(null)
  }, [draftIdentity, projectId, selectedId, temporary])

  useEffect(() => {
    if (temporary) return
    if (skipDraftPersistRef.current === draftIdentity) {
      skipDraftPersistRef.current = null
      return
    }
    persistConversationDraft(projectId, selectedId, {
      input,
      attachments,
      reviewComments,
      searchMode
    })
  }, [attachments, draftIdentity, input, projectId, reviewComments, searchMode, selectedId, temporary])

  useEffect(() => {
    if (!requestedBrowserPage || consumedBrowserPageRef.current === requestedBrowserPage.nonce) return
    consumedBrowserPageRef.current = requestedBrowserPage.nonce
    setInput((current) => current.trim()
      ? `${current.trimEnd()}\n\n${requestedBrowserPage.prompt}`
      : requestedBrowserPage.prompt)
    setAttachments((current) => mergeUniquePathItems(current, requestedBrowserPage.attachments))
    onRequestedBrowserPageConsumed?.(requestedBrowserPage.nonce)
    window.requestAnimationFrame(() => taRef.current?.focus())
  }, [onRequestedBrowserPageConsumed, requestedBrowserPage])

  useEffect(() => {
    if (!requestedArtifactReference || consumedArtifactReferenceRef.current === requestedArtifactReference.nonce) return
    consumedArtifactReferenceRef.current = requestedArtifactReference.nonce
    if (requestedArtifactReference.prompt?.trim()) {
      setInput((current) => current.trim()
        ? `${current.trimEnd()}\n\n${requestedArtifactReference.prompt}`
        : requestedArtifactReference.prompt || '')
    } else if (requestedArtifactReference.attachments.some((attachment) => attachmentArtifactSelections(attachment).length > 0)) {
      setInput((current) => stripLegacyArtifactReferencePrompt(current))
    }
    setAttachments((current) => mergeArtifactReferenceAttachments(current, requestedArtifactReference.attachments))
    onRequestedArtifactReferenceConsumed?.(requestedArtifactReference.nonce)
    window.requestAnimationFrame(() => taRef.current?.focus())
  }, [onRequestedArtifactReferenceConsumed, requestedArtifactReference])
  const [revertingItemIds, setRevertingItemIds] = useState<Record<string, boolean>>({})
  const clientCapabilities = useMemo(() => currentClientCapabilities(), [])
  const latestTurnDiff = useMemo(
    () => Object.values(turnDiffs).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null,
    [turnDiffs]
  )
  const headerDiff = workspaceDiff
    ? (workspaceDiff.diff.trim() ? workspaceDiff : null)
    : latestTurnDiff
  const reviewSnapshot = reviewTurnId === 'current-workspace'
    ? workspaceDiff
    : reviewTurnId
      ? turnDiffs[reviewTurnId] || null
      : null
  const refreshCurrentWorkspaceDiff = useCallback(async (threadId: string | null) => {
    if (!threadId || !clientCapabilities.reviewWorkspaceDiff) return
    try {
      const response: any = await getAgentCurrentWorkspaceDiff(threadId)
      if (sessionIdRef.current !== threadId) return
      const responseWorkspaceRoot = String(response?.data?.workspaceRoot || '').trim()
      if (responseWorkspaceRoot) {
        workspaceRootAuthoritativeRef.current = true
        setWorkspaceRoot(responseWorkspaceRoot)
      }
      if (response?.data?.supported === false) {
        setWorkspaceDiff(null)
        return
      }
      setWorkspaceDiff({
        threadId,
        turnId: 'current-workspace',
        diff: String(response?.data?.diff || ''),
        diffHash: response?.data?.diffHash || null,
        updatedAt: Date.now(),
        scope: 'workspace'
      })
    } catch {
      if (sessionIdRef.current === threadId) setWorkspaceDiff(null)
    }
  }, [clientCapabilities.reviewWorkspaceDiff])

  useEffect(() => {
    if (!slash) return
    let alive = true
    setSlashSkills([])
    setSlashSkillsStatus('loading')
    const currentSessionId = sessionIdRef.current || sessionId
    const request = currentSessionId
      ? getDshSkillsReq(projectId, currentSessionId)
      : Promise.resolve({ data: [] })
    request
      .then((response: any) => {
        if (!alive) return
        const data = response?.data || response || []
        const items: any[] = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []
        setSlashSkills(items.map(catalogSkill).filter((skill: SlashSkill | null): skill is SlashSkill => skill !== null))
        setSlashSkillsStatus('ready')
      })
      .catch(() => {
        if (!alive) return
        setSlashSkills([])
        setSlashSkillsStatus('error')
      })
    return () => { alive = false }
  }, [projectId, sessionId, Boolean(slash)])

  useEffect(() => {
    setSlashActiveIndex(0)
  }, [slash?.query, slash?.skillsOnly])

  const visibleSlashItems = useMemo(() => slash
    ? slashMenuItems(slash.query, {
        hasSession: messages.length > 0,
        busy: effectiveBusy,
        hasProject: workspaces.some((workspace) => workspace.id !== CHAT_WS.id)
      }, slashSkills, slash.skillsOnly)
    : [], [effectiveBusy, messages.length, slash, slashSkills, workspaces])

  useEffect(() => {
    if (!visibleSlashItems.length) {
      setSlashActiveIndex(0)
      return
    }
    setSlashActiveIndex((current) => Math.min(current, visibleSlashItems.length - 1))
  }, [visibleSlashItems.length])
  const openChanges = useCallback((turnId?: string | null) => {
    const snapshot = turnId === 'current-workspace'
      ? workspaceDiff
      : (turnId && turnDiffs[turnId]) || latestTurnDiff
    if (snapshot?.diff.trim()) {
      setReviewTurnId(snapshot.turnId)
      return
    }
    notifications.show({
      color: 'gray',
      message: '改动明细还在生成，请稍后再试。'
    })
  }, [latestTurnDiff, turnDiffs, workspaceDiff])

  // Permission options and the active value come only from DSH's per-session
  // `permissions` projection. A conversation without that capability renders
  // no permission control instead of inventing an App-side fallback.
  const [permissionSelect, setPermissionSelect] = useState<DshPermissionSelect | null>(null)
  const [permissionChanging, setPermissionChanging] = useState(false)

  // DSH's per-session `plan` projection is the durable authority. A blank
  // conversation keeps only an in-memory choice until its first DSH Session exists.
  const [collaborationMode, setCollaborationModeState] = useState<CollaborationMode>('default')
  const [collaborationModeChanging, setCollaborationModeChanging] = useState(false)
  const collaborationModeRef = useRef<CollaborationMode>(collaborationMode)
  const adoptCollaborationMode = (mode: CollaborationMode) => {
    setCollaborationModeState(mode)
    collaborationModeRef.current = mode
  }

  const applyDshPlanSnapshot = (state: DshSessionProtocolState | null | undefined) => {
    const next = collaborationModeFromDshPlan(state?.projections?.plan)
    if (next) adoptCollaborationMode(next)
  }

  // DSH owns the complete per-session queue. The renderer only projects the
  // latest session/queue snapshot received from the backend mux stream.
  const [queue, setQueueState] = useState<QueueItem[]>([])
  const applyDshQueueSnapshot = (state: DshSessionProtocolState | null | undefined) => {
    const next = Array.isArray(state?.queue)
      ? state.queue.filter((item) => item.placement === 'queued')
      : []
    setQueueState(next)
  }
  const applyDshPermissionSnapshot = (state: DshSessionProtocolState | null | undefined) => {
    const projection = state?.projections?.permissions
    if (!projection || typeof projection !== 'object') {
      setPermissionSelect(null)
      return
    }
    const raw = projection as Partial<DshPermissionSelect>
    const currentValue = String(raw.currentValue || '').trim()
    const options = (Array.isArray(raw.options) ? raw.options : []).map((option) => ({
      value: String(option?.value || '').trim(),
      name: String(option?.name || option?.value || '').trim(),
      ...(String(option?.description || '').trim() ? { description: String(option?.description).trim() } : {})
    })).filter((option) => option.value && option.name)
    setPermissionSelect(currentValue && options.length ? { currentValue, options } : null)
  }
  const changeCollaborationMode = async (mode: CollaborationMode) => {
    const next = normalizeCollaborationMode(mode)
    const currentSessionId = sessionIdRef.current
    if (!currentSessionId || temporary) {
      adoptCollaborationMode(next)
      return
    }
    if (collaborationModeChanging) return
    setCollaborationModeChanging(true)
    try {
      const response: any = await setDshSessionPlanMode(projectId, currentSessionId, next)
      if (sessionIdRef.current === currentSessionId) {
        const state = response?.data as DshSessionProtocolState
        applyDshQueueSnapshot(state)
        applyDshPermissionSnapshot(state)
        applyDshPlanSnapshot(state)
      }
    } catch (error: any) {
      try {
        const response: any = await getDshSessionProtocolState(projectId, currentSessionId)
        if (sessionIdRef.current === currentSessionId) {
          applyDshPlanSnapshot(response?.data as DshSessionProtocolState)
        }
      } catch {
        // The visible mode stays on the last confirmed DSH projection.
      }
      notifications.show({
        color: 'orange',
        title: '未能更新 DSH Plan 模式',
        message: error?.message || '请检查当前 Profile 后重试。'
      })
    } finally {
      setCollaborationModeChanging(false)
    }
  }
  const [qEditing, setQEditing] = useState<string | null>(null)
  const [qDraft, setQDraft] = useState('')

  useEffect(() => {
    setQueueState([])
    setPermissionSelect(null)
    setPermissionChanging(false)
    adoptCollaborationMode('default')
    setCollaborationModeChanging(false)
    setQEditing(null)
    setQDraft('')
  }, [projectId, selectedId, temporary])
  const appendAttachments = useCallback((files: Attachment[]) => {
    setAttachments((prev) => mergeUniquePathItems(prev, files))
  }, [])

  const isFileDrag = (dataTransfer: DataTransfer) =>
    Array.from(dataTransfer.types || []).includes('Files')

  const resetFileDrag = () => {
    dropDepthRef.current = 0
    setDropActive(false)
  }

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dropDepthRef.current += 1
    setDropActive(true)
  }

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
    if (dropDepthRef.current === 0) setDropActive(false)
  }

  const onComposerDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files || [])
    resetFileDrag()
    if (files.length === 0) return
    const picked = await registerDroppedFiles(files)
    if (picked.length === 0) {
      notifications.show({
        color: 'red',
        title: '无法添加拖入内容',
        message: '没有识别到可读取的本地文件或文件夹，请改用“添加文件 / 文件夹”。'
      })
      return
    }
    appendAttachments(
      picked.map((item) => ({ path: item.path, name: basename(item.path), isDir: item.isDir }))
    )
  }

  const toggleExpand = useCallback(
    (id: string, currentExpanded?: boolean) =>
      setExpanded((state) => ({
        ...state,
        [id]: !(currentExpanded ?? Boolean(state[id]))
      })),
    []
  )

  // Report whether there is conversation content (empty home = no content => hide right workbench).
  useEffect(() => {
    onHasContent?.(messages.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  const scrollRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const blockQueueRef = useRef<Array<{ block: Block; target?: AgentStreamTarget }>>([])
  const blockFlushTimerRef = useRef<number | null>(null)
  const notifiedBlockIdsRef = useRef<Set<string>>(new Set())
  const [activeMarkerId, setActiveMarkerId] = useState('')
  const virtualMessagesRef = useRef(messages)
  virtualMessagesRef.current = messages
  const getVirtualMessageKey = useCallback(
    (index: number) => {
      const message = virtualMessagesRef.current[index]
      return message ? messageTurnId(message, index) : `message-${index}`
    },
    []
  )
  const estimateVirtualRowSize = useCallback(
    (index: number) => estimateVirtualMessageSize(virtualMessagesRef.current[index]),
    []
  )
  const messageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: getVirtualMessageKey,
    estimateSize: estimateVirtualRowSize,
    overscan: VIRTUAL_MESSAGE_OVERSCAN,
    paddingStart: VIRTUAL_MESSAGE_PADDING_START,
    paddingEnd: VIRTUAL_MESSAGE_PADDING_END,
    anchorTo: 'end',
    followOnAppend: 'auto',
    scrollEndThreshold: 160,
    useAnimationFrameWithResizeObserver: true,
    useFlushSync: false,
  })
  const virtualMessageItems = messageVirtualizer.getVirtualItems()
  const markerRows = useMemo(
    () => {
      let questionNo = 0
      return messages.flatMap((message, rowIndex) => {
        if (message.role !== 'user') return []
        questionNo += 1
        const text = messageText(message)
        return [{
          marker: {
            id: messageTurnId(message, rowIndex),
            title: `第 ${questionNo} 问`,
            excerpt: clipText(text || '空问题'),
            meta: '定位到用户问题'
          } satisfies TurnLocatorMarker,
          id: messageTurnId(message, rowIndex),
          rowIndex,
        }]
      })
    },
    [messages]
  )
  const markerBase = useMemo(() => markerRows.map((row) => row.marker), [markerRows])
  const markerRowIndexById = useMemo(
    () => new Map(markerRows.map((row) => [row.id, row.rowIndex])),
    [markerRows]
  )

  const rebuildThreadMap = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller || markerBase.length === 0) {
      setActiveMarkerId('')
      return
    }
    const probeY = scroller.scrollTop + scroller.clientHeight * 0.34
    const active = activeVirtualMarkerId(markerRows, probeY, (rowIndex) => (
      messageVirtualizer.getOffsetForIndex(rowIndex, 'start')?.[0] ?? null
    ))
    setActiveMarkerId(active)
  }, [markerBase, markerRows, messageVirtualizer])

  const scrollToMarker = useCallback((id: string) => {
    const rowIndex = markerRowIndexById.get(id)
    if (rowIndex === undefined) return
    messageVirtualizer.scrollToIndex(rowIndex, { align: 'start', behavior: 'auto' })
    setActiveMarkerId(id)
  }, [markerRowIndexById, messageVirtualizer])

  useEffect(() => {
    const locateQuestion = (payload?: { sessionId?: string | null; questionNo?: number | null }) => {
      if (payload?.sessionId && payload.sessionId !== selectedId) return
      const questionNo = Number(payload?.questionNo || 0)
      const marker = questionNo > 0 ? markerBase[questionNo - 1] : markerBase[markerBase.length - 1]
      if (marker) scrollToMarker(marker.id)
    }
    eventBus.on(EVENT_TYPES.LOCATE_AGENT_QUESTION, locateQuestion)
    return () => eventBus.off(EVENT_TYPES.LOCATE_AGENT_QUESTION, locateQuestion)
  }, [markerBase, scrollToMarker, selectedId])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(rebuildThreadMap)
    return () => cancelAnimationFrame(frame)
  }, [rebuildThreadMap])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(rebuildThreadMap)
    }
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (observer) {
      observer.observe(scroller)
      if (threadRef.current) observer.observe(threadRef.current)
    }
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [rebuildThreadMap])

  useEffect(
    () => () => {
      if (blockFlushTimerRef.current !== null) window.clearTimeout(blockFlushTimerRef.current)
    },
    []
  )

  const scrollBottom = () => {
    const run = () => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    // Double rAF: wait for React commit + paint before scrolling so scrollHeight is up to date (high blocks like confirmation cards must be fully rendered).
    requestAnimationFrame(() => requestAnimationFrame(run))
  }

  // History hydration: when opening old conversation, rebuild workbench from persisted blocks (plan/tool calls/artifacts).
  const backfillWorkstation = (msgs: Msg[]) => {
    const draft = backfillWorkstationFromMessages(msgs)
    wsTools.current = draft.tools
    wsArtifacts.current = draft.artifacts
    wsSkills.current = draft.skills
    wsPlan.current = draft.plan
    pushWorkstation()
  }

  const applyPersistedMessages = (
    targetSessionId: string,
    mapped: Msg[],
    pendingInteractions: unknown = []
  ) => {
    const hydrated = mergeNativePendingInteractions(mapped, pendingInteractions, targetSessionId)
    setMessages(hydrated)
    const persistedTurnDiffs = Object.fromEntries(
      hydrated
        .filter((message) => message.turnId && typeof message.turnDiff === 'string')
        .map((message, index) => [message.turnId!, {
          threadId: message.threadId || targetSessionId,
          turnId: message.turnId!,
          diff: message.turnDiff || '',
          diffHash: null,
          updatedAt: index + 1
        } satisfies TurnDiffSnapshot])
    )
    // Terminal hydration can race the user's first click on the live Diff.
    // DSH history does not currently carry the App's turn_diff projection, so
    // preserve live snapshots and let any persisted snapshot replace its key.
    setTurnDiffs((current) => ({ ...current, ...persistedTurnDiffs }))
    backfillWorkstation(hydrated)
  }

  const hydratePersistedMessages = async (targetSessionId: string) => {
    const response: any = await getAgentMessages(projectId, targetSessionId)
    const payload = agentMessagesPayload(response)
    const mapped = mergeServerMessages(payload.messages.map(mapServerMessage))
    if (sessionIdRef.current !== targetSessionId) return null
    applyPersistedMessages(targetSessionId, mapped, payload.pendingInteractions)
    scrollBottom()
    return mapped
  }
  const hydratePersistedMessagesRef = useRef(hydratePersistedMessages)
  hydratePersistedMessagesRef.current = hydratePersistedMessages
  const previousAuthoritativeRunRef = useRef({
    id: latestRunId,
    active: runtimeState.authoritativeActive
  })
  const reconciledTerminalRunRef = useRef<string | null>(null)

  // The stream promise is component-local, but run status is durable. Keep the
  // recovered runtime visible until its durable status reaches a terminal state.
  useEffect(() => {
    const previous = previousAuthoritativeRunRef.current
    const current = { id: latestRunId, active: runtimeState.authoritativeActive }
    previousAuthoritativeRunRef.current = current

    if (current.active) {
      reconciledTerminalRunRef.current = null
      return
    }
    if (!selectedId || localBusyForSelectedConversation || !isReviewableConversationRunStatus(latestRunStatus)) return

    const transitionedToTerminal = previous.id === latestRunId && previous.active
    const staleShellRun = locallyRunning
    const terminalKey = `${latestRunId || 'unknown'}:${latestRunStatus || 'terminal'}`
    if (reconciledTerminalRunRef.current === terminalKey) return

    reconciledTerminalRunRef.current = terminalKey
    activeTurnIdRef.current = null
    if (transitionedToTerminal || staleShellRun) onRunningChange?.(false, selectedId)
    void hydratePersistedMessagesRef.current(selectedId)
      .catch(() => null)
      .finally(() => onAfterComplete?.())
  }, [
    localBusyForSelectedConversation,
    latestRunId,
    latestRunStatus,
    locallyRunning,
    onAfterComplete,
    onRunningChange,
    runtimeState.authoritativeActive,
    selectedId
  ])

  // Selection/create sync: when selectedId changes, sync state (skip immediately for newly created conversation to avoid clearing in-flight messages).
  useEffect(() => {
    if (selectedId && newlyCreatedSessionIdRef.current === selectedId) {
      newlyCreatedSessionIdRef.current = null
      setConversationLoadState('idle')
      return
    }
    if (selectedId === sessionId && (messages.length > 0 || !selectedId)) return
    let alive = true
    setSessionId(selectedId)
    sessionIdRef.current = selectedId
    activeTurnIdRef.current = null
    setExpanded({})
    setTurnDiffs({})
    setWorkspaceDiff(null)
    setReviewTurnId(null)
    setRevertingItemIds({})
    blockQueueRef.current = []
    if (blockFlushTimerRef.current !== null) {
      window.clearTimeout(blockFlushTimerRef.current)
      blockFlushTimerRef.current = null
    }
    // Switching/creating conversation: clear accumulated right workbench state.
    wsTools.current.clear()
    wsArtifacts.current.clear()
    wsSkills.current.clear()
    wsPlan.current = []
    notifiedBlockIdsRef.current.clear()
    pushWorkstation()
    if (!selectedId) {
      setConversationLoadState('idle')
      setMessages([])
      return () => {
        alive = false
      }
    }
    setConversationLoadState('loading')
    ;(async () => {
      try {
        const res: any = await getAgentMessages(projectId, selectedId)
        const payload = agentMessagesPayload(res)
        const mapped = mergeServerMessages(payload.messages.map(mapServerMessage))
        if (alive && sessionIdRef.current === selectedId) {
          applyPersistedMessages(selectedId, mapped, payload.pendingInteractions)
          setConversationLoadState('idle')
          void refreshCurrentWorkspaceDiff(selectedId)
          scrollBottom()
        }
      } catch {
        if (alive && sessionIdRef.current === selectedId) {
          setMessages([])
          setConversationLoadState('error')
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, refreshCurrentWorkspaceDiff])

  // History projection is presentation-only: DSH already owns the Session and
  // prompt context. A delayed App projection must not lock an otherwise valid
  // DSH Session out of its composer forever.
  useEffect(() => {
    if (!selectedId || conversationLoadState !== 'loading') return undefined
    const timer = window.setTimeout(() => {
      if (sessionIdRef.current === selectedId) setConversationLoadState('idle')
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [conversationLoadState, selectedId])

  const applyConversationBlock = (messages: Msg[], block: Block, target?: AgentStreamTarget) => {
    const next = applyBlockToMessages(messages, block, target)
    if (!isGenerativeUiBlock(block)) return next
    // Surface replacement is scoped to one assistant turn. Completed history
    // from other turns remains visible and auditable.
    return next.map((message) => {
      if (message.role !== 'assistant' || (target?.turnId && message.turnId !== target.turnId)) return message
      const blocks = foldGenerativeUiBlocks(message.blocks)
      return blocks === message.blocks ? message : { ...message, blocks }
    })
  }

  const flushQueuedBlocks = () => {
    blockFlushTimerRef.current = null
    const queued = blockQueueRef.current
    if (!queued.length) return
    blockQueueRef.current = []
    setMessages((prev) => queued.reduce((messages, queuedBlock) => applyConversationBlock(messages, queuedBlock.block, queuedBlock.target), prev))
    scrollBottom()
  }

  const applyBlock = (b: Block, options?: { immediate?: boolean; skipScroll?: boolean; target?: AgentStreamTarget }) => {
    if ((b.type === 'confirm' || b.type === 'user_input') && !notifiedBlockIdsRef.current.has(b.id)) {
      notifiedBlockIdsRef.current.add(b.id)
      sendTaskNotification(
        b.type === 'confirm' ? `${appName}需要确认` : `${appName}需要补充信息`,
        b.type === 'confirm' ? '当前任务需要你确认后继续执行。' : '当前任务需要你选择或填写信息后继续。',
        'action'
      )
    }
    if (options?.immediate) {
      if (blockFlushTimerRef.current !== null) {
        window.clearTimeout(blockFlushTimerRef.current)
        blockFlushTimerRef.current = null
      }
      const queued = blockQueueRef.current
      blockQueueRef.current = []
      setMessages((prev) => {
        const flushed = queued.reduce((messages, queuedBlock) => applyConversationBlock(messages, queuedBlock.block, queuedBlock.target), prev)
        return applyConversationBlock(flushed, b, options.target)
      })
      if (!options.skipScroll) scrollBottom()
      return
    }
    blockQueueRef.current.push({ block: b, target: options?.target })
    if (blockFlushTimerRef.current === null) {
      blockFlushTimerRef.current = window.setTimeout(flushQueuedBlocks, 24)
    }
  }

  const applyWorkstation = (patch: WorkstationPatch | undefined) => {
    const draft: WorkstationDraft = {
      tools: wsTools.current,
      artifacts: wsArtifacts.current,
      skills: wsSkills.current,
      plan: wsPlan.current
    }
    const changed = applyWorkstationPatch(patch, draft)
    wsTools.current = draft.tools
    wsArtifacts.current = draft.artifacts
    wsSkills.current = draft.skills
    wsPlan.current = draft.plan
    if (changed) pushWorkstation()
    return changed
  }

  const applyStreamPatch = (patch: ReturnType<typeof reduceStreamEvent>, expectedThreadId: string | null) => {
    // The URL thread id is Dsh's durable session id. Stream events carry the
    // actual Agent Runtime thread id, so the SSE request itself is the scope.
    if (expectedThreadId && sessionIdRef.current !== expectedThreadId) return
    if (patch.turn) {
      if (patch.turn.status === 'inProgress' && patch.turn.turnId) activeTurnIdRef.current = patch.turn.turnId
      if (['completed', 'failed', 'interrupted'].includes(String(patch.turn.status || ''))
        && (!patch.turn.turnId || patch.turn.turnId === activeTurnIdRef.current)) {
        activeTurnIdRef.current = null
      }
      setMessages((messages) => applyTurnToMessages(messages, patch.turn!))
    }
    if (patch.workspaceEvent) {
      pendingWorkspaceEventRef.current = mergeWorkspaceEvent(pendingWorkspaceEventRef.current, patch.workspaceEvent)
    }
    if (patch.turnDiff?.turnId) {
      setTurnDiffs((current) => ({
        ...current,
        [patch.turnDiff!.turnId!]: {
          threadId: patch.turnDiff!.threadId || null,
          turnId: patch.turnDiff!.turnId!,
          diff: patch.turnDiff!.diff,
          diffHash: patch.turnDiff!.diffHash || null,
          updatedAt: Date.now()
        }
      }))
    }
    if (patch.block) {
      const immediate = ['confirm', 'user_input', 'error', 'tool', 'tool_result', 'file_change', 'compact', 'generative_ui'].includes(patch.block.type)
      applyBlock(patch.block, { immediate, target: patch.target })
    }
    if (patch.removeBlockId && patch.block?.type !== 'generative_ui') {
      blockQueueRef.current = blockQueueRef.current.filter(
        (queued) => queued.block.id !== patch.removeBlockId || queued.target?.turnId !== patch.target?.turnId
      )
      setMessages((messages) => removeBlockFromMessages(messages, patch.removeBlockId!, patch.target))
    }
    applyWorkstation(patch.workstation)
    if (patch.scrollDelayMs) setTimeout(scrollBottom, patch.scrollDelayMs)
  }

  useEffect(() => {
    if (temporary || !selectedId) {
      dshClientHost?.conversation.syncSession(null)
      applyDshQueueSnapshot(null)
      applyDshPermissionSnapshot(null)
      applyDshPlanSnapshot(null)
      return
    }
    dshClientHost?.conversation.syncSession(null)
    const controller = new AbortController()
    let delayMs = 250
    const waitToRetry = () => new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, delayMs)
      controller.signal.addEventListener('abort', () => {
        window.clearTimeout(timer)
        resolve()
      }, { once: true })
    })
    const loadSnapshot = async () => {
      try {
        const response: any = await getDshSessionProtocolState(projectId, selectedId)
        if (!controller.signal.aborted && sessionIdRef.current === selectedId) {
          const state = response?.data as DshSessionProtocolState
          dshClientHost?.conversation.syncSession(state.dshSessionId)
          dshClientHost?.conversation.updateDraft(input)
          applyDshQueueSnapshot(state)
          applyDshPermissionSnapshot(state)
          applyDshPlanSnapshot(state)
        }
        return true
      } catch {
        return false
      }
    }
    const run = async () => {
      while (!controller.signal.aborted) {
        const attached = await loadSnapshot()
        if (controller.signal.aborted) break
        if (!attached) {
          await waitToRetry()
          delayMs = Math.min(delayMs * 2, 5_000)
          continue
        }
        try {
          await subscribeStream(watchDshSessionProtocol(projectId, selectedId, controller.signal), (line) => {
            const event = parseSseJsonLine(line)
            if (!event || controller.signal.aborted || sessionIdRef.current !== selectedId) return
            if (event.type === 'dsh/session-state') {
              const state = event.payload?.state as DshSessionProtocolState
              dshClientHost?.conversation.syncSession(state.dshSessionId)
              applyDshQueueSnapshot(state)
              applyDshPermissionSnapshot(state)
              applyDshPlanSnapshot(state)
              return
            }
            // A locally-started Turn already receives the same Runtime items
            // through startAgentTurn. The session listener remains the owner
            // of state/queue snapshots, while content has exactly one live
            // source so deltas are not appended twice.
            if (localContentStreamSessionRef.current === selectedId) return
            applyStreamPatch(reduceStreamEvent(event), selectedId)
          })
          delayMs = 250
        } catch {
          if (!controller.signal.aborted) await loadSnapshot()
        }
        if (!controller.signal.aborted) {
          await waitToRetry()
          delayMs = Math.min(delayMs * 2, 5_000)
        }
      }
    }
    void run()
    return () => controller.abort()
    // The stream is scoped only by the selected app session. Patch helpers use
    // refs for current state so reconnects do not restart on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dshClientHost, projectId, selectedId, temporary])

  const consumeAgentStream = async (req: ReturnType<typeof startAgentTurn>, expectedThreadId: string | null) => {
    let runCompleted = false
    let runFailed = false
    let persistenceFailed = false
    localContentStreamSessionRef.current = expectedThreadId
    try {
      await subscribeStream(req, (line) => {
        const evt = parseSseJsonLine(line)
        if (!evt) return
        if (isCompletedRunEvent(evt)) runCompleted = true
        if (isFailedRunEvent(evt)) runFailed = true
        if (String(evt.type || '').replace(/^dsh\//, '') === 'error') {
          runFailed = true
          if (String(evt.item_id || evt.payload?.itemId || '').startsWith('persistence:error:')) persistenceFailed = true
        }
        applyStreamPatch(reduceStreamEvent(evt), expectedThreadId)
      })
    } finally {
      if (localContentStreamSessionRef.current === expectedThreadId) {
        localContentStreamSessionRef.current = null
      }
    }
    flushQueuedBlocks()
    if (!runCompleted && !runFailed) throw new Error('连接已结束，但没有收到任务完成状态')
    return { runCompleted, runFailed, persistenceFailed }
  }

  const dispatch = async (q: string, extra?: DispatchExtra) => {
    if (!q || !projectId) return
    const requestAttachments = Array.isArray(extra?.attachments) ? (extra.attachments as Attachment[]) : []
    if (requestAttachments.some(isImageAttachment) && modelRuntime?.supportsImageInput === false) {
      notifications.show({
        color: 'orange',
        title: '当前模型不支持图片',
        message: '请切换到支持图片输入的模型后再发送。'
      })
      return
    }
    const displayMessage = typeof extra?.display_message === 'string' ? extra.display_message : q
    const turnSkillSelections = (Array.isArray(extra?.skillSelections)
      ? extra.skillSelections
      : selectedSkills) as ConversationSkillSelection[]
    const requestSkillSelections = optimisticSkillSelections(turnSkillSelections, extra?.skills)
    const routedSkillNames = agentRoutedSkillNames(turnSkillSelections)
    const runtimePrompt = promptWithRuntimeSkills(q, turnSkillSelections)
    const turnExtra = { ...(extra || {}) }
    delete turnExtra.attachments
    delete turnExtra.display_message
    delete turnExtra.approval
    delete turnExtra.settings
    delete turnExtra.skillSelections
    delete turnExtra.skill
    delete turnExtra.skills
    const startingSessionId = sessionIdRef.current || sessionId
    setBusy(true)
    setBusySessionId(startingSessionId)
    onRunningChange?.(true, startingSessionId)
    pendingWorkspaceEventRef.current = null
    wsSkills.current.clear()
    pushWorkstation()

    // Ensure session exists (create real session on first message).
    let sid = startingSessionId
    if (!sid) {
      try {
        const title = displayMessage || requestAttachments[0]?.name || q
        const res: any = await createAgentSession(projectId, title, { temporary })
        sid = res?.data?.id || res?.data?.session?.id || null
        if (sid) {
          newlyCreatedSessionIdRef.current = sid
          setSessionId(sid)
          sessionIdRef.current = sid
          setBusySessionId(sid)
          onSessionCreated?.(sid)
          onRunningChange?.(true, sid)
        }
        if (!sid) throw new Error('服务端没有返回会话 ID')
      } catch (error: any) {
        notifications.show({
          color: 'red',
          title: '无法创建会话',
          message: error?.message || '请稍后重试。'
        })
        setBusy(false)
        setBusySessionId(null)
        onRunningChange?.(false, sid)
        if (stopRef) stopRef.current = null
        return
      }
    }

    const clientUserMessageId = 'user:' + Date.now()
    setMessages((m) => [
      ...m,
      {
        id: clientUserMessageId,
        role: 'user',
        blocks: [
          ...requestAttachments.map(attachmentBlock),
          ...(displayMessage ? [{ id: 'u' + Date.now(), type: 'text', content: displayMessage }] : [])
        ],
        skillSelections: requestSkillSelections
      },
      { id: 'pending:' + Date.now(), role: 'assistant', blocks: [], threadId: sid, status: 'pending' }
    ])
    scrollBottom()

    const controller = new AbortController()
    if (stopRef) stopRef.current = () => void stopTurnAfterSettlement({
      threadId: sid,
      turnId: activeTurnIdRef.current,
      interrupt: interruptAgentTurn,
      abort: () => controller.abort()
    })
    let runCompleted = false
    let runFailed = false
    let persistenceFailed = false
    try {
      const req = startAgentTurn(projectId, sid, {
        input: buildAgentTurnInput(runtimePrompt, requestAttachments),
        temporary,
        clientUserMessageId,
        model: modelRuntime?.modelId,
        effort: modelRuntime?.reasoningEffort,
        summary: modelRuntime?.reasoningSummary,
        verbosity: modelRuntime?.verbosity,
        searchMode,
        collaborationMode: collaborationModeRef.current,
        clientCapabilities,
        attachments: normalizeAttachmentsForRequest(requestAttachments),
        displayMessage,
        ...(routedSkillNames.length ? { skills: routedSkillNames, skill: routedSkillNames[0] } : {}),
        ...turnExtra
      }, controller.signal)
      // Line-level subscription: stream/buffer/chunking handled by subscribeStream (Electron via ipc, browser via fetch).
      const streamResult = await consumeAgentStream(req, sid)
      runCompleted = streamResult.runCompleted
      runFailed = streamResult.runFailed
      persistenceFailed = streamResult.persistenceFailed
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        if (sessionIdRef.current === sid) {
          setMessages((messages) => applyTurnToMessages(messages, { threadId: sid, status: 'interrupted' }))
          applyBlock({ id: 'stop' + Date.now(), type: 'error', content: '⏹ 已停止' })
        }
      } else if (typeof e?.message === 'string' && e.message.includes('连接已结束')) {
        // Stream ended without a completion signal — the Turn may still be
        // running server-side (e.g. a transient SSE drop). Do NOT mark failed;
        // let the finally block's hydratePersistedMessages refetch from DSH
        // history to recover the true state (completed, still running, or
        // genuinely failed).
        runFailed = false
      } else {
        runFailed = true
        if (sessionIdRef.current === sid) {
          setMessages((messages) => applyTurnToMessages(messages, { threadId: sid, status: 'failed', error: e?.message || String(e) }))
          applyBlock({ id: 'err' + Date.now(), type: 'error', content: '⚠️ ' + (e?.message || e) })
        }
      }
    } finally {
      if (runCompleted && sessionIdRef.current === sid) {
        setMessages((messages) => applyTurnToMessages(messages, { threadId: sid, status: runFailed ? 'failed' : 'completed' }))
      }
      if (runCompleted && !runFailed) {
        sendTaskNotification(`${appName}任务已完成`, q.slice(0, 96) || '任务已完成。', 'success')
      } else if (runFailed) {
        sendTaskNotification(`${appName}任务失败`, q.slice(0, 96) || '任务执行失败。', 'error')
      }
      if (!temporary && sid && !persistenceFailed && sessionIdRef.current === sid) {
        await hydratePersistedMessages(sid).catch(() => null)
      }
      setBusy(false)
      setBusySessionId(null)
      onRunningChange?.(false, sid)
      if (stopRef) stopRef.current = null
      activeTurnIdRef.current = null
      void refreshCurrentWorkspaceDiff(sid)
      onAfterComplete?.()
      const workspaceEvent = pendingWorkspaceEventRef.current
      pendingWorkspaceEventRef.current = null
      if (workspaceEvent) {
        let switchedWorkspace = false
        try {
          switchedWorkspace = (await onWorkspaceEvent?.(workspaceEvent)) === true
        } catch {
          switchedWorkspace = false
        }
        if (switchedWorkspace) return
      }
      scrollBottom()
    }
  }

  const sendDshPrompt = async (mode: 'queue' | 'steer', text: string, atts: Attachment[], extra?: DispatchExtra) => {
    const sid = sessionIdRef.current
    if (!sid) throw new Error('会话还没有创建')
    const turnSkills = (Array.isArray(extra?.skillSelections) ? extra.skillSelections : selectedSkills) as ConversationSkillSelection[]
    const runtimePrompt = promptWithRuntimeSkills(text, turnSkills)
    const result: any = await promptDshSession(projectId, sid, {
      mode,
      input: buildAgentTurnInput(runtimePrompt, atts),
      attachments: normalizeAttachmentsForRequest(atts)
    })
    if (result?.data?.accepted !== true) throw new Error(mode === 'queue' ? 'DSH 没有接受这条队列消息' : 'DSH 没有接受补充内容')
    return result
  }

  const steerCurrentTurn = async (text: string, atts: Attachment[], extra?: DispatchExtra) => {
    const sid = sessionIdRef.current
    if (!sid) return
    const turnId = activeTurnIdRef.current
    const clientUserMessageId = 'user:' + Date.now()
    setMessages((items) => insertSteerUserMessage(items, {
        id: clientUserMessageId,
        role: 'user',
        blocks: [
          ...atts.map(attachmentBlock),
          ...(text ? [{ id: `u${Date.now()}`, type: 'text', content: text }] : [])
        ],
        threadId: sid,
        turnId
      }, turnId || `dsh:${sid}:active`))
    scrollBottom()
    try {
      await sendDshPrompt('steer', text, atts, extra)
    } catch (error: any) {
      setMessages((items) => items.filter((item) => item.id !== clientUserMessageId))
      notifications.show({
        color: 'orange',
        title: '未能补充到当前任务',
        message: error?.message || '当前任务已经进入收尾。'
      })
    }
  }

  // Review the current workspace diff via a codex-native review turn.
  const handleReview = async () => {
    const sid = sessionIdRef.current
    if (!sid || effectiveBusy) return
    setBusy(true)
    setBusySessionId(sid)
    onRunningChange?.(true, sid)
    const stopController = new AbortController()
    if (stopRef) stopRef.current = () => void stopTurnAfterSettlement({
      threadId: sid,
      turnId: activeTurnIdRef.current,
      interrupt: interruptAgentTurn,
      abort: () => stopController.abort()
    })
    activeTurnIdRef.current = null
    // Match the normal send message shape (clientUserMessageId + blocks) so the
    // optimistic user message is deduplicated against the persisted one.
    const optimisticTimestamp = Date.now()
    const clientUserMessageId = 'user:' + optimisticTimestamp
    setMessages((messages) => [
      ...messages,
      {
        id: clientUserMessageId,
        role: 'user',
        blocks: [{ id: `u${optimisticTimestamp}`, type: 'text', content: '审查当前工作区改动' }],
        threadId: sid
      },
      {
        id: `pending-review:${optimisticTimestamp}`,
        role: 'assistant',
        blocks: [],
        threadId: sid,
        status: 'pending'
      }
    ])
    scrollBottom()
    let runCompleted = false
    let runFailed = false
    try {
      const req = startAgentReview(projectId, sid, {
        model: modelRuntime?.modelId,
        effort: modelRuntime?.reasoningEffort,
        summary: modelRuntime?.reasoningSummary,
        verbosity: modelRuntime?.verbosity,
        clientUserMessageId,
      }, stopController.signal)
      const streamResult = await consumeAgentStream(req, sid)
      runCompleted = streamResult.runCompleted
      runFailed = streamResult.runFailed
    } catch (e: any) {
      if (typeof e?.message === 'string' && e.message.includes('连接已结束')) {
        // Stream ended without completion — let hydratePersistedMessages recover.
        runFailed = false
      } else {
        runFailed = true
        if (sessionIdRef.current === sid) {
          setMessages((messages) => applyTurnToMessages(messages, { threadId: sid, status: 'failed', error: e?.message || String(e) }))
          applyBlock({ id: 'err' + Date.now(), type: 'error', content: '⚠️ ' + (e?.message || e) })
        }
      }
    } finally {
      if (runCompleted && sessionIdRef.current === sid) {
        setMessages((messages) => applyTurnToMessages(messages, { threadId: sid, status: runFailed ? 'failed' : 'completed' }))
      }
      setBusy(false)
      setBusySessionId(null)
      onRunningChange?.(false, sid)
      if (stopRef) stopRef.current = null
      activeTurnIdRef.current = null
      void refreshCurrentWorkspaceDiff(sid)
    }
  }

  const send = (text?: string, extra?: DispatchExtra) => {
    const typed = (text ?? input).trim()
    const atts = text == null ? attachments : []
    const comments = text == null ? reviewComments : []
    if (!typed && !atts.length && !comments.length) return
    if (atts.some(isImageAttachment) && modelRuntime?.supportsImageInput === false) {
      notifications.show({
        color: 'orange',
        title: '当前模型不支持图片',
        message: '请切换到支持图片输入的模型后再发送。'
      })
      return
    }
    const q = typed || (comments.length ? '请根据审核意见修改。' : '请处理附件。')
    if (!q) return
    const hasTurnOnlySkill = selectedSkills.some((skill) => !isPersistentProjectSkill(skill))
    const routedSkillNames = agentRoutedSkillNames(selectedSkills)
    const sendExtra = {
      ...(extra || {}),
      ...(routedSkillNames.length ? { skills: routedSkillNames, skill: routedSkillNames[0] } : {}),
      ...(selectedSkills.length ? { skillSelections: selectedSkills } : {}),
      attachments: atts,
      display_message: typed || (comments.length ? '请根据审核意见修改。' : ''),
      ...(comments.length ? { reviewComments: comments } : {})
    }
    setInput('')
    setAttachments([])
    setReviewComments([])
    if (hasTurnOnlySkill) onClearSelectedSkills?.()
    setTrigger(null)
    if (effectiveBusy) {
      const turnNotReady = !activeTurnIdRef.current
      if (interactionMode === 'queue' || hasTurnOnlySkill || turnNotReady) {
        if (hasTurnOnlySkill && interactionMode !== 'queue') {
          notifications.show({ color: 'gray', message: '能力选择已变化，会从下一轮开始生效，内容已加入队列' })
        } else if (turnNotReady && interactionMode !== 'queue') {
          notifications.show({ color: 'gray', message: '当前任务正在启动，内容已加入下一轮' })
        }
        return sendDshPrompt('queue', q, atts, sendExtra).catch((error: any) => {
          setInput(typed)
          setAttachments(atts)
          setReviewComments(comments)
          notifications.show({
            color: 'orange',
            title: '未能加入 DSH 队列',
            message: error?.message || '请稍后重试。'
          })
        })
      }
      return steerCurrentTurn(q, atts, sendExtra)
    }
    return dispatch(q, sendExtra)
  }

  sendRef.current = send
  const sendGenerativeUiAction = useCallback(async (message: string) => {
    if (busyRef.current) throw new Error('当前任务仍在执行，请等待完成后再操作')
    busyRef.current = true
    try {
      const request = sendRef.current(message)
      if (!request) throw new Error('当前消息无法发送，请稍后重试')
      await request
    } finally {
      busyRef.current = false
    }
  }, [])

  const copyMessage = async (text: string) => {
    const value = String(text || '').trim()
    if (!value) return
    const copied = await copyToClipboard(value)
    notifications.show({
      color: copied ? 'green' : 'red',
      message: copied ? '已复制' : '复制失败，请重试'
    })
  }

  const runMessageAction = async (
    mode: AgentMessageBranchMode,
    message: Msg,
    editedText?: string
  ): Promise<boolean> => {
    const sourceSessionId = sessionIdRef.current
    const messageId = String(message.id || '').trim()
    if (!sourceSessionId || !messageId || effectiveBusy || temporary || messageActionPending) return false
    const actionId = `${mode}:${messageId}`
    setMessageActionPending(actionId)
    try {
      const response: any = await branchAgentMessage(projectId, sourceSessionId, messageId, mode)
      const data = response?.data || {}
      const nextSessionId = String(data?.session?.id || '').trim()
      if (!nextSessionId) throw new Error('服务端没有返回分支会话')

      const rawMessages = Array.isArray(data.messages) ? data.messages : []
      const mapped = mergeServerMessages(rawMessages.map(mapServerMessage))
      newlyCreatedSessionIdRef.current = nextSessionId
      setSessionId(nextSessionId)
      sessionIdRef.current = nextSessionId
      applyDshQueueSnapshot(null)
      applyDshPermissionSnapshot(null)
      applyDshPlanSnapshot(null)
      applyPersistedMessages(nextSessionId, mapped)
      setWorkspaceDiff(null)
      setReviewTurnId(null)
      setRevertingItemIds({})
      scrollBottom()

      if (mode === 'branch') {
        onSessionCreated?.(nextSessionId)
        onAfterComplete?.()
        return true
      }

      const draft: any = data.draft && typeof data.draft === 'object' ? data.draft : {}
      const request: any = draft.request && typeof draft.request === 'object' ? draft.request : {}
      const branchAttachments = (Array.isArray(draft.attachments) ? draft.attachments : [])
        .map(attachmentFromBranchDraft)
        .filter(Boolean) as Attachment[]
      const displayMessage = mode === 'edit'
        ? String(editedText ?? '').trim()
        : String(draft.text || '').trim()
      const prompt = displayMessage || '请处理附件。'
      const turnExtra: DispatchExtra = {
        attachments: branchAttachments,
        display_message: displayMessage,
        ...(mode === 'retry' && Array.isArray(draft.input) ? { input: draft.input } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.summary ? { summary: request.summary } : {}),
        ...(request.verbosity ? { verbosity: request.verbosity } : {}),
        ...(request.searchMode ? { searchMode: request.searchMode } : {}),
        ...(request.collaborationMode ? { collaborationMode: request.collaborationMode } : {}),
        ...(Array.isArray(request.skills) && request.skills.length
          ? { skills: request.skills, skill: request.skills[0] }
          : {}),
        ...(Array.isArray(request.skill_selections) && request.skill_selections.length
          ? { skillSelections: request.skill_selections }
          : {}),
        ...(Array.isArray(request.plugins) && request.plugins.length
          ? { plugins: request.plugins, plugin: request.plugins[0] }
          : {})
      }
      if (['auto', 'required', 'off'].includes(request.searchMode)) {
        setSearchMode(request.searchMode as SearchMode)
      }
      if (['default', 'plan'].includes(request.collaborationMode)) {
        adoptCollaborationMode(normalizeCollaborationMode(request.collaborationMode))
      }
      await dispatch(prompt, turnExtra)
      onSessionCreated?.(nextSessionId)
      return true
    } catch (error: any) {
      notifications.show({
        color: 'red',
        title: mode === 'retry' ? '无法重试回答' : mode === 'edit' ? '无法编辑消息' : '无法创建分支',
        message: error?.message || '请稍后重试。'
      })
      return false
    } finally {
      setMessageActionPending(null)
    }
  }

  const resolvePendingAction = async (
    payload: Pick<ReturnType<typeof parseUserInputPayload>, 'requestId' | 'runId' | 'resumeHandle'>,
    value: string,
    extra: Record<string, unknown> = {}
  ) => {
    const requestId = payload.requestId
    if (!requestId || !projectId || !sessionId) return
    if (busy) return
    setBusy(true)
    const actionSessionId = sessionId
    setBusySessionId(actionSessionId)
    onRunningChange?.(true, actionSessionId)
    pendingWorkspaceEventRef.current = null
    setMessages((m) => [
      ...m,
      {
        id: 'pending:' + Date.now(),
        role: 'assistant',
        blocks: [],
        threadId: actionSessionId,
        turnId: payload.runId || null,
        status: 'pending'
      }
    ])
    scrollBottom()

    const controller = new AbortController()
    if (stopRef) stopRef.current = () => void stopTurnAfterSettlement({
      threadId: actionSessionId,
      turnId: activeTurnIdRef.current || payload.runId || null,
      interrupt: interruptAgentTurn,
      abort: () => controller.abort()
    })
    let runCompleted = false
    let runFailed = false
    try {
      const req = resolveAgentPendingAction(
        projectId,
        actionSessionId,
        requestId,
        {
          value,
          run_id: payload.runId || undefined,
          resume_handle: payload.resumeHandle || undefined,
          ...extra
        },
        controller.signal
      )
      const streamResult = await consumeAgentStream(req, actionSessionId)
      runCompleted = streamResult.runCompleted
      runFailed = streamResult.runFailed
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        if (sessionIdRef.current === actionSessionId) {
          setMessages((messages) => applyTurnToMessages(messages, { threadId: actionSessionId, status: 'interrupted' }))
          applyBlock({ id: 'stop' + Date.now(), type: 'error', content: '⏹ 已停止' })
        }
      } else {
        runFailed = true
        if (sessionIdRef.current === actionSessionId) {
          setMessages((messages) => applyTurnToMessages(messages, { threadId: actionSessionId, status: 'failed', error: e?.message || String(e) }))
          applyBlock({ id: 'err' + Date.now(), type: 'error', content: '⚠️ ' + (e?.message || e) })
        }
      }
    } finally {
      if (runCompleted && sessionIdRef.current === actionSessionId) {
        setMessages((messages) =>
          applyTurnToMessages(messages, {
            threadId: actionSessionId,
            turnId: payload.runId || undefined,
            status: runFailed ? 'failed' : 'completed'
          })
        )
      }
      if (runCompleted && !runFailed) {
        sendTaskNotification(`${appName}任务已继续`, '补充信息已处理，任务执行完成。', 'success')
      } else if (runFailed) {
        sendTaskNotification(`${appName}任务失败`, '补充信息后的任务继续执行失败。', 'error')
      }
      setBusy(false)
      setBusySessionId(null)
      onRunningChange?.(false, actionSessionId)
      if (stopRef) stopRef.current = null
      onAfterComplete?.()
      scrollBottom()
    }
  }

  const decide = (toolCallId: string, decision: ApprovalDecision, request?: any) => {
    const approved = isAcceptedApprovalDecision(decision)
    setConfirmDecided((m) => ({ ...m, [toolCallId]: approved ? 'approved' : 'rejected' }))
    if (request?.deferred && request?.request_id && request?.run_id) {
      void resolvePendingAction(
        {
          requestId: String(request.request_id),
          runId: String(request.run_id),
          resumeHandle: request.resume_handle || null
        },
        approved ? 'approved' : 'rejected',
        { action_type: 'approval', approved }
      )
      return
    }
    const runtimeThreadId = String(request?.threadId || request?.thread_id || '').trim()
    const runtimeTurnId = String(request?.turnId || request?.turn_id || '').trim()
    const runtimeItemId = String(request?.itemId || request?.item_id || toolCallId).trim()
    if (runtimeThreadId && runtimeTurnId && runtimeItemId) {
      resolveAgentApproval(
        runtimeThreadId,
        runtimeTurnId,
        runtimeItemId,
        decision
      ).catch(() => {
        setConfirmDecided((state) => {
          const next = { ...state }
          delete next[toolCallId]
          return next
        })
        notifications.show({
          color: 'orange',
          title: '确认请求未提交',
          message: '请检查连接后重试。'
        })
      })
    }
  }

  const onSubmitUserInput = async (
    payload: ReturnType<typeof parseUserInputPayload>,
    answers: Record<string, { answers: string[] }>
  ) => {
    try {
      if (payload.native && payload.threadId && payload.turnId && payload.itemId) {
        const actionSessionId = sessionIdRef.current
        await resolveAgentUserInput(payload.threadId, payload.turnId, payload.itemId, answers)
        if (actionSessionId && sessionIdRef.current === actionSessionId) {
          setMessages((current) => markNativeUserInputResolved(current, payload.itemId, answers))
        }
        return
      }
      const value = Object.values(answers).flatMap((answer) => answer.answers).join('，')
      await resolvePendingAction(payload, value)
    } catch (error: any) {
      notifications.show({
        color: 'orange',
        title: '未能提交回答',
        message: error?.message || '这个问题可能已经失效，请重新发起。'
      })
      throw error
    }
  }

  const revertFileChange = async (message: Msg, block: Block) => {
    const sid = sessionIdRef.current
    const turnId = message.turnId
    if (!clientCapabilities.mutateWorkspace || !sid || !turnId || revertingItemIds[block.id]) return
    const requestId = `workspace-action:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    setRevertingItemIds((state) => ({ ...state, [block.id]: true }))
    try {
      const response: any = await revertAgentWorkspaceChange(sid, turnId, {
        requestId,
        targetItemId: block.id
      })
      const action = response?.data
      if (!action || action.status !== 'succeeded') throw new Error('服务端没有确认撤销结果')
      setMessages((items) => items.map((item) => item === message || item.turnId === turnId
        ? {
            ...item,
            workspaceActions: {
              ...(item.workspaceActions || {}),
              [block.id]: action
            }
          }
        : item))
      if (typeof action.currentDiff === 'string') {
        if (typeof action.workspaceRoot === 'string' && action.workspaceRoot.trim()) {
          workspaceRootAuthoritativeRef.current = true
          setWorkspaceRoot(action.workspaceRoot.trim())
        }
        setWorkspaceDiff({
          threadId: sid,
          turnId: 'current-workspace',
          diff: action.currentDiff,
          diffHash: null,
          updatedAt: Date.now(),
          scope: 'workspace'
        })
      } else {
        void refreshCurrentWorkspaceDiff(sid)
      }
      notifications.show({
        color: 'green',
        title: '已撤销文件更改',
        message: Array.isArray(action.revertedPaths) && action.revertedPaths.length
          ? action.revertedPaths.join('、')
          : '工作区已经恢复。'
      })
    } catch (error: any) {
      notifications.show({
        color: 'orange',
        title: '无法安全撤销',
        message: error?.message || '当前文件可能已经变化，请先审核最新内容。'
      })
    } finally {
      setRevertingItemIds((state) => {
        const next = { ...state }
        delete next[block.id]
        return next
      })
    }
  }

  const addReviewComment = (comment: ReviewComment) => {
    setReviewComments((items) => [...items, comment])
    setInput((current) => current.trim() ? current : '请根据审核意见修改。')
    requestAnimationFrame(() => taRef.current?.focus())
    notifications.show({ color: 'green', message: '审核意见已加入下一轮消息' })
  }

  const applyLineEdit = async (input: {
    path: string
    lineNumber: number
    newLineText: string
  }) => {
    const sid = sessionIdRef.current
    const turnId = reviewSnapshot?.turnId
    if (!clientCapabilities.mutateWorkspace || !sid || !turnId) {
      throw new Error('当前会话不支持直接编辑工作区文件')
    }
    const requestId = `workspace-edit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const response: any = await applyAgentWorkspaceEdit(sid, turnId, {
      requestId,
      path: input.path,
      lineNumber: input.lineNumber,
      newLineText: input.newLineText,
      // Conflict detection: pass the workspace diff hash the panel rendered.
      // The server rejects the write if the workspace changed since.
      expectedWorkspaceDiffHash: workspaceDiff?.diffHash || undefined
    })
    const action = response?.data
    if (!action || action.status !== 'succeeded') throw new Error('服务端没有确认编辑结果')
    if (typeof action.workspaceRoot === 'string' && action.workspaceRoot.trim()) {
      workspaceRootAuthoritativeRef.current = true
      setWorkspaceRoot(action.workspaceRoot.trim())
    }
    const updated: TurnDiffSnapshot = {
      threadId: sid,
      turnId: 'current-workspace',
      diff: typeof action.currentDiff === 'string' ? action.currentDiff : '',
      diffHash: typeof action.workspaceDiffHash === 'string' ? action.workspaceDiffHash : null,
      updatedAt: Date.now(),
      scope: 'workspace'
    }
    // Refresh the workspace diff (and the review panel when it shows workspace scope).
    setWorkspaceDiff(updated.diff ? updated : null)
    if (reviewSnapshot?.scope === 'workspace' || reviewTurnId === 'current-workspace') {
      setTurnDiffs((state) => ({ ...state, 'current-workspace': updated }))
    }
    // When the panel shows a specific turn diff, re-fetch the workspace diff so
    // the hash stays fresh for the next edit's conflict check.
    if (!updated.diff || reviewSnapshot?.scope !== 'workspace') {
      void refreshCurrentWorkspaceDiff(sid)
    }
    notifications.show({ color: 'green', message: '已编辑这一行' })
    return action
  }

  // Insert text at cursor (for insert result selected from + menu mention panel).
  const insertAtCursor = (snippet: string) => {
    const ta = taRef.current
    const at = ta ? ta.selectionStart : input.length
    const next = input.slice(0, at) + snippet + input.slice(ta ? ta.selectionEnd : input.length)
    setInput(next)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        const pos = at + snippet.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const insertTextRange = (text: string, start: number, end: number) => {
    const pos = start + text.length
    setInput((prev) => {
      const from = Math.max(0, Math.min(start, prev.length))
      const to = Math.max(from, Math.min(end, prev.length))
      return prev.slice(0, from) + text + prev.slice(to)
    })
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData('text/plain')
    const imageFiles = Array.from(e.clipboardData.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[]
    if (imageFiles.length > 0) {
      e.preventDefault()
      const api = (window as any).electronAPI
      if (typeof api?.savePastedImageAttachment !== 'function') {
        notifications.show({ color: 'red', title: '无法粘贴图片', message: '当前环境不能保存剪贴板图片。' })
        return
      }
      const start = e.currentTarget.selectionStart ?? input.length
      const end = e.currentTarget.selectionEnd ?? input.length
      try {
        const savedItems = await Promise.all(
          imageFiles.slice(0, 8).map((file) => api.savePastedImageAttachment({ projectId, sessionId }, file))
        )
        const nextAttachments = savedItems.filter((item) => item?.path).map((item) => ({
          path: String(item.path),
          name: String(item.name || basename(item.path)),
          isDir: false,
          mimeType: String(item.mimeType || 'image/png'),
          size: Number(item.size || 0) || undefined,
          width: Number(item.width || 0) || undefined,
          height: Number(item.height || 0) || undefined
        }))
        if (!nextAttachments.length) throw new Error('图片保存失败')
        appendAttachments(nextAttachments)
        if (pasted) insertTextRange(pasted, start, end)
        notifications.show({ color: 'green', message: `已添加 ${nextAttachments.length} 张图片。` })
      } catch (error) {
        notifications.show({
          color: 'red',
          title: '图片粘贴失败',
          message: error instanceof Error ? error.message : '请改用“添加文件”。'
        })
      }
      return
    }
    if (!pasted) return
    const bytes = textByteLength(pasted)
    if (bytes <= LARGE_PASTE_LIMIT_BYTES) return
    const api = (window as any).electronAPI
    if (typeof api?.savePastedTextAttachment !== 'function') return
    const start = e.currentTarget.selectionStart ?? input.length
    const end = e.currentTarget.selectionEnd ?? input.length
    e.preventDefault()
    try {
      const saved = await api.savePastedTextAttachment({ projectId, sessionId, content: pasted })
      if (!saved?.path) throw new Error('保存粘贴附件失败')
      const path = String(saved.path)
      appendAttachments([{ path, name: String(saved.name || basename(path)), isDir: false }])
      setInput((current) => {
        const from = Math.max(0, Math.min(start, current.length))
        const to = Math.max(from, Math.min(end, current.length))
        const kept = current.slice(0, from) + current.slice(to)
        return kept.trim() ? kept : LARGE_PASTE_NOTICE
      })
      setTrigger(null)
      setSlash(null)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (el) {
          const pos = Math.max(0, Math.min(start, el.value.length))
          el.focus()
          el.setSelectionRange(pos, pos)
        }
      })
      notifications.show({
        color: 'green',
        title: '已转换为 TXT 附件',
        message: `${formatBytes(bytes)} 粘贴内容已添加到附件。`
      })
    } catch {
      insertTextRange(pasted, start, end)
      notifications.show({
        color: 'red',
        title: '粘贴转换失败',
        message: '已按普通文本粘贴。'
      })
    }
  }

  // On composer change: update value and detect slash command (line-start /) and inline references (@ file / # conversation).
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    // Slash commands own the first input line. `/skill 质量` filters Skills; other commands may keep text as arguments.
    const slashMatch = !val.includes('\n') ? val.match(/^\/([^\s]*)(?:\s+(.*))?$/) : null
    if (slashMatch) {
      const commandName = String(slashMatch[1] || '')
      const args = String(slashMatch[2] || '')
      const skillsOnly = commandName.toLowerCase() === 'skill' && /\s/.test(val)
      setSlash({ query: skillsOnly ? args : commandName, args, skillsOnly })
      if (trigger) setTrigger(null)
      return
    }
    if (slash) setSlash(null)
    const caret = e.target.selectionStart ?? val.length
    // Scan left from cursor; there must be no whitespace/newline between cursor and trigger character.
    let i = caret - 1
    while (i >= 0 && !/\s/.test(val[i]) && !'@#'.includes(val[i])) i--
    const ch = val[i]
    const triggerable = (ch === '@' || ch === '#') && (i === 0 || /\s/.test(val[i - 1]))
    if (triggerable) {
      const mode: PickMode = ch === '@' ? 'file' : 'conv'
      setTrigger({ mode, start: i, query: val.slice(i + 1, caret) })
    } else if (trigger) {
      setTrigger(null)
    }
  }

  // Execute slash command (operation only, no text insertion).
  const runSlash = async (name: string) => {
    const args = slash?.args?.trim() || ''
    if (name === 'skill') {
      setInput('/skill ')
      setSlash({ query: '', args: '', skillsOnly: true })
      setSlashActiveIndex(0)
      requestAnimationFrame(() => taRef.current?.focus())
      return
    }
    setSlash(null)
    setInput('')
    if (name === 'new') {
      onNewConversation?.()
      return
    }
    if (name === 'model') {
      setModelMenuRequest((current) => current + 1)
      return
    }
    if (name === 'runs' || name === 'trace') {
      eventBus.emit(EVENT_TYPES.OPEN_AGENT_REVIEW, { view: name === 'trace' ? 'trace' : 'runs', runId: null })
      return
    }
    if (name === 'compact') {
      if (!sessionId) {
        notifications.show({ color: 'gray', message: '新对话还没有可压缩的上下文' })
        return
      }
      // Immediately insert an animated "compacting" divider at the end of message stream.
      const divId = 'compact' + Date.now()
      setMessages((m) => [...m, { role: 'assistant', blocks: [{ id: divId, type: 'compact', content: '', title: 'running' }] }])
      scrollBottom()
      const settle = (content: string, drop = false) =>
        setMessages((m) =>
          drop
            ? m.filter((msg) => !(msg.blocks.length === 1 && msg.blocks[0].id === divId))
            : m.map((msg) =>
                msg.blocks.length === 1 && msg.blocks[0].id === divId
                  ? { ...msg, blocks: [{ id: divId, type: 'compact', content, title: 'done' }] }
                  : msg
              )
        )
      try {
        const res: any = await compactAgentSession(projectId, sessionId)
        if (res?.data?.compacted) {
          const { before, after } = res.data
          settle(before && after ? `上下文已压缩 · ${before} → ${after}` : '上下文已压缩')
        } else {
          settle('', true) // No compaction needed: remove divider.
          notifications.show({ color: 'gray', message: res?.message || '无需压缩' })
        }
      } catch {
          settle('', true) // Failure: remove divider (error shown by interceptor).
      }
    }
  }

  const applySlashSkill = (skill: SlashSkill) => {
    setSlash(null)
    setInput('')
    onSelectSkill?.(selectionFromCatalogSkill(skill))
    requestAnimationFrame(() => taRef.current?.focus())
  }

  const openTemplateGallery = async () => {
    setShowTemplateGallery(true)
    setTemplateGalleryLoading(true)
    try {
      const response: any = await getEnabledAppSkillsReq()
      const data = response?.data || response || []
      const items: any[] = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []
      const catalog = items.map(catalogSkill).filter((skill: SlashSkill | null): skill is SlashSkill => skill !== null)
      setTemplateSkills(catalog.filter((skill) => (
        skill.artifactTemplate?.gallery_kind === IMAGE_TEMPLATE_GALLERY_KIND
      )))
    } catch {
      notifications.show({ color: 'red', message: '图片模板读取失败，请重试' })
    } finally {
      setTemplateGalleryLoading(false)
    }
  }

  // Inline trigger hit: replace trigger + query text with selected item.
  const applyTrigger = (it: PickItem) => {
    if (!trigger) return
    const ta = taRef.current
    const caret = ta ? ta.selectionStart : trigger.start + 1 + trigger.query.length
    const repl = `${trigger.mode === 'file' ? '@' : '#'}${it.value} `
    const next = input.slice(0, trigger.start) + repl + input.slice(caret)
    setInput(next)
    setTrigger(null)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        const pos = trigger.start + repl.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  // ── Queue item actions ──
  const removeQ = async (id: string) => {
    const sid = sessionIdRef.current
    if (!sid) return
    try {
      await updateDshSessionQueueItem(projectId, sid, id, { kind: 'remove' })
    } catch (error: any) {
      notifications.show({ color: 'orange', title: '删除队列消息失败', message: error?.message || '请稍后重试。' })
    }
  }
  const startQEdit = (item: QueueItem) => {
    if (item.text == null) return
    setQEditing(item.id)
    setQDraft(item.text)
  }
  const commitQEdit = async () => {
    if (qEditing) {
      const id = qEditing
      const t = qDraft.trim()
      const sid = sessionIdRef.current
      const previous = queue.find((item) => item.id === id)?.text || ''
      if (sid && t && t !== previous) {
        try {
          await updateDshSessionQueueItem(projectId, sid, id, {
            kind: 'edit',
            input: [{ type: 'text', text: t }]
          })
        } catch (error: any) {
          notifications.show({ color: 'orange', title: '编辑队列消息失败', message: error?.message || '请稍后重试。' })
        }
      }
    }
    setQEditing(null)
  }
  const requestRecoveredRunStop = useCallback(() => {
    const runId = runtimeState.stopRunId
    if (!runId) {
      notifications.show({
        color: 'orange',
        title: '正在同步运行状态',
        message: '暂时还没有可停止的运行编号，请稍后重试。'
      })
      onAfterComplete?.()
      return
    }
    if (recoveredStopRequestRef.current === runId) return
    recoveredStopRequestRef.current = runId
    void stopAgentRun(runId)
      .then(async () => {
        if (selectedId && sessionIdRef.current === selectedId) {
          await hydratePersistedMessagesRef.current(selectedId).catch(() => null)
        }
        onAfterComplete?.()
      })
      .catch((error: any) => {
        notifications.show({
          color: 'red',
          title: '停止任务失败',
          message: error?.message || '请稍后重试。'
        })
        onAfterComplete?.()
      })
      .finally(() => {
        if (recoveredStopRequestRef.current === runId) recoveredStopRequestRef.current = null
      })
  }, [onAfterComplete, runtimeState.stopRunId, selectedId])

  useEffect(() => {
    if (localBusyForSelectedConversation || !runtimeState.recovered || !stopRef) return
    const recoveredStop = requestRecoveredRunStop
    stopRef.current = recoveredStop
    return () => {
      if (stopRef.current === recoveredStop) stopRef.current = null
    }
  }, [localBusyForSelectedConversation, requestRecoveredRunStop, runtimeState.recovered, stopRef])

  // Stop only interrupts the active DSH turn. The DSH-owned queue is unchanged.
  const stop = () => {
    if (runtimeState.recovered) requestRecoveredRunStop()
    else stopRef?.current?.()
  }

  // Promote one DSH queue item into the active turn without cancelling it.
  const sendNow = async (item: QueueItem) => {
    const sid = sessionIdRef.current
    if (!sid) return
    try {
      await updateDshSessionQueueItem(projectId, sid, item.id, { kind: 'steer' })
    } catch (error: any) {
      notifications.show({ color: 'orange', title: '立即补充失败', message: error?.message || '当前任务可能已经结束。' })
    }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && (trigger || slash)) {
      e.preventDefault()
      setTrigger(null)
      setSlash(null)
      return
    }
    if (slash && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      if (!visibleSlashItems.length) return
      const direction = e.key === 'ArrowDown' ? 1 : -1
      let next = slashActiveIndex
      for (let count = 0; count < visibleSlashItems.length; count += 1) {
        next = (next + direction + visibleSlashItems.length) % visibleSlashItems.length
        if (!visibleSlashItems[next]?.disabled) break
      }
      setSlashActiveIndex(next)
      return
    }
    // When slash command panel is open, Enter executes the highlighted item instead of sending a chat message.
    if (e.key === 'Enter' && !e.shiftKey && slash) {
      e.preventDefault()
      const item = visibleSlashItems[slashActiveIndex]
      if (!item) {
        notifications.show({ color: 'gray', message: '没有这个命令' })
        return
      }
      if (item.disabled) {
        notifications.show({ color: 'gray', message: item.reason || '当前不能执行这个命令' })
        return
      }
      if (item.kind === 'skill') applySlashSkill(item.skill)
      else void runSlash(item.command.name)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const composer = (
    <div
      className={styles.composer}
      data-drop-active={dropActive ? 'true' : undefined}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {dropActive && (
        <div className={styles.composerDropOverlay} aria-hidden="true">
          <span className={styles.composerDropIcons}>
            <IconFile size={18} stroke={1.8} />
            <IconFolder size={18} stroke={1.8} />
          </span>
          <span>松开以添加文件或文件夹</span>
        </div>
      )}
      {messages.length === 0 && workspaces.length > 0 && onSelectWorkspace && (
        <div className={styles.composerTop}>
          <WorkspacePicker
            workspaces={workspaces}
            activeWs={projectId}
            onSelect={onSelectWorkspace}
            onOpenFolder={onOpenFolder || (() => {})}
            onCreateProject={onCreateProject}
          />
        </div>
      )}
      {queue.length > 0 && (
        <div className={styles.queueList}>
          {queue.map((item) => (
            <div key={item.id} className={styles.queueItem}>
              {qEditing === item.id ? (
                <input
                  className={styles.queueEdit}
                  autoFocus
                  value={qDraft}
                  onChange={(e) => setQDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitQEdit()
                    else if (e.key === 'Escape') setQEditing(null)
                  }}
                  onBlur={commitQEdit}
                />
              ) : (
                <span className={styles.queueText}>{item.text || item.preview}</span>
              )}
              <button className={styles.queueNow} onClick={() => void sendNow(item)} title="立即补充到当前任务">
                <IconArrowUp size={13} stroke={2} />
                立即
              </button>
              <button className={styles.queueIcon} onClick={() => startQEdit(item)} title="编辑" disabled={item.text == null}>
                <IconPencil size={14} stroke={1.7} />
              </button>
              <button className={styles.queueIcon} onClick={() => void removeQ(item.id)} title="删除">
                <IconTrash size={14} stroke={1.7} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <>
          <div className={styles.attachList}>
            {attachments.map((a, i) => {
              const selectionLabel = artifactSelectionBadgeLabel(a)
              const selectionCount = attachmentArtifactSelections(a).length
              return <span
                key={`${a.path}-${i}`}
                className={styles.attachChip}
                title={selectionLabel ? `${a.path}\n${selectionLabel}` : a.path}
                data-artifact-id={a.artifactId || undefined}
                data-artifact-version-id={a.artifactVersionId || undefined}
                data-artifact-version-number={a.artifactVersionNumber || undefined}
                data-artifact-selection-count={selectionCount || undefined}
                data-artifact-selection-anchors={selectionCount
                  ? attachmentArtifactSelections(a).map((selection) => selection.anchor).join('\n')
                  : undefined}
                data-attachment-path={a.path}
                data-attachment-name={a.name}
              >
                <AttachmentPreview attachment={a} compact />
                <span className={styles.attachName}>{a.name}</span>
                {selectionLabel && (
                  <span className={styles.attachSelectionBadge} aria-label={selectionLabel}>
                    <span aria-hidden="true">#</span>{selectionLabel}
                  </span>
                )}
                <button
                  type="button"
                  className={styles.attachX}
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  title="移除附件"
                >
                  <IconX size={12} stroke={2} />
                </button>
              </span>
            })}
          </div>
          {attachments.some(isImageAttachment) && (
            <div className={styles.imagePrivacyHint}>图片将通过 DSH 发送；如果当前模型不支持，DSH 会拒绝本次发送</div>
          )}
        </>
      )}
      {selectedSkills.length > 0 && (
        <div className={styles.composerSkillList}>
          {selectedSkills.map((selectedSkill) => (
            <span
              key={selectedSkill.name}
              className={styles.composerSkillChip}
              title={isPersistentProjectSkill(selectedSkill) ? `此对话启用 ${selectedSkill.label}` : `本轮使用 ${selectedSkill.label}`}
            >
              <IconBox size={14} stroke={1.7} />
              <span>{selectedSkill.label}</span>
              <button type="button" onClick={() => onRemoveSelectedSkill?.(selectedSkill.name)} title="移除 Skill">
                <IconX size={12} stroke={2} />
              </button>
            </span>
          ))}
          {selectedSkills.some((skill) => skill.toolDependencies?.includes(IMAGE_GENERATION_TOOL)) && (
            <button type="button" className={styles.composerTemplateButton} onClick={() => void openTemplateGallery()}>
              <IconPhoto size={14} stroke={1.7} />
              模板
            </button>
          )}
        </div>
      )}
      {showTemplateGallery && (
        <div className={styles.composerTemplateGallery}>
          <div className={styles.composerTemplateHeader}>
            <strong>图片模板</strong>
            <button type="button" onClick={() => setShowTemplateGallery(false)} title="关闭"><IconX size={14} /></button>
          </div>
          <div className={styles.composerTemplateGrid}>
            {templateGalleryLoading && <span className={styles.composerTemplateState}>正在读取模板…</span>}
            {!templateGalleryLoading && templateSkills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                className={styles.composerTemplateCard}
                onClick={() => {
                  onSelectSkill?.(selectionFromCatalogSkill(skill))
                  setShowTemplateGallery(false)
                }}
              >
                {skill.artifactTemplate?.preview_path && (
                  <img src={imageSrcFromPath(skill.artifactTemplate.preview_path)} alt="" />
                )}
                <span>{skill.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {reviewComments.length > 0 && (
        <div className={styles.reviewCommentList} aria-label="待发送的审核意见">
          {reviewComments.map((comment) => (
            <span key={comment.id} className={styles.reviewCommentChip} title={comment.comment}>
              <span>{comment.path}:{comment.side === 'old' ? comment.oldLine : comment.newLine}</span>
              <button
                type="button"
                onClick={() => setReviewComments((items) => items.filter((item) => item.id !== comment.id))}
                title="移除审核意见"
              >
                <IconX size={12} stroke={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={styles.taWrap}>
        {trigger && (
          <MentionPicker
            mode={trigger.mode}
            projectId={projectId}
            sessionId={sessionId}
            conversations={conversations}
            query={trigger.query}
            onPick={applyTrigger}
            onClose={() => setTrigger(null)}
          />
        )}
        {slash && (
          <SlashMenu
            query={slash.query}
            hasSession={messages.length > 0}
            busy={effectiveBusy}
            hasProject={workspaces.some((workspace) => workspace.id !== CHAT_WS.id)}
            skills={slashSkills}
            skillsOnly={slash.skillsOnly}
            skillsStatus={slashSkillsStatus}
            activeIndex={slashActiveIndex}
            onActiveIndexChange={setSlashActiveIndex}
            onRun={(name) => void runSlash(name)}
            onSkill={applySlashSkill}
          />
        )}
        <textarea
          data-testid="agent-message-input"
          ref={taRef}
          className={styles.ta}
          rows={1}
          placeholder={effectiveBusy
            ? interactionMode === 'steer'
              ? '继续输入，内容会补充到当前任务…'
              : '继续输入，内容会加入下一轮…'
            : '聊天、处理文件，或安排一个多步任务…'}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onKeyDown={onKey}
        />
      </div>
      <div className={styles.composerBar}>
        <ComposerActions
          projectId={projectId}
          sessionId={sessionId}
          conversations={conversations}
          disabled={effectiveBusy}
          onAddAttachments={appendAttachments}
          onInsert={insertAtCursor}
        />
        <CollaborationModePicker
          value={collaborationMode}
          disabled={effectiveBusy || collaborationModeChanging}
          onChange={(mode) => void changeCollaborationMode(mode)}
        />
        {permissionSelect && (
          <PermissionPicker
            value={permissionSelect}
            disabled={effectiveBusy || permissionChanging}
            onChange={async (preset) => {
              const currentSessionId = sessionIdRef.current
              if (!currentSessionId || permissionChanging) return
              setPermissionChanging(true)
              try {
                const response: any = await setDshSessionPermission(projectId, currentSessionId, preset)
                if (sessionIdRef.current === currentSessionId) {
                  const state = response?.data as DshSessionProtocolState
                  applyDshQueueSnapshot(state)
                  applyDshPermissionSnapshot(state)
                  applyDshPlanSnapshot(state)
                }
              } catch (error: any) {
                notifications.show({
                  color: 'orange',
                  title: '未能更新 DSH 会话权限',
                  message: error?.message || '请检查当前 Profile 后重试。'
                })
              } finally {
                setPermissionChanging(false)
              }
            }}
          />
        )}
        <button
          type="button"
          className={styles.searchModeButton}
          data-search-mode={searchMode}
          disabled={effectiveBusy}
          title={searchMode === 'auto'
            ? '联网：自动判断。点击改为本轮必须联网'
            : searchMode === 'required'
              ? '联网：本轮必须搜索并引用来源。点击关闭'
              : '联网：已关闭。点击恢复自动判断'}
          onClick={() => setSearchMode((current) => current === 'auto' ? 'required' : current === 'required' ? 'off' : 'auto')}
        >
          <IconWorldSearch size={15} stroke={1.8} />
          <span>{searchMode === 'auto' ? '联网自动' : searchMode === 'required' ? '联网' : '不联网'}</span>
        </button>
        <div className={styles.spacer} />
        <ConversationModelSelector
          projectId={projectId}
          conversationId={sessionId}
          onChange={setModelRuntime}
          onOpenSettings={onOpenModelSettings}
          openRequest={modelMenuRequest}
        />
        <button
          data-testid="agent-send-button"
          className={styles.sendBtn}
          onClick={() => (effectiveBusy ? stop() : send())}
          disabled={!effectiveBusy && !input.trim() && attachments.length === 0 && reviewComments.length === 0}
          title={effectiveBusy ? '停止当前任务' : '发送'}
        >
          {effectiveBusy ? <IconPlayerStopFilled size={15} /> : <IconArrowUp size={17} stroke={2} />}
        </button>
      </div>
      <div className={styles.composerPluginDock} data-dsh-conversation-composer-dock />
    </div>
  )

  const conversationHeaderRuntime = (
    <div className={styles.conversationRuntime} data-running={effectiveBusy ? 'true' : undefined}>
      {headerDiff && <ChangesButton snapshot={headerDiff} onClick={() => openChanges(headerDiff.turnId)} />}
      {temporary && (
        <button type="button" className={styles.temporaryExit} onClick={onExitTemporary} disabled={effectiveBusy}>
          退出临时对话
        </button>
      )}
      {effectiveBusy && (
        <>
          <span className={styles.runtimeDot} aria-hidden="true" />
          <span>正在运行</span>
        </>
      )}
    </div>
  )

  return (
    <>
      {!shellHeader && (
        <header
          className={styles.conversationHeader}
          data-agent-session-id={sessionId || undefined}
          data-temporary={temporary ? 'true' : undefined}
        >
          <div className={styles.conversationIdentity}>
            {temporary
              ? <IconMessageOff size={14} stroke={1.75} aria-hidden="true" />
              : <IconFolder size={14} stroke={1.75} aria-hidden="true" />}
            <span className={styles.conversationWorkspace}>{workspaceName}</span>
            <IconChevronRight size={12} stroke={1.8} aria-hidden="true" />
            <span className={styles.conversationTitle} title={conversationTitle}>{conversationTitle}</span>
            {temporary && <span className={styles.temporaryBadge}>不保存</span>}
          </div>
          {conversationHeaderRuntime}
        </header>
      )}
      {shellHeader && shellHeaderActionsTarget && createPortal(
        conversationHeaderRuntime,
        shellHeaderActionsTarget
      )}
      {temporary && (
        <div className={styles.temporaryNotice} role="status">
          这段对话不会出现在历史记录中，也不会读取或写入任何对话记忆；退出后会清理本地任务记录。
        </div>
      )}
      {messages.length === 0 ? (
        <div
          className={styles.emptyWrap}
          data-conversation-state={selectedId ? conversationLoadState : 'new'}
        >
          <HomeWelcome
            prompt={temporary
              ? '开始临时对话'
              : selectedId
                ? conversationLoadState === 'error'
                  ? '对话加载失败'
                  : conversationLoadState === 'loading'
                    ? '正在加载对话…'
                    : '今天想处理什么？'
                : '今天想处理什么？'}
            subtitle={temporary
              ? '关闭后不保留对话记录'
              : selectedId
                ? conversationLoadState === 'error'
                  ? '请重新选择这条对话，或稍后再试'
                  : conversationLoadState === 'loading'
                    ? '正在读取已保存的消息'
                    : '可以聊天、查看图片、联网搜索，或处理本地文件'
                : '可以聊天、查看图片、联网搜索，或处理本地文件'}
            showCharacter={showAnimeHome && !selectedId && !temporary}
            composer={(!selectedId || temporary || conversationLoadState === 'idle') ? composer : undefined}
          />
        </div>
      ) : (
        <>
          <div className={styles.scroll} ref={scrollRef}>
            {markerBase.length > 1 && (
              <TurnLocator
                markers={markerBase}
                activeId={activeMarkerId}
                ariaLabel="对话轮次导航"
                showPreview
                onSelect={scrollToMarker}
              />
            )}
            <div
              className={styles.thread}
              ref={threadRef}
              data-virtual-message-list
              data-virtual-total-count={messages.length}
              style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
            >
              {virtualMessageItems.map((virtualRow) => {
                const m = messages[virtualRow.index]
                if (!m) return null
                const absoluteIndex = virtualRow.index
                const id = messageTurnId(m, absoluteIndex)
                return (
                  <div
                    key={virtualRow.key}
                    ref={messageVirtualizer.measureElement}
                    className={styles.virtualMessageRow}
                    data-index={virtualRow.index}
                    data-virtual-message-index={absoluteIndex}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {m.role === 'user' ? (
                  <UserTurn
                    id={id}
                    message={m}
                    busy={effectiveBusy}
                    temporary={temporary}
                    actionPending={Boolean(messageActionPending)}
                    onCopy={(text) => void copyMessage(text)}
                    onEdit={(target, text) => runMessageAction('edit', target, text)}
                  />
                ) : (
                  <AssistantTurn
                    id={id}
                    message={m}
                    busy={effectiveBusy}
                    isLast={absoluteIndex === messages.length - 1}
                    temporary={temporary}
                    actionPending={Boolean(messageActionPending)}
                    expanded={expanded}
                    showThinking={showThinking}
                    showTodo={showTodo}
                    confirmDecided={confirmDecided}
                    onDecide={decide}
                    onToggleExpand={toggleExpand}
                    onReviewChanges={() => openChanges(m.turnId)}
                    canMutateWorkspace={clientCapabilities.mutateWorkspace}
                    revertingItemIds={revertingItemIds}
                    onRevertChange={(block) => void revertFileChange(m, block)}
                    onSubmitUserInput={onSubmitUserInput}
                    onOpenConversation={onOpenConversation}
                    onOpenFileReference={onOpenFileReference}
                    onGenerativeUiAction={sendGenerativeUiAction}
                    onCopy={(text) => void copyMessage(text)}
                    onRetry={(target) => void runMessageAction('retry', target)}
                    onBranch={(target) => void runMessageAction('branch', target)}
                  />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <div className={styles.dock}>{composer}</div>
        </>
      )}
      {reviewSnapshot && (
        <ChangesReviewPanel
          snapshot={reviewSnapshot}
          onClose={() => setReviewTurnId(null)}
          onAddComment={addReviewComment}
          workspaceRoot={workspaceRoot}
          onApplyEdit={clientCapabilities.mutateWorkspace ? applyLineEdit : undefined}
          onReview={handleReview}
        />
      )}
    </>
  )
}

export default function AgentConversation(props: Props) {
  return <DshWorkAgentConversation {...props} />
}
