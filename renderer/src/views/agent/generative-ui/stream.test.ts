import { describe, expect, it } from 'vitest'
import { reduceStreamEvent } from '../stream/reducer'
import { mapServerMessage, mergeServerMessages } from '../stream/streamAdapter'

function document(revision: number, text = `版本 ${revision}`) {
  return {
    schema_version: 1,
    surface_id: 'monthly-sales',
    revision,
    title: '本月销售概览',
    summary: text,
    root: { id: `root-${revision}`, type: 'text', text }
  }
}

function contentItem(revision: number, id = `ui-${revision}`) {
  const value = document(revision)
  return {
    id,
    type: 'generative_ui',
    content: value.summary,
    metadata: {
      content_type: 'generative_ui',
      surface_id: value.surface_id,
      revision,
      document_hash: `sha256:${revision}`,
      generative_ui: { document: value, document_hash: `sha256:${revision}` }
    }
  }
}

describe('Generative UI stream and history snapshots', () => {
  it('projects one immutable completed item and exposes its replacement target', () => {
    const value = document(2)
    const patch = reduceStreamEvent({
      type: 'dsh/item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'ui-2',
      payload: {
        item: {
          id: 'ui-2',
          type: 'generativeUi',
          content: value.summary,
          metadata: {
            replaces_item_id: 'ui-1',
            document_hash: 'sha256:two',
            generative_ui: { document: value, document_hash: 'sha256:two' }
          }
        }
      }
    })

    expect(patch.removeBlockId).toBe('ui-1')
    expect(patch.block).toMatchObject({
      id: 'ui-2',
      type: 'generative_ui',
      content: '版本 2',
      metadata: {
        item_type: 'generativeUi',
        content_type: 'generative_ui',
        result_role: 'deliverable',
        surface_id: 'monthly-sales',
        revision: 2,
        document_hash: 'sha256:two'
      }
    })
    expect(patch.block?.metadata.generative_ui.document).toEqual(value)
  })

  it('restores only the highest revision in one historical assistant turn', () => {
    const message = mapServerMessage({
      id: 'assistant-1',
      role: 'assistant',
      message_metadata: { turn_id: 'turn-1', turn_status: 'completed' },
      content_items: [contentItem(1), { id: 'answer', type: 'markdown', content: '完成' }, contentItem(3), contentItem(2)]
    })

    expect(message.blocks.map((block) => block.id)).toEqual(['answer', 'ui-3'])
    expect(message.blocks[1]).toMatchObject({ content: '版本 3', metadata: { revision: 3 } })
  })

  it('folds resumed fragments of the same turn but never deletes a Surface from another turn', () => {
    const messages = mergeServerMessages([
      mapServerMessage({
        id: 'assistant-a',
        role: 'assistant',
        message_metadata: { turn_id: 'turn-a', turn_status: 'completed' },
        content_items: [contentItem(1, 'turn-a-ui')]
      }),
      mapServerMessage({
        id: 'assistant-b',
        role: 'assistant',
        message_metadata: { turn_id: 'turn-b', turn_status: 'completed' },
        content_items: [contentItem(2, 'turn-b-ui')]
      })
    ])

    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.blocks[0].id)).toEqual(['turn-a-ui', 'turn-b-ui'])
  })

  it('keeps the previous content-JSON shape readable without treating new summaries as JSON', () => {
    const legacy = document(1, '旧版摘要')
    const message = mapServerMessage({
      role: 'assistant',
      message_metadata: { turn_id: 'turn-legacy', turn_status: 'completed' },
      content_items: [{ id: 'legacy-ui', type: 'generative_ui', content: JSON.stringify(legacy) }]
    })

    expect(message.blocks[0]).toMatchObject({
      type: 'generative_ui',
      content: '旧版摘要',
      metadata: { surface_id: 'monthly-sales', revision: 1 }
    })
    expect(message.blocks[0].metadata.generative_ui.document).toBe(JSON.stringify(legacy))
  })
})
