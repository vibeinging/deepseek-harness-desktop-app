import { conversationDraftStorageKey } from './conversationDraft'

type MoveStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

function defaultStorage(): MoveStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function moveConversationLocalState(
  fromProjectId: string,
  targetProjectId: string,
  conversationId: string,
  storage: MoveStorage | null = defaultStorage()
) {
  if (!storage || !fromProjectId || !targetProjectId || !conversationId || fromProjectId === targetProjectId) return 0
  const keys = [
    [conversationDraftStorageKey(fromProjectId, conversationId), conversationDraftStorageKey(targetProjectId, conversationId)]
  ]
  let moved = 0
  for (const [source, target] of keys) {
    if (!source || !target) continue
    try {
      const value = storage.getItem(source)
      if (value == null) continue
      storage.setItem(target, value)
      storage.removeItem(source)
      moved += 1
    } catch {
      // Local preferences are best-effort; the server-side move remains authoritative.
    }
  }
  return moved
}
