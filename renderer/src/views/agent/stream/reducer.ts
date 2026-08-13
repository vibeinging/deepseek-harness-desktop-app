import type {
  AgentBlock,
  AgentMessage,
  AgentStreamEvent,
  AgentStreamPatch,
  AgentTurnStatus,
  ToolCall,
  WorkstationDraft,
  WorkstationPatch
} from './types'
import { artifactKindForPath } from './uiCapabilities'
import { normalizePlanSteps } from '../planState'
import { parseToolEventView } from './toolEventView'
import type { ToolEventView } from './toolEventView'
import { generativeUiSummaryFromContent, parseGenerativeUiDocument } from '../generative-ui/schema'

function parseJson(text: unknown): any {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function canonicalMetadata(value: unknown): Record<string, unknown> {
  const metadata = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {}
  const rawPhase = String(metadata.phase || metadata.msg_category || '').trim()
  for (const key of ['phase', 'msg_category', 'resultRole', 'candidate_status']) delete metadata[key]
  if (rawPhase === 'commentary' || rawPhase === 'final_answer') metadata.phase = rawPhase
  return metadata
}

export function mergeStreamBlock(previous: AgentBlock, next: AgentBlock): AgentBlock {
  if (next.metadata?.mode !== 'append') return next
  return {
    ...previous,
    ...next,
    content: (previous.content || '') + (next.content || ''),
    metadata: { ...canonicalMetadata(previous.metadata), ...canonicalMetadata(next.metadata) }
  }
}

/** Keep one authoritative block per protocol id while preserving first position. */
export function dedupeStreamBlocks(blocks: AgentBlock[]): AgentBlock[] {
  const result: AgentBlock[] = []
  const indexes = new Map<string, number>()
  for (const block of blocks) {
    const id = String(block.id || '').trim()
    if (!id) {
      result.push(block)
      continue
    }
    const index = indexes.get(id)
    if (index == null) {
      indexes.set(id, result.length)
      result.push(block)
    } else {
      result[index] = block
    }
  }
  return result
}

function toolWhere(name: string, where?: string): ToolCall['where'] {
  if (where === 'mcp') return 'mcp'
  if (where === 'cloud' || /^mcp[_:-]/i.test(name)) return 'cloud'
  return 'local'
}

function toolStatus(status?: string | null): ToolCall['status'] {
  if (['error', 'failed', 'declined', 'rejected', 'cancelled', 'canceled', 'interrupted', 'stopped'].includes(String(status || ''))) return 'error'
  if (status === 'running' || status === 'inProgress') return 'running'
  if (status === 'pending') return 'pending'
  return 'ok'
}

export function blockTitleFromStatus(status: unknown): 'running' | 'done' | 'error' | 'rejected' | 'stopped' {
  const raw = String(status || '').toLowerCase()
  if (raw === 'inprogress' || raw === 'in_progress' || raw === 'running' || raw === 'pendinginit') return 'running'
  if (raw === 'failed' || raw === 'error' || raw === 'errored' || raw === 'notfound') return 'error'
  if (raw === 'declined' || raw === 'rejected') return 'rejected'
  if (raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled' || raw === 'stopped') return 'stopped'
  return 'done'
}

function toolResultFromItem(item: any): string | undefined {
  const content = (Array.isArray(item?.contentItems) ? item.contentItems : [])
    .map((entry: any) => {
      if (entry?.type === 'inputText') return String(entry.text || '')
      if (entry?.type === 'inputImage') return String(entry.imageUrl || entry.image_url || '')
      if (entry?.type === 'inputAudio') return String(entry.audioUrl || entry.audio_url || '')
      return ''
    })
    .filter(Boolean)
    .join('\n')
  const value = item?.result ?? item?.aggregatedOutput ?? item?.results ?? item?.error ?? content
  return value == null || value === '' ? undefined : toText(value)
}

const TOOL_LABELS: Record<string, string> = {
  execute_readonly_sql: '查询数据库',
  grep_tables: '检索表',
  grep_columns: '检索字段',
  align_metric: '对齐业务定义',
  execute_metric: '执行业务定义',
  align_value: '对齐实体值',
  semantic_scan_operator: '检索文档',
  semantic_filter_operator: '语义过滤',
  semantic_extract_operator: '语义抽取',
  semantic_join_operator: '语义关联',
  web_search_operator: '联网搜索',
  format_result: '生成结果展示',
  project_rules_get: '读取项目规则',
  project_rules_update: '更新项目规则'
}

function clippedPreview(value: unknown, max = 180) {
  const text = toText(value).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function toolBlock(payload: any, title: 'running' | 'done' | 'error' | 'rejected' | 'stopped'): AgentBlock | null {
  const id = String(payload?.tool_call_id || payload?.id || '').trim()
  const name = String(payload?.name || '').trim()
  if (!id || !name) return null
  const preview = clippedPreview(payload?.args_preview || payload?.args || '')
  // dshView is the DSH ToolEventView envelope ({ for, view }). Parse it once
  // here so the renderer never re-derives the card on every render; a malformed
  // or absent view yields undefined and the card falls back to the generic row.
  const dshCallView = parseToolEventView(payload?.dshCallView)
  const dshResultView = parseToolEventView(payload?.dshResultView)
  const legacyView = parseToolEventView(payload?.dshView)
  const callView = dshCallView?.for === 'call'
    ? dshCallView
    : legacyView?.for === 'call' ? legacyView : undefined
  const resultView = dshResultView?.for === 'result'
    ? dshResultView
    : legacyView?.for === 'result' ? legacyView : undefined
  const viewTitle = resultView?.view?.title || callView?.view?.title
  // Label priority: the DSH presenter's title (the authoritative, tool-supplied
  // label) → the legacy tool-name table → the raw tool name. This stops the
  // renderer from guessing the card title from the tool name alone.
  const label = viewTitle || TOOL_LABELS[name] || name
  const metadata: Record<string, unknown> = {
    tool_call_id: id,
    tool_name: name,
    status: title
  }
  if (callView !== undefined) metadata.dshCallView = callView
  if (resultView !== undefined) metadata.dshResultView = resultView
  if (resultView || callView) metadata.dshView = resultView || callView
  const resultText = typeof payload?.resultText === 'string' ? payload.resultText : undefined
  if (resultText) metadata.resultText = resultText
  return {
    id,
    type: 'tool',
    content: preview ? `${label} ${preview}` : label,
    title,
    metadata
  }
}

function artifactPatch(value: unknown): NonNullable<AgentStreamPatch['workstation']>['artifact'] | undefined {
  const path = typeof value === 'string' ? value : typeof (value as any)?.path === 'string' ? (value as any).path : ''
  if (!path) return undefined
  const name = String((value as any)?.name || path.split('/').pop() || path)
  const kind = (value as any)?.kind || artifactKindForPath(path)
  return {
    id: String((value as any)?.artifact_id || path),
    value: {
      name,
      meta: path,
      kind
    }
  }
}

function artifactBlock(item: any): AgentBlock | null {
  const path = typeof item?.path === 'string' ? item.path.trim() : ''
  if (!path) return null
  const name = String(item.name || path.split('/').pop() || path)
  const kind = String(item.kind || artifactKindForPath(path))
  const artifactId = String(item.artifact_id || item.id || path)
  return {
    id: String(item.id || artifactId),
    type: 'file',
    content: JSON.stringify({
      name,
      path,
      kind,
      artifact_id: artifactId
    }),
    title: name,
    display_type: 'file',
    metadata: {
      item_type: 'artifact',
      result_role: 'deliverable',
      source_tool_call_id: item.source_tool_call_id || null,
      source_tool_name: item.source_tool_name || null,
      artifact_id: artifactId,
      mode: 'replace'
    }
  }
}

function turnStatus(value: unknown, { allowExtension = false } = {}): AgentTurnStatus {
  const raw = String(value || '')
  if (raw === 'inProgress' || raw === 'completed' || raw === 'interrupted' || raw === 'failed') {
    return raw
  }
  if (allowExtension && (raw === 'suspended' || raw === 'expired')) return raw
  if (raw === 'cancelled' || raw === 'stopped') return 'interrupted'
  return 'pending'
}

function eventTarget(event: AgentStreamEvent) {
  return {
    threadId: event.thread_id || null,
    turnId: event.turn_id || null,
    itemId: event.item_id || null
  }
}

/** The item types the reducer projects into a tool block. Shared with the history path. */
const TOOL_ITEM_TYPES = ['dynamicToolCall', 'mcpToolCall', 'commandExecution', 'webSearch']

/**
 * Project a tool-shaped item into an `AgentBlock` (type `'tool'`). Shared by
 * the live stream (`itemBlock`) and the history path (`mapServerMessage`) so
 * the two never diverge: a tool block has the same shape, the same dshView
 * retention, and the same label priority whether it arrived live or was
 * replayed from the session log.
 *
 * Returns `undefined` when the item is not tool-shaped (the caller then keeps
 * its own projection), or `null` when it IS tool-shaped but malformed (no
 * id/name) — matching `toolBlock`'s existing contract.
 * @param item - the raw item from a live event payload or a persisted content_item.
 * @param status - the lifecycle status to stamp ('running' | 'done' | ...).
 */
export function toolBlockFromItem(item: any, status: 'running' | 'done' | 'error' | 'rejected' | 'stopped'): AgentBlock | null | undefined {
  if (!TOOL_ITEM_TYPES.includes(item?.type)) return undefined
  const name = item.type === 'commandExecution'
    ? 'command'
    : item.type === 'webSearch'
      ? 'web_search'
      : item.tool
  const args = item.arguments ?? item.command ?? item.query
  return toolBlock(
    {
      id: item.id,
      tool_call_id: item.id,
      name,
      where: item.type === 'mcpToolCall' ? 'mcp' : item.namespace,
      args_preview: args,
      dshView: item.dshView,
      dshCallView: item.dshCallView,
      dshResultView: item.dshResultView,
      resultText: toolResultFromItem(item)
    },
    status
  )
}

function itemBlock(item: any): AgentBlock | null {
  if (!item?.id || item.visibility === 'hidden') return null
  const answerStatus = String(item.metadata?.answer_status || '').trim()
  const itemMetadata = {
    item_type: item.type,
    ...((item.phase === 'commentary' || item.phase === 'final_answer') ? { phase: item.phase } : {}),
    ...(answerStatus ? { answer_status: answerStatus } : {}),
    ...(item.metadata?.result_role
      ? { result_role: item.metadata.result_role }
      : {})
  }

  if (item.type === 'agentMessage') {
    return {
      id: item.id,
      type: item.format === 'text' ? 'text' : 'markdown',
      content: String(item.text || ''),
      title: item.title,
      metadata: { ...itemMetadata, mode: 'replace', model: item.model || null, usage: item.usage || null }
    }
  }
  if (item.type === 'reasoning') {
    return {
      id: item.id,
      type: 'thinking',
      content: [...(item.summary || []), ...(item.content || [])].filter(Boolean).join('\n'),
      title: '思考',
      metadata: { ...itemMetadata, mode: 'replace', model: item.model || null, usage: item.usage || null }
    }
  }
  if (item.type === 'plan') {
    return {
      id: item.id,
      type: 'markdown',
      content: String(item.text || ''),
      title: '计划方案',
      metadata: {
        ...itemMetadata,
        item_type: 'planDocument'
      }
    }
  }
  if (item.type === 'contextCompaction') {
    const completed = item.status !== 'inProgress'
    return {
      id: item.id,
      type: 'compact',
      content: completed ? (item.trigger === 'manual' ? '上下文已压缩' : '上下文已自动压缩') : '',
      title: completed ? 'done' : 'running',
      metadata: {
        ...itemMetadata,
        trigger: item.trigger || 'auto',
        mode: 'replace'
      }
    }
  }
  if (item.type === 'imageGeneration') {
    const completed = item.status === 'completed'
    const state = blockTitleFromStatus(item.status)
    const failed = state === 'error'
    return {
      id: item.id,
      type: completed && item.result ? 'image' : failed ? 'error' : 'status',
      content: completed && item.result
        ? (String(item.result).startsWith('data:') ? String(item.result) : `data:image/png;base64,${item.result}`)
        : failed ? '图片生成失败' : state === 'rejected' ? '图片生成已拒绝' : state === 'stopped' ? '图片生成已停止' : '正在生成图片…',
      title: completed ? '生成的图片' : state,
      display_type: completed ? 'image' : undefined,
      metadata: {
        ...itemMetadata,
        status: item.status || 'inProgress',
        revised_prompt: item.revisedPrompt || null,
        saved_path: item.savedPath || null,
        mode: 'replace'
      }
    }
  }
  if (item.type === 'imageView') {
    return {
      id: item.id,
      type: 'image',
      content: String(item.path || ''),
      title: '查看图片',
      display_type: 'image',
      metadata: { ...itemMetadata, path: item.path || null, mode: 'replace' }
    }
  }
  if (item.type === 'sleep') {
    const state = blockTitleFromStatus(item.status || 'inProgress')
    return {
      id: item.id,
      type: 'status',
      content: state === 'done'
        ? '等待结束'
        : state === 'stopped'
          ? '等待已停止'
          : state === 'error'
            ? '等待失败'
            : `等待 ${Math.max(0, Number(item.durationMs || 0))} 毫秒…`,
      title: state,
      metadata: { ...itemMetadata, status: item.status || 'inProgress', duration_ms: Number(item.durationMs || 0), mode: 'replace' }
    }
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const entered = item.type === 'enteredReviewMode'
    return {
      id: item.id,
      type: 'status',
      content: String(item.review || (entered ? '已进入代码审查模式' : '已退出代码审查模式')),
      title: entered ? '开始审查' : '结束审查',
      metadata: { ...itemMetadata, mode: 'replace' }
    }
  }
  if (item.type === 'fileChange') {
    return {
      id: item.id,
      type: 'file_change',
      content: JSON.stringify({
        changes: Array.isArray(item.changes) ? item.changes : [],
        status: item.status || 'completed'
      }),
      title: blockTitleFromStatus(item.status),
      metadata: {
        ...itemMetadata,
        mode: 'replace'
      }
    }
  }
  if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
    const activityThreadId = String(item.agentThreadId || '').trim()
    const agentsStates = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {}
    const childThreadIds = [...new Set([
      ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
      ...Object.keys(agentsStates),
      activityThreadId
    ].map((value) => String(value || '').trim()).filter(Boolean))]
    const states = childThreadIds.map((threadId) => String(agentsStates[threadId]?.status || ''))
    const failed = item.status === 'failed' || states.some((status) => status === 'errored' || status === 'notFound')
    const interrupted = item.status === 'interrupted' || item.kind === 'interrupted' || states.includes('interrupted')
    const running = !failed && !interrupted && (item.status === 'inProgress' || states.some((status) => status === 'running' || status === 'pendingInit'))
    const title = item.type === 'subAgentActivity'
      ? item.kind === 'interrupted' ? '子任务已停止' : item.kind === 'started' ? '子任务已启动' : '子任务有新进展'
      : ({
          spawnAgent: '创建子任务',
          sendInput: '补充子任务',
          resumeAgent: '恢复子任务',
          wait: '等待子任务',
          closeAgent: '关闭子任务'
        } as Record<string, string>)[String(item.tool || '')] || '协作子任务'
    const stateMessages = childThreadIds
      .map((threadId) => String(agentsStates[threadId]?.message || '').trim())
      .filter(Boolean)
    const payload = {
      version: 'codex_native_collaboration.v1',
      source: 'app-server',
      item_type: item.type,
      item_id: item.id,
      title,
      summary: stateMessages.join('；') || String(item.prompt || item.agentPath || ''),
      tool: item.tool || null,
      prompt: item.prompt || null,
      sender_thread_id: item.senderThreadId || null,
      child_thread_ids: childThreadIds,
      agents_states: agentsStates,
      status: failed ? 'failed' : interrupted ? 'interrupted' : running ? 'running' : 'completed',
      model: item.model || null,
      reasoning_effort: item.reasoningEffort || null
    }
    return {
      id: item.id,
      type: 'delegated_subtask',
      content: JSON.stringify(payload),
      title: failed ? 'error' : interrupted ? 'stopped' : running ? 'running' : 'done',
      metadata: {
        ...itemMetadata,
        source: 'app-server',
        subtask_title: title,
        child_thread_ids: childThreadIds,
        parent_thread_id: item.senderThreadId || null,
        agents_states: agentsStates,
        mode: 'replace'
      }
    }
  }
  if (TOOL_ITEM_TYPES.includes(item.type)) {
    // toolBlockFromItem returns undefined only for non-tool items; we are
    // inside the tool-type branch so it always produces a block (or null).
    return toolBlockFromItem(item, blockTitleFromStatus(item.status)) ?? null
  }
  if (item.type === 'subtask') {
    return {
      id: item.id,
      type: 'subtask',
      content: String(item.summary || item.error || ''),
      title: blockTitleFromStatus(item.status),
      metadata: {
        ...itemMetadata,
        run_id: item.runId || null,
        parent_run_id: item.parentRunId || null,
        call_id: item.callId || null,
        subtask_type: item.subtaskType || null,
        subtask_title: item.title || '子任务',
        tool_name: item.tool || null,
        parallel_group: item.parallelGroup || null,
        error: item.error || null
      }
    }
  }
  if (item.type === 'dataResult') {
    return {
      id: item.id,
      type: item.format || 'json',
      content: toText(item.content),
      title: item.title,
      display_type: item.displayType,
      metadata: { ...itemMetadata, ...(item.metadata || {}), mode: 'replace' }
    }
  }
  if (item.type === 'generativeUi' || item.type === 'generative_ui') {
    const sourceMetadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {}
    const sourceEnvelope = sourceMetadata.generative_ui && typeof sourceMetadata.generative_ui === 'object'
      ? sourceMetadata.generative_ui
      : {}
    const legacyDocument = item.content && typeof item.content === 'object' && !Array.isArray(item.content)
      ? item.content
      : typeof item.content === 'string' && /^\s*[\[{]/.test(item.content)
        ? item.content
        : null
    const document = sourceEnvelope.document ?? legacyDocument
    const parsed = parseGenerativeUiDocument(document)
    const summary = parsed.ok
      ? parsed.document.summary
      : generativeUiSummaryFromContent(item.content) || parsed.summary
    const documentHash = String(
      sourceEnvelope.document_hash || sourceMetadata.document_hash || item.documentHash || item.document_hash || ''
    ).trim()
    const replacesItemId = String(
      sourceMetadata.replaces_item_id || item.replacesItemId || item.replaces_item_id || ''
    ).trim()
    return {
      id: item.id,
      type: 'generative_ui',
      content: summary,
      title: parsed.ok ? parsed.document.title : item.title,
      metadata: {
        ...sourceMetadata,
        ...itemMetadata,
        item_type: 'generativeUi',
        content_type: 'generative_ui',
        result_role: 'deliverable',
        surface_id: parsed.ok ? parsed.document.surface_id : sourceMetadata.surface_id,
        revision: parsed.ok ? parsed.document.revision : sourceMetadata.revision,
        replaces_item_id: replacesItemId || null,
        document_hash: documentHash || null,
        generative_ui: {
          ...sourceEnvelope,
          document,
          document_hash: documentHash || sourceEnvelope.document_hash || null
        },
        mode: 'replace'
      }
    }
  }
  if (item.type === 'artifact') return artifactBlock(item)
  if (item.type === 'approval') {
    return {
      id: item.id,
      type: 'confirm',
      content: String(item.summary || ''),
      title: item.status === 'approved' || item.status === 'rejected' ? item.status : item.tool || 'confirm',
      metadata: {
        ...itemMetadata,
        tool_call_id: item.toolCallId || '',
        approval_request: item.approvalRequest || item.approval_request || null
      }
    }
  }
  if (item.type === 'userInput') {
    return {
      id: item.id,
      type: 'user_input',
      content: JSON.stringify(item),
      title: item.status === 'answered' ? 'resolved' : item.status || 'requested',
      metadata: { ...itemMetadata, request_id: item.request_id, status: item.status, response: item.value }
    }
  }
  // Read-only compatibility for history written before Skill was aligned as a
  // structured Turn input. Codex 0.147.0 does not define a Skill ThreadItem.
  if (item.type === 'skill') {
    return {
      id: item.id,
      type: 'status',
      content: `使用技能 ${item.name || ''}`.trim(),
      title: '技能',
      metadata: { ...itemMetadata }
    }
  }
  if (item.type === 'error') {
    return {
      id: item.id,
      type: 'error',
      content: String(item.content || item.text || ''),
      title: item.title || '错误',
      metadata: { ...itemMetadata, ...(item.metadata || {}) }
    }
  }
  return null
}

function itemWorkstation(item: any): WorkstationPatch | undefined {
  if (!item?.id) return undefined
  if (['dynamicToolCall', 'mcpToolCall', 'commandExecution', 'webSearch'].includes(item.type)) {
    const name = item.type === 'commandExecution'
      ? 'command'
      : item.type === 'webSearch'
        ? 'web_search'
        : item.tool
    const args = item.arguments
      ?? item.command
      ?? item.query
    const result = toolResultFromItem(item)
    return {
      tool: {
        id: item.id,
        value: {
          name: String(name || ''),
          where: toolWhere(String(name || ''), item.type === 'mcpToolCall' ? 'mcp' : item.namespace),
          status: toolStatus(item.status),
          args: toText(args || ''),
          result
        }
      }
    }
  }
  if (item.type === 'artifact') {
    const artifact = artifactPatch(item)
    return artifact ? { artifact } : undefined
  }
  // Legacy Host projection only; new runtime events never emit this item type.
  if (item.type === 'skill') {
    const skill = skillPatch(item)
    return skill ? { skill } : undefined
  }
  return undefined
}

export function reduceStreamEvent(event: AgentStreamEvent): AgentStreamPatch {
  if (!event?.type) return { ignored: true }
  const payload = event.payload || {}
  const target = eventTarget(event)
  const extensionEvent = event.type.startsWith('dsh/')
  const eventType = extensionEvent ? event.type.slice('dsh/'.length) : event.type

  if (eventType === 'turn/started') {
    const turn = payload.turn || {}
    return {
      target,
      turn: {
        ...target,
        messageId: payload.messageId || null,
        status: 'inProgress',
        startedAtMs: turn.startedAt ? Number(turn.startedAt) * 1000 : event.ts ? Date.parse(event.ts) : Date.now(),
        completedAtMs: null,
        durationMs: null,
        error: null
      }
    }
  }

  if (eventType === 'turn/statusChanged') {
    return { target, turn: { ...target, status: turnStatus(payload.status, { allowExtension: extensionEvent }) } }
  }

  if (eventType === 'turn/completed') {
    const turn = payload.turn || {}
    return {
      target,
      removeBlockId: `retry:${String(event.turn_id || turn.id || 'turn')}`,
      turn: {
        ...target,
        status: turnStatus(turn.status),
        answerStatus: turn.answer?.status || undefined,
        answerItemId: turn.answer?.itemId || null,
        answerSource: turn.answer?.source || null,
        answerRejectionCode: turn.answer?.rejectionCode || null,
        startedAtMs: turn.startedAt ? Number(turn.startedAt) * 1000 : null,
        completedAtMs: turn.completedAt ? Number(turn.completedAt) * 1000 : event.ts ? Date.parse(event.ts) : Date.now(),
        durationMs: Number.isFinite(Number(turn.durationMs)) ? Number(turn.durationMs) : null,
        error: turn.error?.message || null
      }
    }
  }

  if (eventType === 'turn/plan/updated') {
    const plan = normalizePlanSteps(payload.plan)
    return {
      target,
      block: {
        id: String(event.item_id || 'plan'),
        type: 'plan',
        content: JSON.stringify(payload.plan || []),
        title: '已更新计划',
        metadata: { item_type: 'plan', explanation: payload.explanation || null }
      },
      workstation: { plan }
    }
  }

  if (eventType === 'item/agentMessage/delta') {
    if (payload.visibility === 'hidden') {
      return { target, removeBlockId: String(event.item_id || '') }
    }
    return {
      target,
      block: {
        id: String(event.item_id || ''),
        type: payload.format === 'text' ? 'text' : 'markdown',
        content: String(payload.delta || ''),
        title: payload.title,
        metadata: {
          ...canonicalMetadata(payload.metadata),
          ...((payload.phase === 'commentary' || payload.phase === 'final_answer') ? { phase: payload.phase } : {}),
          item_type: 'agentMessage',
          mode: payload.mode || 'append',
          model: payload.model || null,
          usage: payload.usage || null
        }
      }
    }
  }

  if (eventType === 'item/reasoning/summaryTextDelta' || eventType === 'item/reasoning/textDelta') {
    if (payload.visibility === 'hidden') {
      return { target, removeBlockId: String(event.item_id || '') }
    }
    return {
      target,
      block: {
        id: String(event.item_id || ''),
        type: 'thinking',
        content: String(payload.delta || ''),
        title: '思考',
        metadata: {
          item_type: 'reasoning',
          mode: payload.mode || 'append',
          model: payload.model || null,
          usage: payload.usage || null
        }
      }
    }
  }

  if (eventType === 'item/plan/delta') {
    return {
      target,
      block: {
        id: String(event.item_id || 'plan'),
        type: 'markdown',
        content: String(payload.delta || ''),
        title: '计划方案',
        metadata: {
          item_type: 'planDocument',
          mode: 'append'
        }
      }
    }
  }

  if (eventType === 'item/toolCall/outputDelta' || eventType === 'item/commandExecution/outputDelta') {
    const itemId = String(event.item_id || '')
    return {
      target,
      block: {
        id: `result:${itemId}`,
        type: 'tool_result',
        content: String(payload.delta || ''),
        title: TOOL_LABELS[String(payload.name || '')] || payload.name || '工具',
        metadata: { item_type: 'toolResult', tool_call_id: itemId, mode: payload.mode || 'append' }
      },
      workstation: itemId ? { toolResult: { id: itemId, result: String(payload.delta || '') } } : undefined
    }
  }

  if (eventType === 'item/fileChange/patchUpdated') {
    const itemId = String(event.item_id || '')
    const patch = payload.patch || payload.diff || payload.delta || ''
    return {
      target,
      block: {
        id: itemId,
        type: 'file_change',
        content: JSON.stringify({
          changes: Array.isArray(payload.changes) ? payload.changes : [],
          patch,
          status: 'inProgress'
        }),
        title: '文件变更',
        metadata: { item_type: 'fileChange', mode: 'replace' }
      }
    }
  }

  if (eventType === 'turn/diff/updated') {
    const diff = typeof payload.diff === 'string' ? payload.diff : ''
    return {
      target,
      turnDiff: {
        ...target,
        diff,
        diffHash: typeof payload.diffHash === 'string' ? payload.diffHash : null
      }
    }
  }

  if (eventType === 'messageAnnotations/updated') {
    return {
      target,
      block: {
        id: String(event.item_id || payload.itemId || ''),
        type: 'markdown',
        content: '',
        metadata: {
          item_type: 'agentMessage',
          mode: 'append',
          text_hash: payload.textHash || null,
          annotations: Array.isArray(payload.annotations) ? payload.annotations : []
        }
      }
    }
  }

  if (eventType === 'error') {
    const retrying = payload.willRetry === true
    return {
      target,
      block: {
        id: retrying
          ? `retry:${String(event.turn_id || 'turn')}`
          : String(event.item_id || `error:${event.turn_id || 'turn'}`),
        type: retrying ? 'status' : 'error',
        content: String(payload.error?.message || payload.message || '任务执行失败'),
        title: retrying ? '正在重试' : '错误',
        metadata: { item_type: 'error', will_retry: retrying, mode: 'replace' }
      }
    }
  }

  if (['warning', 'guardianWarning', 'deprecationNotice', 'configWarning'].includes(eventType)) {
    const details = [payload.summary, payload.details].filter(Boolean).join('：')
    return {
      target,
      block: {
        id: String(event.item_id || `${eventType}:${event.turn_id || 'thread'}`),
        type: 'status',
        content: String(payload.message || details || '运行时提示'),
        title: eventType === 'deprecationNotice' ? '兼容性提示' : '运行时提示',
        metadata: { item_type: eventType, mode: 'replace' }
      }
    }
  }

  if (eventType === 'model/rerouted') {
    return {
      target,
      block: {
        id: String(event.item_id || `model-rerouted:${event.turn_id || 'turn'}`),
        type: 'status',
        content: payload.reason === 'highRiskCyberActivity'
          ? `检测到高风险网络安全活动，模型已从 ${payload.fromModel || '原模型'} 切换为 ${payload.toModel || '安全模型'}`
          : `模型已从 ${payload.fromModel || '原模型'} 切换为 ${payload.toModel || '可用模型'}`,
        title: '模型已切换',
        metadata: { item_type: eventType, from_model: payload.fromModel || null, to_model: payload.toModel || payload.model || null, mode: 'replace' }
      }
    }
  }

  if (eventType === 'mcpServer/startupStatus/updated') {
    const status = String(payload.status || '')
    const failure = String(payload.error || payload.failureReason || '')
    return {
      target,
      block: {
        id: String(event.item_id || `mcp-startup:${payload.name || 'server'}`),
        type: status === 'failed' ? 'error' : 'status',
        content: failure || `${payload.name || 'MCP'}：${status || '状态更新'}`,
        title: status === 'failed' ? 'MCP 启动失败' : 'MCP 状态',
        metadata: { item_type: eventType, status, mode: 'replace' }
      }
    }
  }

  if (eventType === 'item/autoApprovalReview/started' || eventType === 'item/autoApprovalReview/completed') {
    const completed = eventType.endsWith('/completed')
    const status = String(payload.review?.status || '')
    const rationale = String(payload.review?.rationale || '')
    return {
      target,
      block: {
        id: String(event.item_id || `auto-review:${payload.reviewId || event.turn_id || 'turn'}`),
        type: status === 'denied' || status === 'failed' ? 'error' : 'status',
        content: rationale || (completed ? `自动安全审查已完成${status ? `：${status}` : ''}` : '正在进行自动安全审查…'),
        title: completed ? '安全审查完成' : '安全审查中',
        metadata: {
          item_type: eventType,
          review_id: payload.reviewId || null,
          target_item_id: payload.targetItemId || null,
          decision_source: payload.decisionSource || null,
          action: payload.action || null,
          status,
          mode: 'replace'
        }
      }
    }
  }

  if (eventType === 'item/mcpToolCall/progress') {
    const itemId = String(event.item_id || payload.itemId || '')
    return {
      target,
      block: {
        id: `result:${itemId}`,
        type: 'tool_result',
        content: String(payload.message || ''),
        title: 'MCP',
        metadata: { item_type: 'mcpToolCallProgress', tool_call_id: itemId, mode: 'replace' }
      },
      workstation: itemId ? { toolResult: { id: itemId, result: String(payload.message || '') } } : undefined
    }
  }

  if (
    eventType === 'item/started' ||
    eventType === 'item/completed'
  ) {
    const item = payload.item || {}
    if (item.type === 'workspaceEvent') {
      const data = item.data && typeof item.data === 'object' ? item.data : null
      return data ? { target, workspaceEvent: data } : { target, ignored: true }
    }
    const started = eventType.endsWith('/started')
    const projectedItem = item.type === 'contextCompaction' || item.type === 'sleep'
      ? { ...item, status: started ? 'inProgress' : 'completed', trigger: item.trigger || 'auto' }
      : item
    const block = itemBlock(projectedItem) || undefined
    return {
      target,
      block,
      removeBlockId: block?.type === 'generative_ui' && block.metadata?.replaces_item_id
        ? String(block.metadata.replaces_item_id)
        : undefined,
      workstation: itemWorkstation(projectedItem)
    }
  }

  return { target, ignored: true }
}

function skillPatch(payload: any): NonNullable<AgentStreamPatch['workstation']>['skill'] | undefined {
  const name = String(payload?.name || payload?.skill_name || '').trim()
  if (!name) return undefined
  const id = String(payload?.selection_key || payload?.qualified_name || name).trim()
  return {
    id,
    value: {
      name,
      runtime: payload?.runtime || null,
      status: payload?.status || 'selected',
      reason: payload?.reason || ''
    }
  }
}

export function reduceContentItem(block: AgentBlock): AgentStreamPatch {
  // Old persisted records remain readable, but the current runtime stores the
  // authoritative selection on the user message instead of emitting a fake
  // native ThreadItem lifecycle.
  if (block.type === 'skill_invocation') {
    const data = parseJson(block.content) || {}
    const skill = skillPatch({
      name: data.skill_name || block.metadata?.skill_name || block.title,
      runtime: data.runtime || block.metadata?.runtime,
      status: data.status || block.metadata?.status || 'selected',
      reason: data.reason || block.metadata?.reason || ''
    })
    return skill ? { workstation: { skill } } : { ignored: true }
  }

  if (block.type === 'plan') {
    return { workstation: { plan: normalizePlanSteps(block.content) } }
  }

  if (block.metadata?.display === false || block.type === 'workspace_event') return { ignored: true }

  if (block.type === 'tool') {
    const name = block.metadata?.tool_name || String(block.content || '').split(/\s+/)[0] || ''
    const traceInput = block.metadata?.trace_input ?? block.metadata?.traceInput
    const args = traceInput == null
      ? String(block.content || '').slice(name.length).trim()
      : toText(traceInput)
    const status: ToolCall['status'] = block.title === 'running'
      ? 'running'
      : ['error', 'rejected', 'stopped'].includes(String(block.title || ''))
        ? 'error'
        : 'ok'
    const tool = {
      id: block.id,
      value: {
        name,
        where: toolWhere(name, block.metadata?.where),
        status,
        args,
        result: block.metadata?.trace_output ?? block.metadata?.traceOutput
      }
    }
    const artifact = artifactPatch(block.metadata?.artifact)
    return { workstation: { tool, ...(artifact ? { artifact } : {}) } }
  }

  if (block.type === 'tool_result') {
    const id = String(block.id || '').replace(/^result:/, '')
    return { workstation: id ? { toolResult: { id, result: toText(block.content) } } : undefined }
  }

  return { ignored: true }
}

export function applyWorkstationPatch(patch: WorkstationPatch | undefined, draft: WorkstationDraft): boolean {
  if (!patch) return false
  let changed = false

  if (patch.plan) {
    draft.plan = patch.plan
    changed = true
  }

  if (patch.tool) {
    const prev = draft.tools.get(patch.tool.id)
    draft.tools.set(patch.tool.id, {
      ...prev,
      ...patch.tool.value,
      result: patch.tool.value.result ?? prev?.result
    })
    changed = true
  }

  if (patch.toolResult) {
    const prev = draft.tools.get(patch.toolResult.id)
    if (prev) {
      draft.tools.set(patch.toolResult.id, { ...prev, result: patch.toolResult.result })
      changed = true
    }
  }

  if (patch.artifact) {
    draft.artifacts.set(patch.artifact.id, patch.artifact.value)
    changed = true
  }

  if (patch.skill) {
    const prev = draft.skills.get(patch.skill.id)
    draft.skills.set(patch.skill.id, { ...prev, ...patch.skill.value })
    changed = true
  }

  return changed
}

export function backfillWorkstationFromMessages(messages: AgentMessage[]): WorkstationDraft {
  const draft: WorkstationDraft = {
    tools: new Map(),
    artifacts: new Map(),
    skills: new Map(),
    plan: []
  }

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.workstationBlocks || message.blocks) {
      const patch = reduceContentItem(block)
      applyWorkstationPatch(patch.workstation, draft)
    }
  }

  return draft
}
