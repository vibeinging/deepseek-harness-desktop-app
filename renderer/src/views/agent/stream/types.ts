import type { Artifact, PlanStep, SkillTrace, ToolCall } from '@/layout/workstation/Workstation'

export interface AgentBlock {
  id: string
  type: string
  content: string
  title?: string
  display_type?: string
  metadata?: any
}

export interface AgentGenerativeUiMetadata {
  item_type: 'generativeUi'
  content_type: 'generative_ui'
  result_role: 'deliverable'
  surface_id?: string
  revision?: number
  replaces_item_id?: string | null
  document_hash?: string | null
  generative_ui?: {
    document?: unknown
    document_hash?: string | null
  }
  mode?: 'replace'
}

export interface AgentMessage {
  id?: string
  role: 'user' | 'assistant'
  blocks: AgentBlock[]
  skillSelections?: AgentSkillSelection[]
  workstationBlocks?: AgentBlock[]
  removedBlockIds?: string[]
  threadId?: string | null
  turnId?: string | null
  status?: AgentTurnStatus
  answerStatus?: 'accepted' | 'rejected' | 'missing' | string
  answerItemId?: string | null
  answerSource?: string | null
  answerRejectionCode?: string | null
  startedAtMs?: number | null
  completedAtMs?: number | null
  durationMs?: number | null
  error?: string | null
  turnDiff?: string | null
  workspaceActions?: Record<string, AgentWorkspaceAction>
}

export interface AgentSkillSelection {
  selectionKey: string
  name: string
  qualifiedName?: string | null
  displayName: string
  source?: string | null
  scope?: string | null
  pluginName?: string | null
  version?: string | null
  digest?: string | null
  selectionMode?: 'explicit' | string
}

export interface AgentWorkspaceAction {
  requestId: string
  action: 'revert_file_change'
  status: 'running' | 'succeeded' | 'failed'
  sessionId?: string
  turnId: string
  targetItemId?: string | null
  revertedPaths?: string[]
  currentDiff?: string | null
  completedAt?: string
}

export interface AgentFileReferenceAnnotation {
  id: string
  type: 'fileReference'
  range: { start: number; end: number; unit: 'unicodeCodePoint' }
  sourceRange?: { start: number; end: number; unit: 'unicodeCodePoint' }
  displayText?: string
  target: {
    workspaceId: string
    path: string
    lineStart?: number
    lineEnd?: number
    runtimeThreadId?: string | null
    turnId?: string | null
    messageItemId?: string | null
    blobHash?: string | null
    mediaKind?: 'video' | 'audio' | null
    mimeType?: string | null
    sizeBytes?: number | null
    selectedTextHash?: string | null
    contextBeforeHash?: string | null
    contextAfterHash?: string | null
  }
}

/** Exact Codex 0.147.0 TurnStatus values. */
export type CodexTurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed'
/** Host-only states; these are carried only by `dsh/*` extension events/history. */
export type DshTurnLifecycleStatus = 'pending' | 'suspended' | 'expired'
export type AgentTurnStatus = CodexTurnStatus | DshTurnLifecycleStatus

export interface DataWorkspaceEvent {
  type?: string
  event?: 'project_created' | 'project_data_preparing' | 'project_ready_for_query' | string
  source_tool?: string
  origin_project_id?: string | null
  session_id?: string | null
  project_id?: string
  project?: any
  conversation?: any
  automation_id?: string | null
  automation?: any
  artifact_id?: string | null
  artifact?: any
  canvas_id?: string | null
  canvas?: any
  open?: boolean
  connection_id?: string | null
  data_source_id?: string | null
  table_count?: number
  document_count?: number
  status?: string | null
  next_skill?: string | null
}

export interface AgentStreamEvent {
  type: string
  thread_id?: string | null
  turn_id?: string | null
  item_id?: string | null
  seq?: number
  ts?: string
  payload?: any
}

export interface AgentRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, any>
}

export interface AgentStreamTarget {
  threadId?: string | null
  turnId?: string | null
  itemId?: string | null
}

export interface AgentFileChange {
  path: string
  kind: string
  diff?: string | null
}

export interface AgentTurnDiffPatch extends AgentStreamTarget {
  diff: string
  diffHash?: string | null
}

export interface AgentTurnPatch extends AgentStreamTarget {
  messageId?: string | null
  status?: AgentTurnStatus
  answerStatus?: 'accepted' | 'rejected' | 'missing' | string
  answerItemId?: string | null
  answerSource?: string | null
  answerRejectionCode?: string | null
  startedAtMs?: number | null
  completedAtMs?: number | null
  durationMs?: number | null
  error?: string | null
}

export interface WorkstationPatch {
  plan?: PlanStep[]
  tool?: { id: string; value: ToolCall }
  toolResult?: { id: string; result: string }
  artifact?: { id: string; value: Artifact }
  skill?: { id: string; value: SkillTrace }
}

export interface AgentStreamPatch {
  block?: AgentBlock
  removeBlockId?: string
  workstation?: WorkstationPatch
  workspaceEvent?: DataWorkspaceEvent
  turnDiff?: AgentTurnDiffPatch
  target?: AgentStreamTarget
  turn?: AgentTurnPatch
  scrollDelayMs?: number
  ignored?: boolean
}

export interface WorkstationDraft {
  tools: Map<string, ToolCall>
  artifacts: Map<string, Artifact>
  skills: Map<string, SkillTrace>
  plan: PlanStep[]
}

export type { Artifact, PlanStep, SkillTrace, ToolCall }
