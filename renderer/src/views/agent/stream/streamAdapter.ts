import type { AgentBlock, AgentMessage, AgentSkillSelection, AgentTurnStatus, DataWorkspaceEvent } from './types'
import {
  foldGenerativeUiBlocks,
  generativeUiSummaryFromContent,
  parseGenerativeUiDocument
} from '../generative-ui/schema'
import { blockTitleFromStatus, dedupeStreamBlocks, toolBlockFromItem } from './reducer'

function mapSkillSelections(messageMetadata: any): AgentSkillSelection[] {
  const request = messageMetadata?.turn_request && typeof messageMetadata.turn_request === 'object'
    ? messageMetadata.turn_request
    : {}
  const raw = Array.isArray(request.skill_selections)
    ? request.skill_selections
    : (Array.isArray(request.skills) ? request.skills : []).map((name: unknown) => ({
        selection_key: String(name || ''),
        name: String(name || '')
      }))
  return raw.flatMap((item: any) => {
    const value = typeof item === 'string' ? { selection_key: item, name: item } : item
    const selectionKey = String(value?.selection_key || value?.qualified_name || value?.name || '').trim()
    const name = String(value?.name || value?.qualified_name || selectionKey).trim()
    if (!selectionKey || !name) return []
    return [{
      selectionKey,
      name,
      qualifiedName: String(value?.qualified_name || '') || null,
      displayName: String(value?.display_name || value?.label || name),
      source: String(value?.source || '') || null,
      scope: String(value?.scope || '') || null,
      pluginName: String(value?.plugin_name || '') || null,
      version: String(value?.version || '') || null,
      digest: String(value?.digest || '') || null,
      selectionMode: String(value?.selection_mode || 'explicit')
    }]
  })
}

export function parseSseJsonLine(line: string): any | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload)
    if (parsed?.jsonrpc === '2.0' && typeof parsed.method === 'string') {
      const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : {}
      const meta = params._meta && typeof params._meta === 'object' ? params._meta : {}
      return {
        type: parsed.method,
        thread_id: params.threadId || params.thread?.id || null,
        turn_id: params.turnId || params.turn?.id || null,
        item_id: params.itemId || params.item?.id || null,
        seq: Number(meta.seq || 0),
        ts: meta.ts,
        payload: params
      }
    }
    return parsed
  } catch {
    return null
  }
}

export function mapServerMessage(m: any): AgentMessage {
  let ci = m.content_items
  if (typeof ci === 'string') {
    try {
      ci = JSON.parse(ci)
    } catch {
      ci = []
    }
  }
  if (!Array.isArray(ci)) ci = []
  let messageMetadata = m?.message_metadata
  if (typeof messageMetadata === 'string') {
    try {
      messageMetadata = JSON.parse(messageMetadata)
    } catch {
      messageMetadata = {}
    }
  }
  if (!messageMetadata || typeof messageMetadata !== 'object') messageMetadata = {}
  const allBlocks = foldGenerativeUiBlocks(dedupeStreamBlocks(ci.map((it: any, idx: number): AgentBlock => {
    const metadata = it?.metadata && typeof it.metadata === 'object' ? it.metadata : {}
    const generative = it?.type === 'generative_ui'
      || it?.type === 'generativeUi'
      || it?.content_type === 'generative_ui'
      || metadata?.content_type === 'generative_ui'
    if (!generative) {
      // Tool-shaped items go through the SAME projection the live reducer uses
      // (toolBlockFromItem) so a replayed tool block has the identical shape,
      // dshView retention, and label priority as a live one. Without this, the
      // history path emitted `type: 'dynamicToolCall'` and the tool card branch
      // never matched, leaving replayed tool calls to render as plain markdown.
      const toolBlock = toolBlockFromItem(it, blockTitleFromStatus(it?.status))
      if (toolBlock) {
        return toolBlock
      }
      return {
        id: it.id || `b${idx}`,
        type: it.type || 'text',
        content: typeof it.content === 'string'
          ? it.content
          : typeof it.text === 'string'
            ? it.text
            : JSON.stringify(it.content ?? ''),
        title: it.title,
        display_type: it.display_type,
        metadata
      }
    }
    const envelope = metadata.generative_ui && typeof metadata.generative_ui === 'object'
      ? metadata.generative_ui
      : {}
    const legacyDocument = it.content && typeof it.content === 'object' && !Array.isArray(it.content)
      ? it.content
      : typeof it.content === 'string' && /^\s*[\[{]/.test(it.content)
        ? it.content
        : null
    const document = envelope.document ?? legacyDocument
    const parsed = parseGenerativeUiDocument(document)
    const summary = parsed.ok
      ? parsed.document.summary
      : generativeUiSummaryFromContent(it.content) || parsed.summary
    const documentHash = String(envelope.document_hash || metadata.document_hash || '').trim()
    return {
      id: it.id || `b${idx}`,
      type: 'generative_ui',
      content: summary,
      title: parsed.ok ? parsed.document.title : it.title,
      metadata: {
        ...metadata,
        item_type: 'generativeUi',
        content_type: 'generative_ui',
        result_role: 'deliverable',
        surface_id: parsed.ok ? parsed.document.surface_id : metadata.surface_id,
        revision: parsed.ok ? parsed.document.revision : metadata.revision,
        document_hash: documentHash || null,
        generative_ui: {
          ...envelope,
          document,
          document_hash: documentHash || envelope.document_hash || null
        },
        mode: 'replace'
      }
    }
  })))
  const isHiddenNarrative = (it: AgentBlock) => (
    it?.metadata?.display === false && ['text', 'markdown', 'agentMessage'].includes(it.type)
  )
  const workstationBlocks = allBlocks.filter((it: AgentBlock) => !isHiddenNarrative(it))
  const removedBlockIds = allBlocks.filter(isHiddenNarrative).map((it: AgentBlock) => it.id)
  return {
    id: String(m?.id || messageMetadata.message_id || ''),
    role: m.role === 'user' ? 'user' : 'assistant',
    skillSelections: m.role === 'user' ? mapSkillSelections(messageMetadata) : undefined,
    blocks: workstationBlocks.filter(
      (it: AgentBlock) =>
        (it?.metadata?.display !== false || it?.type === 'plan') &&
        it?.type !== 'skill_invocation' &&
        it?.type !== 'workspace_event'
    ),
    workstationBlocks,
    removedBlockIds,
    threadId: m?.session_id || messageMetadata.thread_id || null,
    turnId: messageMetadata.turn_id || null,
    status: (messageMetadata.turn_status || (m.role === 'assistant' ? 'completed' : undefined)) as AgentTurnStatus | undefined,
    answerStatus: messageMetadata.answer_status || undefined,
    answerItemId: messageMetadata.answer_item_id || null,
    answerSource: messageMetadata.answer_source || null,
    answerRejectionCode: messageMetadata.answer_rejection_code || null,
    startedAtMs: messageMetadata.started_at ? Date.parse(messageMetadata.started_at) : null,
    completedAtMs: messageMetadata.completed_at ? Date.parse(messageMetadata.completed_at) : null,
    durationMs: Number.isFinite(Number(messageMetadata.duration_ms)) ? Number(messageMetadata.duration_ms) : null,
    error: messageMetadata.error || null,
    turnDiff: typeof messageMetadata.turn_diff === 'string' ? messageMetadata.turn_diff : null,
    workspaceActions:
      messageMetadata.workspace_actions && typeof messageMetadata.workspace_actions === 'object'
        ? messageMetadata.workspace_actions
        : undefined
  }
}

/**
 * A suspended turn can be persisted more than once while it is resumed. Agent
 * still treats those rows as one turn, so history rebuild merges adjacent
 * assistant fragments that share a turn_id.
 */
export function mergeServerMessages(messages: AgentMessage[]): AgentMessage[] {
  const merged: AgentMessage[] = []
  for (const message of messages) {
    const previous = merged[merged.length - 1]
    if (
      previous?.role === 'assistant' &&
      message.role === 'assistant' &&
      previous.turnId &&
      previous.turnId === message.turnId
    ) {
      const removed = new Set(previous.removedBlockIds || [])
      for (const id of message.removedBlockIds || []) removed.add(id)
      for (const block of [...message.blocks, ...(message.workstationBlocks || [])]) removed.delete(block.id)
      const removedBlockIds = [...removed]
      const blocks = previous.blocks.filter((block) => !removed.has(block.id))
      for (const block of message.blocks) {
        const index = blocks.findIndex((candidate) => candidate.id === block.id)
        if (index >= 0) blocks[index] = block
        else blocks.push(block)
      }
      const workstationBlocks = (previous.workstationBlocks || previous.blocks).filter((block) => !removed.has(block.id))
      for (const block of message.workstationBlocks || message.blocks) {
        const index = workstationBlocks.findIndex((candidate) => candidate.id === block.id)
        if (index >= 0) workstationBlocks[index] = block
        else workstationBlocks.push(block)
      }
      merged[merged.length - 1] = {
        ...previous,
        ...message,
        id: previous.id || message.id,
        blocks: foldGenerativeUiBlocks(blocks),
        workstationBlocks: foldGenerativeUiBlocks(workstationBlocks),
        removedBlockIds,
        startedAtMs: previous.startedAtMs ?? message.startedAtMs,
        durationMs:
          previous.durationMs != null && message.durationMs != null
            ? previous.durationMs + message.durationMs
            : message.durationMs ?? previous.durationMs,
        turnDiff: message.turnDiff ?? previous.turnDiff,
        workspaceActions: {
          ...(previous.workspaceActions || {}),
          ...(message.workspaceActions || {})
        }
      }
      continue
    }
    merged.push(message)
  }
  return merged
}

export function mergeWorkspaceEvent(
  previous: DataWorkspaceEvent | null,
  next: DataWorkspaceEvent
): DataWorkspaceEvent {
  const projectId = String(next?.project_id || next?.project?.id || next?.project?.project_id || '').trim()
  return {
    ...(previous || {}),
    ...next,
    project: { ...(previous?.project || {}), ...(next.project || {}), id: projectId, project_id: projectId },
    project_id: projectId
  }
}
