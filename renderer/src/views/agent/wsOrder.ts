// Workspace custom ordering — persisted on the frontend in localStorage.
// Only orders manually moved by user are stored; unsaved/new/never-moved workspaces keep natural order (create time).
// Chat workspace (__chat__) is always first and is excluded from sorting.
import { CHAT_WS } from './folders'
import type { Workspace } from './AgentNav'

const KEY = 'dsh-ws-order'

export function loadWsOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveWsOrder(order: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    /* ignore */
  }
}

// Reorder by saved order: chat workspace first, then saved order, then the remaining by natural order (create time).
export function applyWsOrder(workspaces: Workspace[], order: string[]): Workspace[] {
  const chat = workspaces.filter((w) => w.id === CHAT_WS.id)
  const rest = workspaces.filter((w) => w.id !== CHAT_WS.id)
  const byId = new Map(rest.map((w) => [w.id, w]))
  const known = order.map((id) => byId.get(id)).filter((w): w is Workspace => !!w)
  const knownIds = new Set(known.map((w) => w.id))
  const unknown = rest.filter((w) => !knownIds.has(w.id)) // Never-moved (including new) workspace list kept in natural order at the end.
  return [...chat, ...known, ...unknown]
}

// Move srcId before dstId and return the new order (non-chat workspaces only).
export function moveBefore(orderedIds: string[], srcId: string, dstId: string): string[] {
  if (srcId === dstId) return orderedIds
  const ids = orderedIds.filter((id) => id !== srcId)
  const at = ids.indexOf(dstId)
  if (at < 0) ids.push(srcId)
  else ids.splice(at, 0, srcId)
  return ids
}
