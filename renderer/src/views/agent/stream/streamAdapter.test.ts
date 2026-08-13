import { describe, expect, it } from 'vitest'
import { parseSseJsonLine } from './streamAdapter'

describe('agent stream JSON-RPC adapter', () => {
  it('normalizes an Agent notification for the renderer reducer', () => {
    const event = parseSseJsonLine(`data: ${JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        itemId: null,
        turn: { id: 'turn-1', status: 'inProgress' },
        _meta: { seq: 1, ts: '2026-07-30T00:00:00.000Z' }
      }
    })}`)
    expect(event).toMatchObject({
      type: 'turn/started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      seq: 1
    })
  })
})
