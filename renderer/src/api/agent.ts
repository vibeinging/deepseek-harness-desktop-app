// Agent 前端 API。对话流统一走 /api/agent 路由。
import request from '@/utils/axios-req'
import { subscribeStream, type StreamReq } from '@/utils/api-stream'
import { createAPIURL } from '@/utils/url-helper'
import { useConfigStore } from '@/store/config'

export interface AgentSession {
  id: string
  title: string
  status?: string
  temporary?: boolean
  latest_run_id?: string | null
  latest_run_status?: string | null
  latest_run_viewed_at?: string | null
  live_interaction_status?: string | null
  message_count?: number
  created_at?: string
  updated_at?: string
}

export type AgentConversationStatusEventType =
  | 'conversation_status.ready'
  | 'conversation_status.changed'
  | 'conversation_status.heartbeat'

export interface AgentConversationStatusEventPayload {
  event_id?: string | null
  server_instance_id?: string | null
  seq?: number | null
  project_id?: string | null
  session_id?: string | null
  run_id?: string | null
  reason?: string | null
  at?: string | null
}

export interface AgentConversationStatusEvent {
  type: AgentConversationStatusEventType
  payload: AgentConversationStatusEventPayload
}

// pid is a real project id or the global-chat sentinel; encode it as one URL segment.
const pe = (s: string) => encodeURIComponent(s)

// Create an agent session. Reuse the /sessions creation endpoint and use action_type='agentic_chat' for namespace isolation.
export const createAgentSession = (projectId: string, title: string, options?: { temporary?: boolean }) =>
  request({
    url: `/api/projects/${pe(projectId)}/sessions`,
    method: 'post',
    data: {
      title: title?.slice(0, 60) || '新对话',
      source_type: 'agent',
      source_id: projectId,
      action_type: 'agentic_chat',
      temporary: options?.temporary === true
    }
  })

export const cleanupTemporaryAgentSessions = () =>
  request({ url: '/api/sessions/temporary/cleanup', method: 'post', data: {}, ignoreMsg: true })

// List workspace history for this project: unified agent sessions
export const listAgentSessions = (projectId: string, params?: { archived?: boolean; silent?: boolean }) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/sessions`,
    method: 'get',
    params: params?.archived ? { archived: 1 } : undefined,
    ignoreMsg: params?.silent === true
  })

export const markAgentSessionViewed = (projectId: string, sessionId: string, runId: string) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/viewed`,
    method: 'post',
    data: { run_id: runId },
    ignoreMsg: true
  })

export interface AgentConversationSearchResult {
  session_id: string
  project_id: string
  title: string
  project_name: string
  status: string
  updated_at?: string | null
  match_type: 'title' | 'message'
  snippet: string
  role?: 'user' | 'assistant' | null
}

export interface AgentSearchFilters {
  projectId?: string
  sessionId?: string
  since?: string
  fileKinds?: AgentFileSearchResult['file_kind'][]
}

const agentSearchParams = (query: string, limit: number, filters?: AgentSearchFilters) => ({
  q: query,
  limit,
  ...(filters?.projectId ? { project_id: filters.projectId } : {}),
  ...(filters?.sessionId ? { session_id: filters.sessionId } : {}),
  ...(filters?.since ? { since: filters.since } : {}),
  ...(filters?.fileKinds?.length ? { file_kinds: filters.fileKinds.join(',') } : {})
})

export const searchAgentConversations = (query: string, limit = 40, filters?: AgentSearchFilters) =>
  request({
    url: '/api/agent/search/conversations',
    method: 'get',
    params: agentSearchParams(query, limit, filters),
    ignoreMsg: true
  })

export interface AgentFileSearchResult {
  project_id: string
  project_name: string
  session_id?: string | null
  session_title?: string | null
  root_id: string
  root_name: string
  root_kind: 'source_folder' | 'run_work' | 'run_artifacts'
  path: string
  name: string
  extension: string
  file_kind: 'image' | 'table' | 'document' | 'code' | 'file'
  size: number
  modified_at?: string | null
  match_type: 'name' | 'path' | 'content'
  match_types?: Array<'name' | 'path' | 'content'>
  snippet?: string
  line_number?: number | null
}

export const searchAgentFiles = (query: string, limit = 60, filters?: AgentSearchFilters) =>
  request({
    url: '/api/agent/search/files',
    method: 'get',
    params: agentSearchParams(query, limit, filters),
    ignoreMsg: true
  })

export interface AgentWebSourceSearchResult {
  source_id: string
  url: string
  canonical_url: string
  title: string
  site_name?: string
  published_at?: string | null
  accessed_at?: string | null
  excerpt?: string
  session_id: string
  session_title: string
  project_id: string
  project_name: string
  message_created_at?: string | null
}

export const searchAgentWebSources = (query: string, limit = 40, filters?: AgentSearchFilters) =>
  request({
    url: '/api/agent/search/web-sources',
    method: 'get',
    params: agentSearchParams(query, limit, filters),
    ignoreMsg: true
  })

export interface ProjectArtifactVersion {
  id: string
  artifact_id: string
  version_number: number
  snapshot_path: string
  snapshot_root?: string | null
  original_path?: string | null
  mime_type: string
  size_bytes: number
  sha256?: string | null
  change_summary?: string
  source_session_id?: string | null
  source_session_title?: string | null
  source_turn_id?: string | null
  source_run_id?: string | null
  source_item_id?: string | null
  source_tool_call_id?: string | null
  restored_from_version_id?: string | null
  created_by?: string | null
  created_at?: string | null
  metadata?: Record<string, unknown>
}

export interface ProjectArtifact {
  id: string
  project_id: string
  project_name: string
  name: string
  kind: string
  description?: string
  source_locator?: string | null
  current_version_id?: string | null
  current_version?: ProjectArtifactVersion | null
  version_count: number
  source_session_id?: string | null
  source_session_title?: string | null
  source_turn_id?: string | null
  source_run_id?: string | null
  source_item_id?: string | null
  source_tool_call_id?: string | null
  created_at?: string | null
  updated_at?: string | null
  versions?: ProjectArtifactVersion[]
  metadata?: Record<string, unknown>
}

export interface ProjectArtifactDiff {
  mode: 'text' | 'binary' | 'metadata' | 'identical'
  from: ProjectArtifactVersion
  to: ProjectArtifactVersion
  summary: string
  diff: string
  added_lines?: number
  removed_lines?: number
}

export interface ProjectArtifactVersionPreview {
  version: ProjectArtifactVersion
  preview: AgentFilePreview
}

export type OfficeArtifactFormat = 'markdown' | 'docx' | 'xlsx' | 'pptx' | 'pdf'

export interface OfficeArtifactCell {
  anchor: string
  address: string
  value: unknown
  display: string
  formula?: string | null
  value_type?: string | null
  style_id?: number | null
}

export interface OfficeArtifactSection {
  anchor: string
  kind: string
  text?: string
  style?: string
  index?: number
  can_replace_range?: boolean
  name?: string
  number?: number
  object_id?: string
  page?: number
  width?: number
  height?: number
  rotation?: number
  range?: string
  row_count?: number
  column_count?: number
  cells?: OfficeArtifactCell[]
  rows?: Array<{ index: number; cells: Array<{ anchor: string; kind: string; text: string; row: number; column: number }> }>
  objects?: Array<{
    anchor: string
    kind: string
    object_id?: string
    name?: string
    placeholder?: string
    text: string
    position?: { x: number; y: number; width: number; height: number }
    rotation?: number
    opacity?: number
    hidden?: boolean
    shape_type?: string | null
    style?: {
      fill_color?: string | null
      fill_mode?: string | null
      stroke_color?: string | null
      stroke_width?: number | null
      text_color?: string | null
      font_family?: string | null
      font_size?: number | null
      bold?: boolean
      italic?: boolean
      underline?: boolean
      align?: string | null
    }
    table_data?: {
      rows: Array<{ cells: Array<{ text: string }> }>
      row_count: number
      column_count: number
      truncated: boolean
    } | null
    chart_data?: {
      title: string
      chart_type: string
      categories: string[]
      series: Array<{ name: string; values: number[]; color?: string | null }>
      truncated: boolean
    } | null
    can_replace_range?: boolean
    editable_operations?: string[]
  }>
  notes?: { anchor: string; text: string } | null
  layout_name?: string
  hidden?: boolean
  background?: { color?: string | null; gradient?: string | null; has_image?: boolean }
  preview_svg?: string | null
  annotations?: Array<{
    id: string
    page: number
    rect?: { x: number; y: number; width: number; height: number } | null
    text: string
    color: string
    type: string
  }>
  size?: { width: number; height: number }
  truncated?: boolean
}

export interface OfficeArtifactDocument {
  format: OfficeArtifactFormat
  sections: OfficeArtifactSection[]
  capabilities: Record<string, unknown>
  warnings: string[]
}

export interface ProjectOfficeArtifactInspection {
  artifact: ProjectArtifact
  version: ProjectArtifactVersion
  document: OfficeArtifactDocument
}

export interface OfficeArtifactOperation {
  type: string
  anchor?: string
  text?: string
  start?: number | string
  end?: number
  sheet?: string
  address?: string
  value?: unknown
  formula?: string
  values?: unknown[][]
  page?: number
  rect?: { x: number; y: number; width: number; height: number }
  color?: string
  position?: number
  row?: number
  column?: number
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
  opacity?: number
  hidden?: boolean
  fill_color?: string
  stroke_color?: string
  stroke_width?: number
  text_color?: string
  font_family?: string
  font_size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: 'left' | 'center' | 'right' | 'justify'
  title?: string
  categories?: string[]
  series?: Array<{ name: string; values: number[]; color?: string }>
}

export interface ProjectOfficeArtifactDiff {
  format: OfficeArtifactFormat
  from: ProjectArtifactVersion
  to: ProjectArtifactVersion
  summary: string
  truncated: boolean
  changes: Array<{ anchor: string; type: 'added' | 'removed' | 'changed'; before: unknown; after: unknown }>
}

export const searchAgentArtifacts = (query: string, limit = 60, filters?: AgentSearchFilters) =>
  request({
    url: '/api/agent/search/artifacts',
    method: 'get',
    params: agentSearchParams(query, limit, filters),
    ignoreMsg: true
  })

export const listProjectArtifacts = (
  projectId: string,
  filters?: { query?: string; kind?: string; since?: string; limit?: number }
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts`,
  method: 'get',
  params: {
    ...(filters?.query ? { q: filters.query } : {}),
    ...(filters?.kind && filters.kind !== 'all' ? { kind: filters.kind } : {}),
    ...(filters?.since ? { since: filters.since } : {}),
    ...(filters?.limit ? { limit: filters.limit } : {})
  },
  ignoreMsg: true
})

export const createProjectArtifact = (
  projectId: string,
  input: {
    rootId: string
    path: string
    sessionId?: string | null
    artifactId?: string
    name?: string
    kind?: string
    description?: string
    changeSummary?: string
    temporary?: boolean
  }
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts`,
  method: 'post',
  data: {
    root_id: input.rootId,
    path: input.path,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.artifactId ? { artifact_id: input.artifactId } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.changeSummary ? { change_summary: input.changeSummary } : {}),
    ...(input.temporary ? { temporary: true } : {})
  }
})

export const createProjectOfficeArtifact = (
  projectId: string,
  input: {
    format: OfficeArtifactFormat
    name?: string
    title?: string
    content?: string
    description?: string
    specification?: Record<string, unknown>
    sessionId?: string | null
    temporary?: boolean
  }
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts/office`,
  method: 'post',
  data: {
    format: input.format,
    ...(input.name ? { name: input.name } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.content ? { content: input.content } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.specification ? { specification: input.specification } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.temporary ? { temporary: true } : {})
  }
})

export const getProjectArtifact = (projectId: string, artifactId: string) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}`,
    method: 'get',
    ignoreMsg: true
  })

export const previewProjectArtifactVersion = (projectId: string, artifactId: string, versionId: string) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}/versions/${pe(versionId)}/preview`,
    method: 'get',
    ignoreMsg: true
  })

export const inspectProjectOfficeArtifact = (projectId: string, artifactId: string, versionId?: string | null) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}/office`,
    method: 'get',
    params: versionId ? { version_id: versionId } : {},
    ignoreMsg: true
  })

export const editProjectOfficeArtifact = (
  projectId: string,
  artifactId: string,
  input: {
    baseVersionId: string
    operations: OfficeArtifactOperation[]
    changeSummary?: string
    sessionId?: string | null
    temporary?: boolean
  }
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}/office/edits`,
  method: 'post',
  data: {
    base_version_id: input.baseVersionId,
    operations: input.operations,
    ...(input.changeSummary ? { change_summary: input.changeSummary } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.temporary ? { temporary: true } : {})
  }
})

export const compareProjectOfficeArtifactVersions = (
  projectId: string,
  artifactId: string,
  fromVersionId: string,
  toVersionId?: string | null
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}/office/diff`,
  method: 'get',
  params: {
    from_version_id: fromVersionId,
    ...(toVersionId ? { to_version_id: toVersionId } : {})
  },
  ignoreMsg: true
})

export const compareProjectArtifactVersions = (
  projectId: string,
  artifactId: string,
  fromVersionId: string,
  toVersionId?: string | null
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}/diff`,
  method: 'get',
  params: {
    from_version_id: fromVersionId,
    ...(toVersionId ? { to_version_id: toVersionId } : {})
  },
  ignoreMsg: true
})

export const restoreProjectArtifactVersion = (
  projectId: string,
  artifactId: string,
  versionId: string,
  sessionId?: string | null,
  temporary = false
) => request({
  url: `/api/agent/projects/${pe(projectId)}/artifacts/${pe(artifactId)}/restore`,
  method: 'post',
  data: {
    version_id: versionId,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(temporary ? { temporary: true } : {})
  }
})

export interface AgentCanvasVersion {
  id: string
  canvas_id: string
  version_number: number
  size_bytes: number
  sha256?: string | null
  change_summary?: string | null
  parent_version_id?: string | null
  restored_from_version_id?: string | null
  source_type?: 'assistant' | 'user' | 'tool' | 'restore' | string | null
  source_turn_id?: string | null
  source_run_id?: string | null
  source_item_id?: string | null
  source_tool_call_id?: string | null
  created_at?: string | null
  metadata?: Record<string, unknown>
}

export interface AgentCanvasSuggestion {
  id: string
  canvas_id: string
  base_version_id: string
  start_offset: number
  end_offset: number
  selected_text: string
  selected_text_hash: string
  replacement_text: string
  instruction?: string | null
  status: 'pending' | 'accepted' | 'rejected' | 'stale' | string
  accepted_version_id?: string | null
  source_turn_id?: string | null
  source_run_id?: string | null
  source_item_id?: string | null
  source_tool_call_id?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface AgentCanvas {
  id: string
  session_id: string
  session_title?: string | null
  project_id: string
  title: string
  kind: 'document' | 'code' | 'site'
  language?: string | null
  current_version_id: string
  current_version: AgentCanvasVersion
  version_count: number
  pending_suggestion_count: number
  source_message_id?: string | null
  source_item_id?: string | null
  source_turn_id?: string | null
  source_run_id?: string | null
  content?: string
  versions?: AgentCanvasVersion[]
  suggestions?: AgentCanvasSuggestion[]
  created_at?: string | null
  updated_at?: string | null
  metadata?: Record<string, unknown>
}

export const listAgentCanvases = (sessionId: string, limit = 100) =>
  request({
    url: `/api/agent/sessions/${pe(sessionId)}/canvases`,
    method: 'get',
    params: { limit },
    ignoreMsg: true
  })

export const createAgentCanvas = (
  sessionId: string,
  input: { title?: string; kind?: 'document' | 'code' | 'site'; language?: string; content?: string; changeSummary?: string }
) => request({
  url: `/api/agent/sessions/${pe(sessionId)}/canvases`,
  method: 'post',
  ignoreMsg: true,
  data: {
    ...(input.title ? { title: input.title } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.language ? { language: input.language } : {}),
    content: input.content || '',
    ...(input.changeSummary ? { change_summary: input.changeSummary } : {})
  }
})

export const getAgentCanvas = (sessionId: string, canvasId: string) =>
  request({
    url: `/api/agent/sessions/${pe(sessionId)}/canvases/${pe(canvasId)}`,
    method: 'get',
    ignoreMsg: true
  })

export const getAgentCanvasVersion = (sessionId: string, canvasId: string, versionId: string) =>
  request({
    url: `/api/agent/sessions/${pe(sessionId)}/canvases/${pe(canvasId)}/versions/${pe(versionId)}`,
    method: 'get',
    ignoreMsg: true
  })

export const editAgentCanvas = (
  sessionId: string,
  canvasId: string,
  input: { baseVersionId: string; content: string; changeSummary?: string }
) => request({
  url: `/api/agent/sessions/${pe(sessionId)}/canvases/${pe(canvasId)}/edits`,
  method: 'post',
  ignoreMsg: true,
  data: {
    base_version_id: input.baseVersionId,
    content: input.content,
    ...(input.changeSummary ? { change_summary: input.changeSummary } : {})
  }
})

export const restoreAgentCanvasVersion = (
  sessionId: string,
  canvasId: string,
  input: { baseVersionId: string; versionId: string; changeSummary?: string }
) => request({
  url: `/api/agent/sessions/${pe(sessionId)}/canvases/${pe(canvasId)}/restore`,
  method: 'post',
  ignoreMsg: true,
  data: {
    base_version_id: input.baseVersionId,
    version_id: input.versionId,
    ...(input.changeSummary ? { change_summary: input.changeSummary } : {})
  }
})

export const decideAgentCanvasSuggestion = (
  sessionId: string,
  canvasId: string,
  suggestionId: string,
  decision: 'accept' | 'reject'
) => request({
  url: `/api/agent/sessions/${pe(sessionId)}/canvases/${pe(canvasId)}/suggestions/${pe(suggestionId)}/decision`,
  method: 'post',
  ignoreMsg: true,
  data: { decision }
})

export interface ProjectChatMemoryConversation {
  id: string
  title: string
  status: string
  message_count: number
  updated_at?: string | null
  excluded: boolean
}

export interface ProjectChatMemoryState {
  project_id: string
  project_name: string
  enabled: boolean
  source_conversations: ProjectChatMemoryConversation[]
  eligible_count: number
  excluded_count: number
}

export const getProjectChatMemory = (projectId: string) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/chat-memory`, method: 'get', ignoreMsg: true })

export const updateProjectChatMemory = (projectId: string, enabled: boolean) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/chat-memory`, method: 'put', data: { enabled } })

export const excludeProjectChatMemoryConversation = (projectId: string, sessionId: string) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/chat-memory/exclusions/${pe(sessionId)}`,
    method: 'post',
    data: {}
  })

export const includeProjectChatMemoryConversation = (projectId: string, sessionId: string) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/chat-memory/exclusions/${pe(sessionId)}`,
    method: 'delete'
  })

export interface GlobalChatMemorySettings {
  saved_memory_enabled: boolean
  chat_history_enabled: boolean
}

export interface GlobalChatMemoryEntry {
  id: string
  content: string
  source_type: 'manual' | string
  source_session_id?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface GlobalChatMemoryConversation {
  id: string
  title: string
  status: string
  message_count: number
  updated_at?: string | null
  excluded: boolean
}

export interface GlobalChatMemoryAuditItem {
  id: string
  action: string
  target_type: string
  target_id?: string | null
  details: Record<string, unknown>
  created_at?: string | null
}

export interface GlobalChatMemoryState {
  settings: GlobalChatMemorySettings
  entries: GlobalChatMemoryEntry[]
  source_conversations: GlobalChatMemoryConversation[]
  audit: GlobalChatMemoryAuditItem[]
}

export const getGlobalChatMemory = () =>
  request({ url: '/api/agent/chat-memory', method: 'get', ignoreMsg: true })

export const updateGlobalChatMemory = (settings: Partial<GlobalChatMemorySettings>) =>
  request({ url: '/api/agent/chat-memory', method: 'put', data: settings })

export const createGlobalChatMemoryEntry = (content: string) =>
  request({ url: '/api/agent/chat-memory/entries', method: 'post', data: { content } })

export const updateGlobalChatMemoryEntry = (entryId: string, content: string) =>
  request({ url: `/api/agent/chat-memory/entries/${pe(entryId)}`, method: 'put', data: { content } })

export const deleteGlobalChatMemoryEntry = (entryId: string) =>
  request({ url: `/api/agent/chat-memory/entries/${pe(entryId)}`, method: 'delete' })

export const excludeGlobalChatMemoryConversation = (sessionId: string) =>
  request({ url: `/api/agent/chat-memory/exclusions/${pe(sessionId)}`, method: 'post', data: {} })

export const includeGlobalChatMemoryConversation = (sessionId: string) =>
  request({ url: `/api/agent/chat-memory/exclusions/${pe(sessionId)}`, method: 'delete' })

export interface AgentTraceSpan {
  id: string
  parentId?: string | null
  externalTraceId?: string | null
  externalSpanId?: string | null
  externalParentSpanId?: string | null
  externalSessionId?: string | null
  kind: string
  name: string
  status: string
  depth: number
  order?: number | null
  startMs?: number
  durMs: number
  cost?: number
  inTok?: number
  outTok?: number
  model?: string | null
  input?: string
  output?: string
  logs?: string[]
  attrs?: Record<string, unknown>
}

export interface AgentTraceDetail {
  traceId: string
  externalTraceId?: string | null
  name: string
  status: string
  durMs: number
  cost: number
  spanCount: number
  spans: AgentTraceSpan[]
}

export interface AgentTraceRun {
  runId: string
  sessionId: string
  projectId?: string | null
  userId?: string | null
  status?: string | null
  skill?: string | null
  mode?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  finishedAt?: string | null
  question?: {
    questionNo: number
    questionMessageId?: string | null
    questionText: string
    sequenceNumber?: number
    createdAt?: string | null
  } | null
  trace?: AgentTraceDetail | null
}

export interface AgentSessionTraceResponse {
  enabled: boolean
  dataDir?: string
  session?: any
  items: AgentTraceRun[]
}

export const getAgentSessionTraces = (projectId: string, sessionId: string, limit = 20) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/traces`,
    method: 'get',
    params: { limit },
    ignoreMsg: true
  })

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user_input'
  | 'interrupted'
  | 'failed'
  | 'completed'
  | 'recovering'
  | 'expired'

export interface AgentRunSummary {
  id: string
  session_id: string
  project_id?: string | null
  status: AgentRunStatus | string
  skill_name?: string | null
  mode?: string | null
  recoverable?: number | boolean
  live?: boolean
  created_at?: string | null
  updated_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  archived_at?: string | null
  archived_by?: string | null
  checkpoint?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface AgentRunEvent {
  id: string
  seq: number
  event_type: string
  status?: string | null
  call_id?: string | null
  tool_name?: string | null
  output_summary?: string | null
  error_code?: string | null
  error_message?: string | null
  created_at?: string | null
  metadata?: Record<string, unknown>
}

export interface AgentNativeSubagent {
  thread_id: string
  parent_thread_id?: string | null
  call_id?: string | null
  title: string
  tool?: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | string | null
  prompt?: string | null
  model?: string | null
  reasoning_effort?: string | null
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'not_found' | string
  message?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface AgentRunToolCall {
  id: string
  call_id: string
  tool_name: string
  access_mode?: string | null
  status: string
  attempt_count?: number
  input?: unknown
  result?: unknown
  error_code?: string | null
  error_message?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface AgentRunArtifact {
  id: string
  kind?: string | null
  path?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  created_at?: string | null
  metadata?: Record<string, unknown>
}

export interface AgentEvidenceBundleRef {
  id: string
  final_item_id?: string | null
  status?: 'verified' | 'evidence_available' | 'needs_attention' | 'unverified' | string
  snapshot_hash?: string | null
}

export interface AgentEvidenceBundle extends AgentEvidenceBundleRef {
  version: string
  run_id: string
  turn_id?: string | null
  session_id: string
  project_id?: string | null
  answer?: { item_id?: string; text?: string; text_hash?: string }
  evidence?: Array<{
    evidence_id?: string
    produced_by?: string
    tool_call_id?: string | null
    source?: Record<string, any>
    statement?: { language?: string; text?: string; parameters?: unknown[] }
    schema?: Record<string, any>
    result?: Record<string, any>
    timing?: Record<string, any>
  }>
  validations?: Array<{
    validation_id?: string
    evidence_id?: string
    status?: string
    summary?: { total?: number; passed?: number; failed?: number }
    checks?: Array<{ name?: string; passed?: boolean; severity?: string; detail?: Record<string, any> }>
  }>
  tool_calls?: AgentRunToolCall[]
  approvals?: Array<{ id?: string; request_id?: string; status?: string; request?: any; response?: any }>
  artifacts?: AgentRunArtifact[]
  uncertainty?: { has_uncertainty?: boolean; items?: Array<Record<string, any>> }
  metadata?: Record<string, any>
  created_at?: string | null
  updated_at?: string | null
}

export interface AgentEvidenceBundleSummary extends AgentEvidenceBundleRef {
  bundle_version?: string
  created_at?: string | null
}

export interface AgentEvidenceRerunComparison {
  version: string
  mode: string
  baseline_bundle_id?: string | null
  rerun_bundle_id?: string | null
  summary: {
    identical: boolean
    query_count: number
    changed_query_count: number
    validation_count: number
    changed_validation_count: number
    schema_changed: boolean
    data_changed: boolean
  }
  queries: Array<{
    baseline_evidence_id?: string | null
    current_evidence_id?: string | null
    source_changed: boolean
    statement_changed: boolean
    schema_changed: boolean
    data_changed: boolean
    columns_changed: boolean
    status: { before?: string | null; after?: string | null }
    row_count: { before: number; after: number; delta: number }
    data_hash: { before?: string | null; after?: string | null }
    numeric_summary: Record<string, {
      before?: Record<string, number> | null
      after?: Record<string, number> | null
      sum_delta?: number | null
      changed: boolean
    }>
  }>
  validations: Array<{
    baseline_validation_id?: string | null
    current_validation_id?: string | null
    status: { before?: string | null; after?: string | null }
    failed_checks: { before: string[]; after: string[] }
    changed: boolean
  }>
}

export interface AgentEvidenceRerunResult {
  run_id: string
  baseline_bundle_id: string
  rerun_bundle: AgentEvidenceBundle
  comparison: AgentEvidenceRerunComparison
}

export interface AgentRunDetail {
  run: AgentRunSummary
  events: AgentRunEvent[]
  subagents?: AgentNativeSubagent[]
  tools: AgentRunToolCall[]
  artifacts: AgentRunArtifact[]
  evidence_bundles?: AgentEvidenceBundleSummary[]
  query_execution?: {
    id: string
    status: string
    root_question?: string | null
    delegated_call_count: number
    plan_revision: number
    created_at: string
    updated_at: string
  } | null
  query_tasks?: Array<{
    id: string
    title: string
    status: string
    proposed_dependencies: string[]
    actual_dependencies: string[]
  }>
  query_artifacts?: Array<{
    id: string
    producer_task_id: string
    kind: string
    name: string
    locator: string
    source_type?: string | null
    source_name?: string | null
    evidence_refs: any[]
    metadata: Record<string, unknown>
  }>
  query_task_edges?: Array<{
    id: string
    from_task_id: string
    to_task_id: string
    artifact_id: string
    relation: string
  }>
  subtasks?: Array<{
    id: string
    run_id: string
    call_id: string
    subtask_type: string
    task_id?: string | null
    step_index?: number | null
    title: string
    source_kind?: string
    source_name?: string
    depends_on?: string[]
    actual_depends_on?: string[]
    output_alias?: string
    tool_name?: string | null
    status: string
    read_only: number | boolean
    parallel_eligible: number | boolean
    parallel_group?: string | null
    tool_allowlist: string[]
    tool_calls?: Array<{ call_id: string; tool_name: string; status: string; started_at?: string; finished_at?: string }>
    input_snapshot: any
    result_snapshot: any
    evidence_refs: any[]
    validation_refs: any[]
    error_code?: string | null
    error_message?: string | null
    created_at: string
  }>
}

export interface AgentRunDeletionImpact {
  run_id: string
  status: string
  impact_hash: string
  evidence_protected: boolean
  workspace: { path: string; bytes: number; files: number; directories: number; symlinks: number }
  facts: { events: number; tools: number; artifacts: number; pending_inputs: number; evidence_bundles: number; subtasks: number; query_tasks?: number; query_artifacts?: number }
  internal_artifacts: number
  external_artifacts_preserved: number
}

export const listAgentRuns = (projectId: string, sessionId?: string | null, limit = 30) =>
  request({
    url: `/api/agents/projects/${pe(projectId)}/runs`,
    method: 'get',
    params: { limit, ...(sessionId ? { session_id: sessionId } : {}) },
    ignoreMsg: true
  })

export const getAgentRun = (runId: string) =>
  request({ url: `/api/agents/runs/${pe(runId)}`, method: 'get', ignoreMsg: true })

export const getAgentSubagentThread = (runId: string, threadId: string) =>
  request({
    url: `/api/agents/runs/${pe(runId)}/subagents/${pe(threadId)}`,
    method: 'get',
    ignoreMsg: true
  })

export const stopAgentSubagentThread = (runId: string, threadId: string) =>
  request({
    url: `/api/agents/runs/${pe(runId)}/subagents/${pe(threadId)}/stop`,
    method: 'post',
    data: {}
  })

export const listAgentEvidenceBundles = (runId: string) =>
  request({ url: `/api/agents/runs/${pe(runId)}/evidence-bundles`, method: 'get', ignoreMsg: true })

export const getAgentEvidenceBundle = (bundleId: string) =>
  request({ url: `/api/agents/evidence-bundles/${pe(bundleId)}`, method: 'get', ignoreMsg: true })

export const rerunAgentEvidenceBundle = (bundleId: string) =>
  request({ url: `/api/agents/evidence-bundles/${pe(bundleId)}/rerun`, method: 'post', data: {}, ignoreMsg: true })

export const stopAgentRun = (runId: string) =>
  request({ url: `/api/agents/runs/${pe(runId)}/stop`, method: 'post' })

export const recoverAgentRun = (runId: string) =>
  request({ url: `/api/agents/runs/${pe(runId)}/recover`, method: 'post', data: { dispatch: true } })

export const archiveAgentRun = (runId: string) =>
  request({ url: `/api/agents/runs/${pe(runId)}/archive`, method: 'post', data: {} })

export const getAgentRunDeletionImpact = (runId: string) =>
  request({ url: `/api/agents/runs/${pe(runId)}/deletion-impact`, method: 'get', ignoreMsg: true })

export const deleteAgentRun = (runId: string, impactHash: string, force = false) =>
  request({
    url: `/api/agents/runs/${pe(runId)}`,
    method: 'delete',
    data: { impact_hash: impactHash, force }
  })

export interface AgentAutomationSchedule {
  type: 'manual' | 'once' | 'interval' | 'daily' | 'weekly' | 'rrule' | 'event'
  interval_minutes?: number
  anchor_at?: string
  run_at?: string
  local_at?: string
  time?: string
  weekday?: number
  timezone?: string
  rrule?: string
  dtstart?: string
  event_name?: string
  debounce_seconds?: number
  match?: Record<string, unknown>
  missed_policy?: AgentAutomationMissedPolicy
}

export interface AgentAutomationMissedPolicy {
  mode: 'run_once' | 'skip' | 'within_grace'
  grace_minutes?: number
}

export interface AgentAutomationSkillSnapshot {
  name: string
  qualified_name: string
  version?: string | null
  digest?: string | null
  source?: string | null
  scope?: string | null
  plugin_name?: string | null
  plugin_version?: string | null
  required_tools?: string[]
}

export interface AgentAutomation {
  id: string
  version: string
  project_id: string
  destination: { type: 'standalone' | 'conversation'; session_id?: string | null }
  name: string
  prompt: string
  skills: string[]
  skill_snapshot: AgentAutomationSkillSnapshot[]
  model_id?: string | null
  model_name?: string | null
  reasoning_effort?: string | null
  schedule: AgentAutomationSchedule
  missed_policy: AgentAutomationMissedPolicy
  monitor_policy: { mode: 'always' | 'change_only' }
  sandbox_policy: { mode?: string; system_enforced?: boolean; network?: string; write_scope?: string }
  snapshot_policy: { strategy?: string }
  notification_policy: { inbox?: boolean; on_success?: boolean; on_failure?: boolean; on_attention?: boolean }
  permission_policy: { unattended_action?: string; allow_saved_narrow_rules?: boolean }
  status: 'enabled' | 'paused' | 'completed'
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  consecutive_failures: number
  max_consecutive_failures: number
  created_at: string
  updated_at: string
}

export interface AgentAutomationPendingAction {
  request_id: string
  action_type: 'approval' | 'user_input' | string
  payload?: Record<string, unknown>
  resume_handle?: Record<string, unknown> | null
  resume_expires_at?: string | null
  created_at?: string | null
}

export interface AgentAutomationRun {
  id: string
  automation_id: string
  run_id?: string | null
  project_id: string
  session_id?: string | null
  status: 'running' | 'completed' | 'failed' | 'needs_attention' | string
  inbox_status: 'unread' | 'read'
  requires_attention: boolean
  summary?: string | null
  error_code?: string | null
  error_message?: string | null
  evidence_bundle_id?: string | null
  trigger_type?: 'manual' | 'scheduled' | 'event' | string
  scheduled_for?: string | null
  trigger?: Record<string, unknown>
  event_id?: string | null
  change_status?: 'reported' | 'first_result' | 'changed' | 'unchanged' | string | null
  output_fingerprint?: string | null
  skill_snapshot?: AgentAutomationSkillSnapshot[]
  pending_action?: AgentAutomationPendingAction | null
  started_at?: string | null
  finished_at?: string | null
  created_at: string
  updated_at: string
}

export interface AgentAutomationInput {
  name: string
  prompt: string
  destination?: { type: 'standalone' | 'conversation'; session_id?: string | null }
  skills?: string[]
  model_id?: string | null
  model_name?: string | null
  reasoning_effort?: string | null
  schedule: AgentAutomationSchedule
  missed_policy?: AgentAutomationMissedPolicy
  monitor_policy?: { mode: 'always' | 'change_only' }
  status?: 'enabled' | 'paused' | 'completed'
  max_consecutive_failures?: number
}

export const listAgentAutomations = (projectId: string) =>
  request({ url: `/api/agents/projects/${pe(projectId)}/automations`, method: 'get', ignoreMsg: true })

export const createAgentAutomation = (projectId: string, input: AgentAutomationInput) =>
  request({ url: `/api/agents/projects/${pe(projectId)}/automations`, method: 'post', data: input })

export const updateAgentAutomation = (automationId: string, input: Partial<AgentAutomationInput>) =>
  request({ url: `/api/agents/automations/${pe(automationId)}`, method: 'put', data: input })

export const setAgentAutomationStatus = (automationId: string, status: 'enabled' | 'paused') =>
  request({ url: `/api/agents/automations/${pe(automationId)}/status`, method: 'post', data: { status } })

export const runAgentAutomation = (automationId: string) =>
  request({ url: `/api/agents/automations/${pe(automationId)}/run`, method: 'post', data: {}, ignoreMsg: true })

export const deleteAgentAutomation = (automationId: string) =>
  request({ url: `/api/agents/automations/${pe(automationId)}`, method: 'delete' })

export const listAgentAutomationRuns = (projectId: string) =>
  request({ url: `/api/agents/projects/${pe(projectId)}/automation-runs`, method: 'get', ignoreMsg: true })

export const markAgentAutomationRunRead = (runId: string) =>
  request({ url: `/api/agents/automation-runs/${pe(runId)}/read`, method: 'post', data: {}, ignoreMsg: true })

export const markAllAgentAutomationRunsRead = (projectId: string) =>
  request({ url: `/api/agents/projects/${pe(projectId)}/automation-runs/read-all`, method: 'post', data: {}, ignoreMsg: true })

export const publishAgentAutomationEvent = (projectId: string, input: {
  event_name: string
  event_key?: string
  payload?: Record<string, unknown>
  occurred_at?: string
}) => request({ url: `/api/agents/projects/${pe(projectId)}/automation-events`, method: 'post', data: input })

export interface AgentNativePendingInteractionBlock {
  id: string
  type: 'confirm' | 'user_input'
  content: string
  title?: string | null
  metadata?: Record<string, unknown> | null
}

export interface AgentNativePendingInteraction {
  version: 1
  kind: string
  status: 'pending'
  request_id: string
  run_id: string
  session_id: string
  resolution: {
    type: 'native_turn'
    thread_id: string
    turn_id: string
    item_id: string
  }
  block: AgentNativePendingInteractionBlock
  created_at: string
}

export interface AgentMessagesData {
  messages: unknown[]
  pending_interactions?: AgentNativePendingInteraction[]
}

export interface AgentMessagesResponse {
  success?: boolean
  data: AgentMessagesData
}

// Read historical messages and ephemeral native interactions for an agent session.
export const getAgentMessages = (projectId: string, sessionId: string): Promise<AgentMessagesResponse> =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}/messages`, method: 'get' })

export type AgentMessageBranchMode = 'branch' | 'retry' | 'edit'

export interface AgentMessageBranchAttachment {
  path: string
  name: string
  is_dir?: boolean
  mime_type?: string | null
  size_bytes?: number | null
  width?: number | null
  height?: number | null
}

export interface AgentMessageBranchResult {
  session: AgentSession
  messages: unknown[]
  mode: AgentMessageBranchMode
  runtime_thread_id: string
  boundary_turn_id: string
  draft?: {
    text: string
    attachments: AgentMessageBranchAttachment[]
    input?: AgentTurnInput[] | null
    request?: {
      model?: string | null
      effort?: string | null
      summary?: string | null
      verbosity?: string | null
      approvalMode?: 'ask' | 'auto' | 'full'
      searchMode?: 'auto' | 'required' | 'off'
      collaborationMode?: 'default' | 'plan'
      skills?: string[]
    }
  } | null
}

export const branchAgentMessage = (
  projectId: string,
  sessionId: string,
  messageId: string,
  mode: AgentMessageBranchMode
) => request({
  url: `/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/messages/${pe(messageId)}/branch`,
  method: 'post',
  data: { mode }
})

// Rename an agent session (reuse PUT /sessions/:sid)
export const renameAgentSession = (projectId: string, sessionId: string, title: string) =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}`, method: 'put', data: { title } })

export const updateAgentSessionStatus = (projectId: string, sessionId: string, status: 'active' | 'archived') =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}`, method: 'put', data: { status } })

export const moveAgentSession = (fromProjectId: string, sessionId: string, targetProjectId: string) =>
  request({
    url: `/api/projects/${pe(fromProjectId)}/sessions/${pe(sessionId)}/move`,
    method: 'post',
    data: { target_project_id: targetProjectId }
  })

// Delete an agent session (soft delete; reuse DELETE /sessions/:sid)
export const deleteAgentSession = (projectId: string, sessionId: string) =>
  request({ url: `/api/projects/${pe(projectId)}/sessions/${pe(sessionId)}`, method: 'delete' })

export interface AgentTurnInput {
  type: 'text' | 'image' | 'localImage' | 'audio' | 'localAudio'
  text?: string
  url?: string
  path?: string
}

export interface StartAgentTurnParams {
  input: AgentTurnInput[]
  temporary?: boolean
  clientUserMessageId?: string
  model?: string
  effort?: string
  summary?: string
  verbosity?: string
  approvalMode?: 'ask' | 'auto' | 'full'
  searchMode?: 'auto' | 'required' | 'off'
  collaborationMode?: 'default' | 'plan'
  attachments?: Array<{
    path: string
    name?: string
    is_dir?: boolean
    mime_type?: string
    size_bytes?: number
    width?: number
    height?: number
  }>
  displayMessage?: string
  skill?: string
  skills?: string[]
  clientCapabilities?: {
    surface: 'desktop' | 'browser'
    projectChatMemory: boolean
    globalChatMemory: boolean
    renderMarkdown: boolean
    renderChart: boolean
    renderGenerativeUi: boolean
    pageDataResult: boolean
    openLocalFile: boolean
    reviewWorkspaceDiff: boolean
    mutateWorkspace: boolean
    downloadArtifact: boolean
  }
  reviewComments?: Array<{
    id: string
    path: string
    comment: string
    side?: 'old' | 'new'
    oldLine?: number | null
    newLine?: number | null
    lineText?: string
    hunkId?: string | null
  }>
}

export const resolveAgentApproval = (
  threadId: string,
  turnId: string,
  itemId: string,
  decision:
    | 'accept'
    | 'acceptForSession'
    | 'acceptAlways'
    | 'decline'
    | 'cancel'
    | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
    | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: 'allow' | 'deny' } } }
) => request({
  url: `/api/agent/runtime-threads/${pe(threadId)}/turns/${pe(turnId)}/items/${pe(itemId)}/approval`,
  method: 'post',
  data: { decision }
})

export const resolveAgentUserInput = (
  threadId: string,
  turnId: string,
  itemId: string,
  answers: Record<string, { answers: string[] }>
) => request({
  url: `/api/agent/runtime-threads/${pe(threadId)}/turns/${pe(turnId)}/items/${pe(itemId)}/user-input`,
  method: 'post',
  data: { answers }
})

// Manually compact session context (/compact): only model context changes, UI stays the same.
export const compactAgentSession = (projectId: string, sessionId: string) =>
  request({ url: `/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/compact`, method: 'post' })

export interface FileNode {
  name: string
  path: string
  root_id?: string
  type: 'file' | 'dir'
  size?: number
  modified_at?: string | null
  loaded?: boolean
  children?: FileNode[]
}

export interface AgentFileRoot {
  id: string
  name: string
  path: string
  kind: 'source_folder' | 'run' | 'run_work' | 'run_artifacts'
  access_mode?: 'read' | 'write'
  write_target?: boolean
  tree: FileNode[]
  tree_truncated?: boolean
}

export interface AgentFilePreview {
  path: string
  name: string
  root_id: string
  size: number
  extension: string
  content: string
  can_preview: boolean
  preview_kind: 'text' | 'document' | 'table' | 'image' | 'unsupported'
  preview_mode: 'source_text' | 'extracted_text' | 'native_image' | 'none'
  truncated: boolean
  reason: string
}

// Project resources are returned as separate roots: source folders and the latest run output.
export const listAgentFiles = (projectId: string, sessionId?: string | null) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/files`,
    method: 'get',
    params: sessionId ? { session_id: sessionId } : undefined
  })

export const listAgentDirectory = (
  projectId: string,
  rootId: string,
  path: string,
  sessionId?: string | null
) => request({
  url: `/api/agent/projects/${pe(projectId)}/files`,
  method: 'get',
  params: { root_id: rootId, path, ...(sessionId ? { session_id: sessionId } : {}) }
})

// Read a single workspace file (preview).
export const getAgentFile = (projectId: string, rootId: string, path: string, sessionId?: string | null) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/file`,
    method: 'get',
    params: { root_id: rootId, path, ...(sessionId ? { session_id: sessionId } : {}) }
  })

// Get the default model for a new conversation and all selectable Agent models.
export const getAgentModel = (projectId: string, conversationId?: string | null) =>
  request({
    url: `/api/agent/projects/${pe(projectId)}/model`,
    method: 'get',
    params: conversationId ? { session_id: conversationId } : undefined
  })

export interface DshContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface DshQueueItem {
  id: string
  placement: 'queued' | 'steering' | 'context'
  content: DshContentBlock[]
  text: string | null
  preview: string
}

export interface DshSessionProtocolState {
  appSessionId: string
  dshSessionId: string
  projectId?: string | null
  cwd?: string | null
  connected: boolean
  lastSeq: number
  queueKnown: boolean
  queue: DshQueueItem[]
  projections: Record<string, unknown>
  projectionSeq: Record<string, number>
  streamError?: { message?: string; code?: string | null } | null
  revision: number
}

export interface DshPermissionOption {
  value: string
  name: string
  description?: string
}

export interface DshPermissionSelect {
  currentValue: string
  options: DshPermissionOption[]
}

export interface DshTrajectoryEvent {
  event: {
    type: string
    seq: number
    time: number
    data?: Record<string, unknown>
    sourceEventSeqs?: number[]
    surfaceOp?: unknown
  }
  view?: {
    for: 'call' | 'result'
    view: Record<string, unknown>
  }
}

export interface DshSessionTrajectory {
  appSessionId: string
  dshSessionId: string
  source: 'session.history'
  lastSeq: number
  events: DshTrajectoryEvent[]
  projections: {
    asOfSeq: number
    values: Record<string, unknown>
  } | null
}

export const getDshSessionProtocolState = (projectId: string, threadId: string) => request({
  url: `/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-state`,
  method: 'get',
  ignoreMsg: true
})

export const getDshSessionTrajectory = (projectId: string, threadId: string) => request({
  url: `/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-trajectory`,
  method: 'get',
  ignoreMsg: true
})

export const watchDshSessionProtocol = (projectId: string, threadId: string, signal?: AbortSignal): StreamReq => ({
  url: createAPIURL(`/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-events`),
  method: 'GET',
  headers: {
    Accept: 'text/event-stream',
    'Accept-Language': langHeader()
  },
  signal
})

export const setDshSessionPermission = (projectId: string, threadId: string, preset: string) => request({
  url: `/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-permission`,
  method: 'post',
  data: { preset },
  ignoreMsg: true
})

export const setDshSessionPlanMode = (
  projectId: string,
  threadId: string,
  mode: 'default' | 'plan'
) => request({
  url: `/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-plan`,
  method: 'post',
  data: { mode },
  ignoreMsg: true
})

export const promptDshSession = (
  projectId: string,
  threadId: string,
  input: {
    mode: 'queue' | 'steer'
    input: AgentTurnInput[]
    attachments?: StartAgentTurnParams['attachments']
  }
) => request({
  url: `/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-prompt`,
  method: 'post',
  data: input,
  ignoreMsg: true
})

export const updateDshSessionQueueItem = (
  projectId: string,
  threadId: string,
  itemId: string,
  action: { kind: 'edit'; input: DshContentBlock[] } | { kind: 'remove' | 'steer' }
) => request({
  url: `/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/dsh-queue/${pe(itemId)}`,
  method: 'post',
  data: action,
  ignoreMsg: true
})

export const readDshSessionAttachment = (sessionId: string, attachmentId: string): Promise<Blob> => request({
  url: `/api/agent/sessions/${pe(sessionId)}/dsh-attachments/${pe(attachmentId)}`,
  method: 'get',
  responseType: 'blob',
  ignoreMsg: true
})

const langHeader = () => {
  try {
    const map: Record<string, string> = { zh: 'zh-CN', en: 'en-US' }
    return map[useConfigStore.getState().language] || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

const AGENT_CONVERSATION_STATUS_EVENT_TYPES = new Set<AgentConversationStatusEventType>([
  'conversation_status.ready',
  'conversation_status.changed',
  'conversation_status.heartbeat'
])

function optionalStatusEventText(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

export function parseAgentConversationStatusEvent(line: string): AgentConversationStatusEvent | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    const type = String(parsed?.type || '') as AgentConversationStatusEventType
    if (!AGENT_CONVERSATION_STATUS_EVENT_TYPES.has(type)) return null
    const payload = parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : {}
    const rawSeq = payload.seq
    return {
      type,
      payload: {
        event_id: optionalStatusEventText(payload.event_id),
        server_instance_id: optionalStatusEventText(payload.server_instance_id),
        seq: rawSeq == null || !Number.isFinite(Number(rawSeq)) ? null : Number(rawSeq),
        project_id: optionalStatusEventText(payload.project_id),
        session_id: optionalStatusEventText(payload.session_id),
        run_id: optionalStatusEventText(payload.run_id),
        reason: optionalStatusEventText(payload.reason),
        at: optionalStatusEventText(payload.at)
      }
    }
  } catch {
    return null
  }
}

/** One user-scoped stream invalidates sidebar snapshots; payloads never replace the snapshot itself. */
export function subscribeAgentConversationStatusEvents(
  onEvent: (event: AgentConversationStatusEvent) => void,
  signal?: AbortSignal
) {
  return subscribeStream({
    url: createAPIURL('/api/agent/session-status/events'),
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Accept-Language': langHeader()
    },
    signal
  }, (line) => {
    const event = parseAgentConversationStatusEvent(line)
    if (event) onEvent(event)
  })
}

/**
 * Send a message to dsh-agent and return a fetch Response (SSE stream read from body).
 * Event contract: Agent Stream turn/item events → "data: [DONE]"
 */
export const startAgentTurn = (
  projectId: string,
  threadId: string,
  params: StartAgentTurnParams,
  signal?: AbortSignal,
) => {
  const url = createAPIURL(`/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/turns`)
  const req: StreamReq = {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': langHeader()
    },
    body: JSON.stringify(params),
    signal
  }
  return req
}

export interface StartAgentReviewParams {
  model?: string
  effort?: string
  summary?: string
  verbosity?: string
  baseBranch?: string
  clientUserMessageId?: string
}

export const startAgentReview = (
  projectId: string,
  threadId: string,
  params: StartAgentReviewParams,
  signal?: AbortSignal,
) => {
  const url = createAPIURL(`/api/agent/projects/${pe(projectId)}/threads/${pe(threadId)}/review`)
  const req: StreamReq = {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': langHeader()
    },
    body: JSON.stringify(params),
    signal
  }
  return req
}

export const steerAgentTurn = (
  threadId: string,
  turnId: string,
  params: Pick<StartAgentTurnParams, 'input' | 'clientUserMessageId' | 'attachments' | 'reviewComments'>
) => request({
  url: `/api/agent/threads/${pe(threadId)}/turns/${pe(turnId)}/steer`,
  method: 'post',
  data: params
})

export const interruptAgentTurn = (threadId: string, turnId: string) =>
  request({
    url: `/api/agent/threads/${pe(threadId)}/turns/${pe(turnId)}/interrupt`,
    method: 'post',
    data: {}
  })

export const revertAgentWorkspaceChange = (
  threadId: string,
  turnId: string,
  input: {
    requestId: string
    targetItemId?: string | null
    expectedTurnDiffHash?: string | null
  }
) => request({
  url: `/api/agent/threads/${pe(threadId)}/turns/${pe(turnId)}/workspace-actions`,
  method: 'post',
  data: {
    ...input,
    action: 'revert_file_change'
  }
})

export const applyAgentWorkspaceEdit = (
  threadId: string,
  turnId: string,
  input: {
    requestId: string
    path: string
    lineNumber: number
    newLineText: string
    /** SHA-256 of the workspace diff the editor rendered; server rejects a stale view. */
    expectedWorkspaceDiffHash?: string | null
  }
) => request({
  url: `/api/agent/threads/${pe(threadId)}/turns/${pe(turnId)}/workspace-edit`,
  method: 'post',
  data: {
    ...input,
    action: 'apply_edit'
  }
})

export const resolveAgentFileReference = (
  threadId: string,
  target: { path: string; lineStart?: number | null; lineEnd?: number | null }
) => request({
  url: `/api/agent/threads/${pe(threadId)}/file-references/resolve`,
  method: 'post',
  data: target,
  ignoreMsg: true
})

export const getAgentCurrentWorkspaceDiff = (threadId: string) => request({
  url: `/api/agent/threads/${pe(threadId)}/workspace-diff`,
  method: 'get',
  ignoreMsg: true
})

export const resolveAgentPendingAction = (
  projectId: string,
  sessionId: string,
  requestId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
) => {
  const url = createAPIURL(`/api/agent/projects/${pe(projectId)}/sessions/${pe(sessionId)}/pending-actions/${pe(requestId)}/resolve`)
  const req: StreamReq = {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': langHeader()
    },
    body: JSON.stringify(payload || {}),
    signal
  }
  return req
}
