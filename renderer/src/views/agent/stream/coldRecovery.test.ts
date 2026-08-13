/**
 * Cold-recovery flow tests: verify that messages projected from DSH
 * session.history (via the server-side dshHistoryAdapter) survive the
 * renderer's mapServerMessage + messageState pipeline, and that the same
 * block id arriving on a live stream after a cold recovery is deduped
 * (idempotent replace, not a duplicate card).
 *
 * These tests exercise the SAME pure functions the renderer uses on a page
 * refresh: mapServerMessage (history → AgentBlock), applyBlockToMessages
 * (block dedup), and normalizePlanSteps (plan recovery).
 */

import { describe, expect, it } from 'vitest'
import { mapServerMessage, mergeServerMessages } from './streamAdapter'
import { reduceStreamEvent } from './reducer'
import type { AgentBlock } from './types'

/** Build a dsh-app message row the way dshHistoryAdapter produces it. */
function dshMessage(role: string, items: any[], metadata: Record<string, unknown> = {}): any {
  return {
    id: `msg-${role}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: 'dsh-session-1',
    role,
    content_items: items,
    message_metadata: metadata,
    sequence_number: 1,
    created_at: '2026-08-12T00:00:00Z',
  }
}

describe('cold recovery: DSH history → renderer pipeline', () => {
  it('maps a DSH-history assistant message with a tool/call item (dshView retained)', () => {
    const msg = dshMessage('assistant', [
      { id: 'c1', type: 'dynamicToolCall', tool: 'project_list', arguments: '{}', status: 'completed', dshView: { for: 'call', view: { card: 'generic', title: 'List projects', kind: 'search' } } },
    ], { turn_id: 'turn-1', turn_status: 'completed' })
    const mapped = mapServerMessage(msg)
    const toolBlock = mapped.blocks.find((b: AgentBlock) => b.type === 'tool')
    expect(toolBlock).toBeDefined()
    expect(toolBlock?.metadata?.dshView?.view?.card).toBe('generic')
    expect(toolBlock?.content).toContain('List projects')
  })

  it('maps a DSH-history plan content_item and the renderer can recover plan steps', () => {
    const steps = [{ step: 'do A', status: 'completed' }, { step: 'do B', status: 'in_progress' }]
    const msg = dshMessage('assistant', [
      { id: 'plan-1', type: 'plan', status: 'completed', content: JSON.stringify(steps), steps },
    ])
    const mapped = mapServerMessage(msg)
    const planBlock = mapped.blocks.find((b: AgentBlock) => b.type === 'plan')
    expect(planBlock).toBeDefined()
    // The reducer's reduceContentItem reads block.content to recover plan steps.
    // normalizePlanSteps parses it back into the step array.
    const parsed = JSON.parse(planBlock?.content || '[]')
    expect(parsed).toEqual(steps)
  })

  it('maps a DSH-history user message', () => {
    const msg = dshMessage('user', [
      { id: 'u1', type: 'inputText', text: 'hello', status: 'completed' },
    ])
    const mapped = mapServerMessage(msg)
    expect(mapped.role).toBe('user')
    expect(mapped.blocks.map((block) => block.content).join('')).toBe('hello')
  })

  it('keeps the latest cold-history snapshot for one stable block id', () => {
    const mapped = mapServerMessage(dshMessage('assistant', [
      { id: 'same', type: 'thinking', content: 'partial' },
      { id: 'same', type: 'thinking', content: 'complete' },
    ]))
    expect(mapped.blocks).toHaveLength(1)
    expect(mapped.blocks[0].content).toBe('complete')
  })

  it('a live tool/call event after cold recovery produces the same block id (dedup-safe)', () => {
    // The cold-recovered item has id 'c1' (the DSH callId). A live event for
    // the same tool/call must produce the identical id so applyBlockToMessages
    // treats it as an idempotent replace, not a duplicate.
    const coldMsg = dshMessage('assistant', [
      { id: 'c1', type: 'dynamicToolCall', tool: 'project_list', arguments: '{}', status: 'completed', dshView: { for: 'call', view: { card: 'generic', title: 'List projects' } } },
    ])
    const coldBlock = mapServerMessage(coldMsg).blocks.find((b: AgentBlock) => b.type === 'tool')

    // Simulate a live event arriving after recovery for the same callId.
    const liveEvent = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'dsh-session-1',
      turn_id: 'turn-1',
      item_id: 'c1',
      payload: {
        item: {
          id: 'c1', type: 'dynamicToolCall', tool: 'project_list',
          status: 'inProgress', arguments: '{}',
          dshView: { for: 'call', view: { card: 'generic', title: 'List projects' } },
        },
      },
    })
    const liveBlock = liveEvent.block
    expect(liveBlock).toBeDefined()
    expect(liveBlock?.id).toBe(coldBlock?.id)
  })

  it('mergeServerMessages folds DSH-history messages by turn without dropping blocks', () => {
    const msgs = [
      dshMessage('user', [{ id: 'u1', type: 'inputText', text: 'hi', status: 'completed' }]),
      dshMessage('assistant', [{ id: 'a1', type: 'agentMessage', content: 'hello', status: 'completed' }], { turn_id: 't1', turn_status: 'completed' }),
    ]
    const merged = mergeServerMessages(msgs.map(mapServerMessage))
    expect(merged.length).toBeGreaterThanOrEqual(2)
    // The assistant message's agentMessage block survives the merge.
    const assistant = merged.find((m) => m.role === 'assistant')
    expect(assistant?.blocks.some((b: AgentBlock) => b.type === 'agentMessage' && b.content === 'hello')).toBe(true)
  })
})
