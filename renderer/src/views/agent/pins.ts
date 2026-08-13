// Pinned workspaces/conversations stored entirely in localStorage.
const KEY = 'dsh-pins'

export interface Pins {
  ws: string[] // Pinned workspace ids
  conv: string[] // Pinned conversation ids
}

const EMPTY: Pins = { ws: [], conv: [] }

export function loadPins(): Pins {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { ws: Array.isArray(v.ws) ? v.ws : [], conv: Array.isArray(v.conv) ? v.conv : [] }
  } catch {
    return { ...EMPTY }
  }
}

export function savePins(p: Pins) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

export function togglePin(p: Pins, kind: 'ws' | 'conv', id: string): Pins {
  const list = p[kind]
  const next = list.includes(id) ? list.filter((x) => x !== id) : [id, ...list]
  return { ...p, [kind]: next }
}

export const isPinned = (p: Pins, kind: 'ws' | 'conv', id: string) => p[kind].includes(id)
