import { describe, expect, it } from 'vitest'
import {
  conversationInputQueueStorageKey,
  loadConversationInputQueue,
  normalizeConversationInputQueue,
  persistConversationInputQueue
} from './inputQueue'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values
  }
}

describe('conversation input queue persistence', () => {
  it('keeps queued turns isolated by project and conversation', () => {
    const storage = memoryStorage()
    persistConversationInputQueue('project-a', 'thread-1', [{ id: 'q1', text: '第一项' }], storage)
    persistConversationInputQueue('project-a', 'thread-2', [{ id: 'q2', text: '第二项' }], storage)

    expect(loadConversationInputQueue('project-a', 'thread-1', storage)).toEqual([{ id: 'q1', text: '第一项' }])
    expect(loadConversationInputQueue('project-a', 'thread-2', storage)).toEqual([{ id: 'q2', text: '第二项' }])
    expect(conversationInputQueueStorageKey('project-b', 'thread-1')).not.toBe(
      conversationInputQueueStorageKey('project-a', 'thread-1')
    )
  })

  it('restores serializable attachments and dispatch data', () => {
    const storage = memoryStorage()
    persistConversationInputQueue('project-a', 'thread-1', [{
      id: 'q1',
      text: '处理附件',
      attachments: [{ path: '/tmp/data.csv', name: 'data.csv', size: 42 }],
      extra: { skills: ['query-project-data'], display_message: '处理附件' }
    }], storage)

    expect(loadConversationInputQueue('project-a', 'thread-1', storage)).toEqual([{
      id: 'q1',
      text: '处理附件',
      attachments: [{ path: '/tmp/data.csv', name: 'data.csv', size: 42 }],
      extra: { skills: ['query-project-data'], display_message: '处理附件' }
    }])
  })

  it('drops malformed items and duplicate ids instead of breaking the composer', () => {
    expect(normalizeConversationInputQueue([
      null,
      { id: 'same', text: '  有效  ' },
      { id: 'same', text: '另一个' },
      { id: 'empty', text: '', attachments: [] },
      { id: 'file', attachments: [{ path: '/tmp/a.txt' }] }
    ])).toEqual([
      { id: 'same', text: '有效' },
      { id: 'same-2', text: '另一个' },
      { id: 'file', text: '', attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }] }
    ])
  })

  it('removes empty queues and tolerates corrupted storage', () => {
    const storage = memoryStorage()
    const key = conversationInputQueueStorageKey('project-a', 'thread-1')
    storage.setItem(key, '{broken')
    expect(loadConversationInputQueue('project-a', 'thread-1', storage)).toEqual([])
    expect(storage.values.has(key)).toBe(false)

    storage.setItem(key, '[]')
    expect(persistConversationInputQueue('project-a', 'thread-1', [], storage)).toBe(true)
    expect(storage.values.has(key)).toBe(false)
  })
})
