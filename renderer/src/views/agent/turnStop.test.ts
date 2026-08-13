import { describe, expect, it, vi } from 'vitest'

import { stopTurnAfterSettlement } from './conversation/turnStop'

describe('agent turn stop contract', () => {
  it('keeps the stream open when the server confirms durable settlement', async () => {
    const abort = vi.fn()
    const interrupt = vi.fn(async () => ({
      data: { settled: true, settlement: { status: 'interrupted', persisted: true } }
    }))

    const result = await stopTurnAfterSettlement({
      threadId: 'thread-1',
      turnId: 'turn-1',
      interrupt,
      abort
    })

    expect(result.settled).toBe(true)
    expect(interrupt).toHaveBeenCalledWith('thread-1', 'turn-1')
    expect(abort).not.toHaveBeenCalled()
  })

  it('closes the stream only as a fallback when settlement cannot be confirmed', async () => {
    const abort = vi.fn()
    const result = await stopTurnAfterSettlement({
      threadId: 'thread-1',
      turnId: 'turn-1',
      interrupt: async () => ({ data: { settled: false } }),
      abort
    })

    expect(result.settled).toBe(false)
    expect(abort).toHaveBeenCalledOnce()
  })

  it('aborts immediately when the native turn id has not arrived yet', async () => {
    const abort = vi.fn()
    const interrupt = vi.fn()
    await stopTurnAfterSettlement({ threadId: 'thread-1', turnId: null, interrupt, abort })
    expect(interrupt).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledOnce()
  })
})
