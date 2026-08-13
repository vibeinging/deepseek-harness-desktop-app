import { describe, expect, it } from 'vitest'
import {
  markNativeUserInputResolved,
  mergeNativePendingInteractions
} from './AgentConversation'
import type { AgentMessage } from './stream/types'

function nativeInteraction(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    kind: 'native_user_input',
    status: 'pending',
    request_id: 'request-1',
    run_id: 'run-1',
    session_id: 'session-1',
    resolution: {
      type: 'native_turn',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'item-1'
    },
    block: {
      id: 'user_input:item-1',
      type: 'user_input',
      content: JSON.stringify({
        questions: [{ id: 'choice', question: '请选择', options: [{ label: 'A' }] }]
      }),
      title: 'requested',
      metadata: {}
    },
    created_at: '2026-08-09T00:00:00.000Z',
    ...overrides
  }
}

describe('native pending interaction hydration', () => {
  it('adds one temporary suspended turn and ignores duplicate or foreign blocks', () => {
    const history: AgentMessage[] = [{
      id: 'assistant-1',
      role: 'assistant',
      blocks: [
        { id: 'confirm:existing', type: 'confirm', content: 'existing' },
        { id: 'user_input:item-1', type: 'user_input', content: '{}', title: 'stopped' }
      ],
      status: 'completed'
    }]
    const valid = nativeInteraction()
    const result = mergeNativePendingInteractions(history, [
      valid,
      nativeInteraction({ block: { ...valid.block, id: 'user_input:duplicate' } }),
      nativeInteraction({ request_id: 'foreign', session_id: 'session-2' }),
      nativeInteraction({ request_id: 'durable', resolution: { type: 'durable' } })
    ], 'session-1')

    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({
      id: 'pending-interactions:session-1',
      status: 'suspended',
      threadId: 'thread-1',
      turnId: 'turn-1'
    })
    expect(result[1].blocks).toHaveLength(1)
    expect(result.flatMap((message) => message.blocks).filter((block) => block.id === 'user_input:item-1'))
      .toHaveLength(1)
    expect(JSON.parse(result[1].blocks[0].content)).toMatchObject({
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'item-1'
    })
  })

  it('injects native approval coordinates and rejects malformed user input', () => {
    const confirm = nativeInteraction({
      kind: 'native_approval',
      request_id: 'approval-1',
      resolution: { type: 'native_turn', thread_id: 'thread-2', turn_id: 'turn-2', item_id: 'approval-item' },
      block: {
        id: 'confirm:approval-item',
        type: 'confirm',
        content: '执行命令',
        title: 'requested',
        metadata: { approval_request: { risk: 'command_execution' } }
      }
    })
    const malformed = nativeInteraction({ request_id: 'bad', block: { ...nativeInteraction().block, content: '{}' } })
    const result = mergeNativePendingInteractions([], [confirm, malformed], 'session-1')

    expect(result[0].blocks).toHaveLength(1)
    expect(result[0].blocks[0].metadata?.approval_request).toMatchObject({
      risk: 'command_execution',
      threadId: 'thread-2',
      turnId: 'turn-2',
      itemId: 'approval-item'
    })
  })

  it('marks a native user-input card resolved without touching another item', () => {
    const hydrated = mergeNativePendingInteractions([], [nativeInteraction()], 'session-1')
    const answers = { choice: { answers: ['A'] } }
    const resolved = markNativeUserInputResolved(hydrated, 'item-1', answers)

    expect(resolved[0].blocks[0]).toMatchObject({
      id: 'user_input:item-1',
      title: 'resolved',
      metadata: { status: 'answered', response: answers }
    })
    expect(markNativeUserInputResolved(resolved, 'other-item', answers)).toBe(resolved)
  })
})
