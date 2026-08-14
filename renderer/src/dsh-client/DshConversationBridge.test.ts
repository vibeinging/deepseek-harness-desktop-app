import { describe, expect, it, vi } from 'vitest'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { DshConversationBridge } from './DshConversationBridge'

function sessionList() {
  let snapshot: SessionListState = {
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: SessionListState) {
      snapshot = next
      for (const listener of listeners) listener()
    }
  }
}

describe('DshConversationBridge', () => {
  it('opens the bound DSH Session only after the Client list knows it', () => {
    const list = sessionList()
    const open = vi.fn()
    const clear = vi.fn()
    const bridge = new DshConversationBridge({ list, open, clear })
    const sessionId = 'dsh-session-1' as SessionId

    bridge.syncSession(sessionId)
    expect(open).not.toHaveBeenCalled()

    list.set({
      ...list.getSnapshot(),
      ids: [sessionId],
      byId: {
        [sessionId]: {
          id: sessionId,
          displayTitle: 'Session',
          running: false,
          blank: false,
          updatedAt: 1
        }
      }
    })
    expect(open).toHaveBeenCalledWith(sessionId)
    expect(clear).not.toHaveBeenCalled()

    bridge.dispose()
  })

  it('publishes one stable read-only draft and clears the staged Session explicitly', () => {
    const sessionId = 'dsh-session-2' as SessionId
    const list = sessionList()
    list.set({
      ...list.getSnapshot(),
      ids: [sessionId],
      current: sessionId,
      byId: {
        [sessionId]: {
          id: sessionId,
          displayTitle: 'Session',
          running: false,
          blank: false,
          updatedAt: 1
        }
      }
    })
    const clear = vi.fn()
    const bridge = new DshConversationBridge({ list, open: vi.fn(), clear })
    const listener = vi.fn()
    bridge.subscribeInput(listener)

    bridge.syncSession(sessionId)
    bridge.updateDraft('hello')
    const snapshot = bridge.getInputSnapshot()
    bridge.updateDraft('hello')

    expect(snapshot).toMatchObject({ draft: 'hello', draftRev: 2, phase: 'plain' })
    expect(listener).toHaveBeenCalledTimes(2)

    bridge.syncSession(null)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(bridge.getInputSnapshot().draft).toBe('')

    bridge.dispose()
  })
})
