import { describe, expect, it } from 'vitest'
import { conversationDraftStorageKey } from './conversationDraft'
import { moveConversationLocalState } from './conversationMoveState'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
}

describe('conversation move local state', () => {
  it('moves only the local draft and leaves DSH session state authoritative', () => {
    const storage = memoryStorage()
    const sourceKeys = [conversationDraftStorageKey('__chat__', 'conversation-1')]
    const targetKeys = [conversationDraftStorageKey('project-1', 'conversation-1')]
    sourceKeys.forEach((key, index) => storage.setItem(key, `value-${index}`))

    expect(moveConversationLocalState('__chat__', 'project-1', 'conversation-1', storage)).toBe(1)
    sourceKeys.forEach((key) => expect(storage.getItem(key)).toBeNull())
    targetKeys.forEach((key, index) => expect(storage.getItem(key)).toBe(`value-${index}`))
  })
})
