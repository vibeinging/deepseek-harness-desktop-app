import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizePreviewRoot, mergeUniquePathItems } from './folders'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attachment path merge', () => {
  it('keeps order while removing existing and same-drop duplicates', () => {
    const current = [{ path: '/tmp/a.csv', isDir: false }]
    const incoming = [
      { path: '/tmp/a.csv', isDir: false },
      { path: '/tmp/folder', isDir: true },
      { path: '/tmp/folder', isDir: true },
      { path: '', isDir: false }
    ]

    expect(mergeUniquePathItems(current, incoming)).toEqual([
      { path: '/tmp/a.csv', isDir: false },
      { path: '/tmp/folder', isDir: true }
    ])
  })
})

describe('workspace preview root authorization', () => {
  it('uses the narrow desktop bridge for a backend-returned root', async () => {
    const authorize = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', { electronAPI: { authorizePreviewRoot: authorize } })

    await expect(authorizePreviewRoot('/tmp/project-output')).resolves.toBe(true)
    expect(authorize).toHaveBeenCalledWith('/tmp/project-output')
  })
})
