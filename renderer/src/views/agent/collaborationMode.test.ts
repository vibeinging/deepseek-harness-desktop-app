import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  conversationCollaborationModeStorageKey,
  loadConversationCollaborationMode,
  normalizeCollaborationMode,
  persistConversationCollaborationMode
} from './collaborationMode'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('conversation collaboration mode', () => {
  it('only accepts the current Codex Default and Plan values', () => {
    expect(normalizeCollaborationMode('default')).toBe('default')
    expect(normalizeCollaborationMode('plan')).toBe('plan')
    expect(normalizeCollaborationMode('legacy-plan')).toBe('default')
  })

  it('persists Plan per conversation and lets a new conversation inherit the project choice', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)

    persistConversationCollaborationMode('project-a', 'thread-1', 'plan')

    expect(loadConversationCollaborationMode('project-a', 'thread-1')).toBe('plan')
    expect(loadConversationCollaborationMode('project-a', null)).toBe('plan')
    expect(loadConversationCollaborationMode('project-b', null)).toBe('default')
    expect(storage.values.get(conversationCollaborationModeStorageKey('project-a', 'thread-1'))).toBe('plan')
  })

  it('falls back to Default when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') }
    })
    expect(loadConversationCollaborationMode('project-a', 'thread-1')).toBe('default')
    expect(() => persistConversationCollaborationMode('project-a', 'thread-1', 'plan')).not.toThrow()
  })
})
