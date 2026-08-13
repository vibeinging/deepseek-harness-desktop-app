import { describe, expect, it, vi } from 'vitest'
import {
  clearConversationDraft,
  conversationDraftStorageKey,
  loadConversationDraft,
  persistConversationDraft
} from './conversationDraft'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values
  }
}

describe('conversation draft recovery', () => {
  it('isolates drafts by project and conversation, including each project new chat', () => {
    const storage = memoryStorage()
    persistConversationDraft('project-a', 'thread-1', {
      input: 'A1 草稿', attachments: [], reviewComments: [], searchMode: 'auto'
    }, storage)
    persistConversationDraft('project-a', 'thread-2', {
      input: 'A2 草稿', attachments: [], reviewComments: [], searchMode: 'required'
    }, storage)
    persistConversationDraft('project-b', null, {
      input: 'B 新对话', attachments: [], reviewComments: [], searchMode: 'off'
    }, storage)

    expect(loadConversationDraft('project-a', 'thread-1', storage).input).toBe('A1 草稿')
    expect(loadConversationDraft('project-a', 'thread-2', storage).searchMode).toBe('required')
    expect(loadConversationDraft('project-b', null, storage).input).toBe('B 新对话')
    expect(conversationDraftStorageKey('project-a', null)).not.toBe(conversationDraftStorageKey('project-b', null))
  })

  it('restores text, attachments, review comments and per-turn search mode', () => {
    const storage = memoryStorage()
    persistConversationDraft('project-a', 'thread-1', {
      input: '继续修改',
      attachments: [{ path: '/tmp/a.png', name: 'a.png', mimeType: 'image/png', width: 20, height: 10 }],
      reviewComments: [{ id: 'r1', path: '/tmp/app.ts', comment: '改这里', side: 'new', newLine: 8 }],
      searchMode: 'off'
    }, storage)

    expect(loadConversationDraft('project-a', 'thread-1', storage)).toMatchObject({
      input: '继续修改',
      attachments: [{ path: '/tmp/a.png', name: 'a.png', mimeType: 'image/png', width: 20, height: 10 }],
      reviewComments: [{ id: 'r1', path: '/tmp/app.ts', comment: '改这里', side: 'new', newLine: 8 }],
      searchMode: 'off'
    })
  })

  it('keeps the exact managed artifact version across app reloads', () => {
    const storage = memoryStorage()
    persistConversationDraft('project-a', 'thread-1', {
      input: '继续检查这个版本',
      attachments: [{
        path: '/tmp/project_artifacts/project-a/artifact-a/v000003-report.md',
        name: 'report.md',
        mimeType: 'text/markdown',
        artifactId: 'artifact-a',
        artifactVersionId: 'version-3',
        artifactVersionNumber: 3
      }],
      reviewComments: [],
      searchMode: 'auto'
    }, storage)

    expect(loadConversationDraft('project-a', 'thread-1', storage).attachments[0]).toMatchObject({
      artifactId: 'artifact-a',
      artifactVersionId: 'version-3',
      artifactVersionNumber: 3
    })
  })

  it('removes empty drafts, corrupted values and explicit clears', () => {
    const storage = memoryStorage()
    const key = conversationDraftStorageKey('project-a', 'thread-1')
    storage.setItem(key, '{broken')
    expect(loadConversationDraft('project-a', 'thread-1', storage).input).toBe('')
    expect(storage.values.has(key)).toBe(false)

    persistConversationDraft('project-a', 'thread-1', {
      input: 'draft', attachments: [], reviewComments: [], searchMode: 'auto'
    }, storage)
    clearConversationDraft('project-a', 'thread-1', storage)
    expect(storage.values.has(key)).toBe(false)

    persistConversationDraft('project-a', 'thread-1', {
      input: '', attachments: [], reviewComments: [], searchMode: 'auto'
    }, storage)
    expect(storage.values.has(key)).toBe(false)
  })

  it('never blocks the composer when storage fails', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('denied') }),
      setItem: vi.fn(() => { throw new Error('full') }),
      removeItem: vi.fn(() => { throw new Error('denied') })
    }
    expect(loadConversationDraft('project-a', null, storage).input).toBe('')
    expect(() => persistConversationDraft('project-a', null, {
      input: 'draft', attachments: [], reviewComments: [], searchMode: 'auto'
    }, storage)).not.toThrow()
  })
})
