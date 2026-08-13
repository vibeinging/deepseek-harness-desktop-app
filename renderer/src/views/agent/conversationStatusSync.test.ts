import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentConversationStatusEvent } from '../../api/agent'
import {
  CONVERSATION_STATUS_BATCH_WINDOW_MS,
  ConversationSnapshotVersionTracker,
  ConversationStatusRefreshCoordinator,
  ConversationViewedRequestTracker
} from './conversationStatusSync'

afterEach(() => {
  vi.useRealTimers()
})

describe('conversation status event parsing', () => {
  it('normalizes supported status invalidations', () => {
    const event = parseAgentConversationStatusEvent(`data: ${JSON.stringify({
      type: 'conversation_status.changed',
      payload: {
        event_id: 'event-1',
        server_instance_id: 'server-1',
        seq: '7',
        project_id: 'project-1',
        session_id: 'session-1',
        run_id: 'run-1',
        reason: 'run_completed',
        at: '2026-08-09T00:00:00.000Z'
      }
    })}`)

    expect(event).toEqual({
      type: 'conversation_status.changed',
      payload: {
        event_id: 'event-1',
        server_instance_id: 'server-1',
        seq: 7,
        project_id: 'project-1',
        session_id: 'session-1',
        run_id: 'run-1',
        reason: 'run_completed',
        at: '2026-08-09T00:00:00.000Z'
      }
    })
  })

  it('accepts ready without a workspace and ignores malformed or terminal frames', () => {
    expect(parseAgentConversationStatusEvent('data: {"type":"conversation_status.ready","payload":{}}'))
      .toMatchObject({ type: 'conversation_status.ready' })
    expect(parseAgentConversationStatusEvent('data: [DONE]')).toBeNull()
    expect(parseAgentConversationStatusEvent('data: {bad json')).toBeNull()
    expect(parseAgentConversationStatusEvent('data: {"type":"other"}')).toBeNull()
  })
})

describe('ConversationStatusRefreshCoordinator', () => {
  it('batches repeated invalidations independently per workspace', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => undefined)
    const coordinator = new ConversationStatusRefreshCoordinator(refresh)

    coordinator.schedule('project-1')
    coordinator.schedule('project-1')
    coordinator.schedule('project-2')
    await vi.advanceTimersByTimeAsync(CONVERSATION_STATUS_BATCH_WINDOW_MS - 1)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(refresh.mock.calls).toEqual([['project-1'], ['project-2']])
    coordinator.dispose()
  })

  it('keeps a refresh single-flight and reruns once when dirtied while running', async () => {
    vi.useFakeTimers()
    let finishFirst!: () => void
    const firstRefresh = new Promise<void>((resolve) => { finishFirst = resolve })
    let active = 0
    let maxActive = 0
    const refresh = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      if (refresh.mock.calls.length === 1) {
        await firstRefresh
      }
      active -= 1
    })
    const coordinator = new ConversationStatusRefreshCoordinator(refresh)

    coordinator.schedule('project-1')
    await vi.advanceTimersByTimeAsync(CONVERSATION_STATUS_BATCH_WINDOW_MS)
    expect(refresh).toHaveBeenCalledTimes(1)

    coordinator.schedule('project-1')
    coordinator.schedule('project-1')
    finishFirst()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    coordinator.dispose()
  })

  it('retries rejected snapshots with bounded backoff and then stops', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => { throw new Error('offline') })
    const coordinator = new ConversationStatusRefreshCoordinator(refresh, 100, [50, 100])

    coordinator.schedule('project-1', { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(49)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(99)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    coordinator.dispose()
  })

  it('stops retrying as soon as a snapshot refresh succeeds', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const coordinator = new ConversationStatusRefreshCoordinator(refresh, 100, [50, 100])

    coordinator.schedule('project-1', { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(refresh).toHaveBeenCalledTimes(2)
    coordinator.dispose()
  })
})

describe('ConversationViewedRequestTracker', () => {
  it('allows one automatic request and retries a failure only after an explicit click', () => {
    const tracker = new ConversationViewedRequestTracker()

    expect(tracker.claim('run-1')).toBe(true)
    expect(tracker.claim('run-1')).toBe(false)

    tracker.markFailed('run-1')
    expect(tracker.claim('run-1')).toBe(false)
    expect(tracker.claim('run-1', { retryFailed: true })).toBe(true)
    expect(tracker.claim('run-1', { retryFailed: true })).toBe(false)

    tracker.markSucceeded('run-1')
    expect(tracker.claim('run-1')).toBe(true)
    tracker.markSucceeded('run-1')
  })
})

describe('ConversationSnapshotVersionTracker', () => {
  it('rejects a snapshot that started before a local viewed mutation', () => {
    const tracker = new ConversationSnapshotVersionTracker()
    const beforeClick = tracker.begin('project-1')

    tracker.invalidate('project-1')

    expect(tracker.isCurrent('project-1', beforeClick)).toBe(false)
    const afterClick = tracker.begin('project-1')
    expect(tracker.isCurrent('project-1', afterClick)).toBe(true)
    expect(tracker.isCurrent('project-2', afterClick)).toBe(false)
  })
})
