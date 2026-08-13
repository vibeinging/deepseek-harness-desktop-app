import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '../stream/types'
import { applyBlockToMessages, applyTurnToMessages } from './messageState'

describe('turn-scoped assistant projection', () => {
  it('claims an unbound pending assistant for a new explicit turn', () => {
    const messages: AgentMessage[] = [
      { id: 'assistant-old', role: 'assistant', blocks: [], turnId: 'turn-old', status: 'completed' },
      { id: 'user-review', role: 'user', blocks: [] },
      { id: 'pending-review', role: 'assistant', blocks: [], status: 'pending' }
    ]

    const next = applyTurnToMessages(messages, {
      threadId: 'thread-1',
      turnId: 'turn-review',
      status: 'inProgress'
    })

    expect(next).toHaveLength(3)
    expect(next[0]).toMatchObject({ id: 'assistant-old', turnId: 'turn-old', status: 'completed' })
    expect(next[2]).toMatchObject({ id: 'pending-review', turnId: 'turn-review', status: 'inProgress' })
  })

  it('creates a new assistant instead of overwriting a completed different turn', () => {
    const messages: AgentMessage[] = [
      { id: 'assistant-old', role: 'assistant', blocks: [], turnId: 'turn-old', status: 'completed' },
      { id: 'user-review', role: 'user', blocks: [] }
    ]

    const next = applyTurnToMessages(messages, {
      messageId: 'assistant-review',
      threadId: 'thread-1',
      turnId: 'turn-review',
      status: 'inProgress'
    })

    expect(next.map((message) => message.id)).toEqual(['assistant-old', 'user-review', 'assistant-review'])
    expect(next[0]).toMatchObject({ turnId: 'turn-old', status: 'completed' })
    expect(next[2]).toMatchObject({ turnId: 'turn-review', status: 'inProgress' })
  })

  it('does not attach a block for an unknown turn to an older completed assistant', () => {
    const messages: AgentMessage[] = [
      { id: 'assistant-old', role: 'assistant', blocks: [], turnId: 'turn-old', status: 'completed' }
    ]

    expect(applyBlockToMessages(messages, {
      id: 'review-note',
      type: 'markdown',
      content: 'reviewing'
    }, { threadId: 'thread-1', turnId: 'turn-review' })).toEqual(messages)
  })

  it('repairs an existing duplicate id before applying the next snapshot', () => {
    const messages: AgentMessage[] = [{
      id: 'assistant',
      role: 'assistant',
      turnId: 'turn-1',
      status: 'inProgress',
      blocks: [
        { id: 'same', type: 'thinking', content: 'old-a' },
        { id: 'same', type: 'thinking', content: 'old-b' }
      ]
    }]
    const next = applyBlockToMessages(messages, {
      id: 'same',
      type: 'thinking',
      content: 'latest'
    }, { turnId: 'turn-1' })
    expect(next[0].blocks).toEqual([{ id: 'same', type: 'thinking', content: 'latest' }])
  })
})
