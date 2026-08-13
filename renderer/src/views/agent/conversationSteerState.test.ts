import { describe, expect, it } from 'vitest'

import type { AgentMessage } from './stream/types'
import { insertSteerUserMessage } from './conversation/messageState'

describe('steer conversation ordering', () => {
  it('places accepted steer input before the active assistant turn so reload keeps the same order', () => {
    const current: AgentMessage[] = [
      { id: 'user-1', role: 'user', blocks: [] },
      {
        id: 'assistant-1',
        role: 'assistant',
        blocks: [{ id: 'commentary-1', type: 'markdown', content: '正在检查' }],
        turnId: 'turn-1',
        status: 'inProgress'
      }
    ]
    const steered: AgentMessage = {
      id: 'user-steer-1',
      role: 'user',
      blocks: [{ id: 'steer-text', type: 'text', content: '再检查测试' }],
      turnId: 'turn-1'
    }

    expect(insertSteerUserMessage(current, steered, 'turn-1').map((message) => message.id)).toEqual([
      'user-1',
      'user-steer-1',
      'assistant-1'
    ])
  })

  it('appends steer input when the target turn is no longer active', () => {
    const current: AgentMessage[] = [{
      id: 'assistant-1',
      role: 'assistant',
      blocks: [],
      turnId: 'turn-1',
      status: 'completed'
    }]
    const steered: AgentMessage = { id: 'user-steer-1', role: 'user', blocks: [] }
    expect(insertSteerUserMessage(current, steered, 'turn-1').map((message) => message.id)).toEqual([
      'assistant-1',
      'user-steer-1'
    ])
  })
})
