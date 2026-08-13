import type { Workspace } from './AgentNav'

export const CHAT_WS: Workspace = { id: '__chat__', name: '聊天' }

export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

// Native folder picker (Electron only, via window.electronAPI.pickFolder -> dialog.showOpenDialog through preload).
// In browser environment there is no electronAPI, so return null and let callers handle it silently.
export async function pickFolder(): Promise<string | null> {
  const fn = (window as any).electronAPI?.pickFolder
  if (typeof fn !== 'function') return null
  try {
    const res = await fn()
    return typeof res === 'string' ? res : null
  } catch {
    return null
  }
}

export interface PickedPath {
  path: string
  isDir: boolean
}

export function mergeUniquePathItems<T extends { path: string }>(current: T[], incoming: T[]): T[] {
  const result = [...current]
  const seen = new Set(current.map((item) => item.path).filter(Boolean))
  for (const item of incoming) {
    if (!item?.path || seen.has(item.path)) continue
    seen.add(item.path)
    result.push(item)
  }
  return result
}

// One native picker supports both files and folders (multi-select enabled).
// Electron: ipc -> dialog.showOpenDialog({properties:['openFile','openDirectory','multiSelections']}), browser -> [].
export async function pickFilesOrFolders(defaultPath?: string | null): Promise<PickedPath[]> {
  const fn = (window as any).electronAPI?.pickPaths
  if (typeof fn !== 'function') return []
  try {
    const res = await fn(defaultPath || null)
    return Array.isArray(res) ? res.filter((x: any) => x && typeof x.path === 'string') : []
  } catch {
    return []
  }
}

// Resolve OS files/folders dropped into the Electron window and register the same local-path
// authorization granted by the native picker. Browser mode has no trusted local path and returns [].
export async function registerDroppedFiles(files: File[]): Promise<PickedPath[]> {
  const fn = (window as any).electronAPI?.registerDroppedFile
  if (typeof fn !== 'function' || files.length === 0) return []
  try {
    const res = await Promise.all(files.slice(0, 200).map((file) => fn(file)))
    return res.filter((item: any) => item && typeof item.path === 'string')
  } catch {
    return []
  }
}

// Is running inside desktop shell (Electron).
export const isDesktop = () => typeof (window as any).electronAPI !== 'undefined'

// Reveal folder in Finder / file manager via shell.showItemInFolder in Electron.
export async function revealInFinder(path: string): Promise<boolean> {
  const fn = (window as any).electronAPI?.revealInFinder
  if (typeof fn !== 'function') return false
  try {
    return (await fn(path)) !== false
  } catch {
    return false
  }
}

export async function openLocalFile(path: string): Promise<boolean> {
  const fn = (window as any).electronAPI?.openLocalFile
  if (typeof fn !== 'function') return false
  try {
    return (await fn(path)) !== false
  } catch {
    return false
  }
}

// Native-picked source folders are already authorized. This call additionally
// allows exact app-owned project output roots so image preview/open/reveal work
// without granting arbitrary local paths to the renderer.
export async function authorizePreviewRoot(path: string): Promise<boolean> {
  const fn = (window as any).electronAPI?.authorizePreviewRoot
  if (typeof fn !== 'function') return false
  try {
    return (await fn(path)) !== false
  } catch {
    return false
  }
}
