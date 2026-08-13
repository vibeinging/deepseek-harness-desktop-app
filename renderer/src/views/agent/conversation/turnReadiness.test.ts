import { afterEach, describe, expect, it, vi } from 'vitest'

import { waitForActiveTurnTarget } from './turnReadiness'

afterEach(() => {
  vi.useRealTimers()
})

describe('active turn readiness', () => {
  it('returns an already active turn without waiting', async () => {
    await expect(waitForActiveTurnTarget(
      () => ({ threadId: 'thread-1', turnId: 'turn-1' }),
      { timeoutMs: 100 }
    )).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
  })

  it('waits through the startup gap before steering the current turn', async () => {
    vi.useFakeTimers()
    let target: { threadId: string; turnId: string } | null = null
    const waiting = waitForActiveTurnTarget(() => target, { timeoutMs: 100, pollMs: 10 })
    target = { threadId: 'thread-1', turnId: 'turn-1' }
    await vi.advanceTimersByTimeAsync(10)
    await expect(waiting).resolves.toEqual(target)
  })

  it('returns null when the runtime never publishes a turn id', async () => {
    vi.useFakeTimers()
    const waiting = waitForActiveTurnTarget(() => null, { timeoutMs: 30, pollMs: 10 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(waiting).resolves.toBeNull()
  })
})
