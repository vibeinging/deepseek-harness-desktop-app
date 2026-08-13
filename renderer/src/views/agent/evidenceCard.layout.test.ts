import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evidenceRerunCopy, evidenceStatusCopy } from './evidenceCardModel'

const conversationSource = [
  './AgentConversation.tsx',
  './conversation/AssistantContent.tsx'
].map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).join('\n')
const cardSource = readFileSync(fileURLToPath(new URL('./EvidenceCard.tsx', import.meta.url)), 'utf8')
const styleSource = readFileSync(fileURLToPath(new URL('./evidenceCard.module.scss', import.meta.url)), 'utf8')

describe('answer evidence card contract', () => {
  it('renders final answer evidence as a collapsed progressive disclosure card', () => {
    expect(conversationSource).toContain('evidence_bundle_ref')
    expect(conversationSource).toContain('<EvidenceCard')
    expect(cardSource).toContain('data-evidence-card')
    expect(cardSource).toContain('data-evidence-toggle')
    expect(cardSource).toContain('数据来自哪里')
    expect(cardSource).toContain('实际算了什么')
    expect(cardSource).toContain('检查了什么')
    expect(cardSource).toContain('data-evidence-action="rerun"')
    expect(cardSource).toContain('同一查询复跑')
    expect(styleSource).toContain('grid-template-rows: 0fr')
    expect(styleSource).toContain('@container (max-width: 390px)')
  })

  it('uses direct, readable verification labels', () => {
    expect(evidenceStatusCopy('verified')).toEqual({ label: '已验证', tone: 'ok' })
    expect(evidenceStatusCopy('needs_attention')).toEqual({ label: '有待确认项', tone: 'warn' })
  })

  it('summarizes identical and changed reruns in plain language', () => {
    expect(evidenceRerunCopy({ summary: { identical: true } })).toEqual({
      tone: 'ok', title: '复跑一致', detail: '数据、Schema 和检查均未变化'
    })
    expect(evidenceRerunCopy({
      summary: { identical: false, schema_changed: false, changed_validation_count: 0, data_changed: true },
      queries: [{ row_count: { delta: 1 }, numeric_summary: { amount: { changed: true, sum_delta: 150 } } }]
    })).toEqual({ tone: 'warn', title: '发现变化', detail: '行数 +1 · amount 合计 +150' })
  })
})
