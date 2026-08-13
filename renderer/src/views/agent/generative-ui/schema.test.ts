import { describe, expect, it } from 'vitest'
import {
  foldGenerativeUiBlocks,
  generativeUiSummaryFromBlock,
  parseGenerativeUiBlock,
  parseGenerativeUiDocument
} from './schema'
import type { AgentBlock } from '../stream/types'

function document(root: any, extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    surface_id: 'sales-summary',
    revision: 1,
    title: '销售概览',
    summary: '销售额增长，华东需要继续分析。',
    root,
    ...extra
  }
}

function block(revision: number, id = `ui-${revision}`): AgentBlock {
  const value = document({ id: `root-${revision}`, type: 'state', state: 'empty', title: '暂无异常' }, { revision })
  return {
    id,
    type: 'generative_ui',
    content: value.summary,
    metadata: {
      item_type: 'generativeUi',
      generative_ui: { document: value, document_hash: `sha256:${revision}` }
    }
  }
}

describe('Generative UI v1 schema', () => {
  it('accepts the trusted component set including state and required summary', () => {
    const result = parseGenerativeUiDocument(document({
      id: 'root',
      type: 'stack',
      children: [
        { id: 'loading', type: 'state', state: 'loading', title: '正在汇总' },
        { id: 'metric', type: 'metric', label: '销售额', value: 1240, delta: '+8.2%', trend: 'up' },
        {
          id: 'form',
          type: 'form',
          action_id: 'generate-report',
          submit_label: '生成报告',
          children: [
            { id: 'region', type: 'select', name: 'region', label: '地区', required: true, options: [{ label: '华东', value: 'east' }] },
            { id: 'details', type: 'checkbox', name: 'details', label: '包含明细' }
          ]
        }
      ]
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.document.summary).toBe('销售额增长，华东需要继续分析。')
      expect(result.document.root.type).toBe('stack')
    }
  })

  it('requires summary and rejects hidden action fields and duplicate node ids', () => {
    const noSummary: any = document({ id: 'root', type: 'text', text: '结果' })
    delete noSummary.summary
    expect(parseGenerativeUiDocument(noSummary)).toMatchObject({
      ok: false,
      error: { path: '$.summary' }
    })

    expect(parseGenerativeUiDocument(document({
      id: 'root',
      type: 'button',
      action_id: 'run',
      label: '继续',
      prompt: '隐藏指令'
    }))).toMatchObject({
      ok: false,
      error: { path: '$.root.prompt' }
    })

    expect(parseGenerativeUiDocument(document({
      id: 'root',
      type: 'stack',
      children: [
        { id: 'same', type: 'text', text: 'A' },
        { id: 'same', type: 'text', text: 'B' }
      ]
    }))).toMatchObject({
      ok: false,
      error: { path: '$.root.children[1].id' }
    })
  })

  it('accepts controlled HTTPS and local images but rejects unsafe schemes, userinfo and SVG data', () => {
    const imageResult = (src: string) => parseGenerativeUiDocument(document({
      id: 'image', type: 'image', src, alt: '销售趋势'
    }))

    expect(imageResult('https://cdn.example.com/report.png').ok).toBe(true)
    expect(imageResult('/validated/project/report.png').ok).toBe(true)
    expect(imageResult('dsh-file://local/c2FmZQ').ok).toBe(true)
    expect(imageResult('http://cdn.example.com/report.png').ok).toBe(false)
    expect(imageResult('file:///tmp/report.png').ok).toBe(false)
    expect(imageResult('https://user:secret@cdn.example.com/report.png').ok).toBe(false)
    expect(imageResult('data:image/svg+xml;base64,PHN2Zz4=').ok).toBe(false)
    expect(imageResult('javascript:alert(1)').ok).toBe(false)
  })

  it('reads the metadata snapshot first and keeps old content JSON readable', () => {
    const current = block(2)
    expect(parseGenerativeUiBlock(current)).toMatchObject({
      ok: true,
      document: { surface_id: 'sales-summary', revision: 2 }
    })
    expect(generativeUiSummaryFromBlock(current)).toBe('销售额增长，华东需要继续分析。')

    const legacyDocument = document({ id: 'legacy-root', type: 'text', text: '旧数据' })
    const legacy: AgentBlock = {
      id: 'legacy',
      type: 'generative_ui',
      content: JSON.stringify(legacyDocument)
    }
    expect(parseGenerativeUiBlock(legacy)).toMatchObject({ ok: true })
  })

  it('keeps only the highest valid revision inside one assistant block list', () => {
    const ordinary: AgentBlock = { id: 'answer', type: 'markdown', content: '完成' }
    expect(foldGenerativeUiBlocks([block(2), ordinary, block(1), block(3)]).map((item) => item.id))
      .toEqual(['answer', 'ui-3'])
  })
})
