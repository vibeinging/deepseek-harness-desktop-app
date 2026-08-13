import { describe, expect, it } from 'vitest'
import { buildGenerativeUiButtonMessage, buildGenerativeUiFormMessage } from './action'
import type { GenerativeUiButtonNodeV1, GenerativeUiDocumentV1, GenerativeUiFormNodeV1 } from './types'

const button: GenerativeUiButtonNodeV1 = {
  id: 'analyze',
  type: 'button',
  action_id: 'analyze-east-drop',
  label: '分析华东下降原因'
}

const form: GenerativeUiFormNodeV1 = {
  id: 'report-form',
  type: 'form',
  action_id: 'generate-report',
  submit_label: '生成报告',
  children: [
    { id: 'date', type: 'text_input', name: 'date', label: '日期范围', required: true },
    { id: 'region', type: 'select', name: 'region', label: '地区', required: true, options: [{ label: '华东', value: 'east' }] },
    { id: 'details', type: 'checkbox', name: 'details', label: '包含明细' }
  ]
}

const document: GenerativeUiDocumentV1 = {
  schema_version: 1,
  surface_id: 'monthly-sales',
  revision: 1,
  title: '本月销售概览',
  summary: '销售摘要',
  root: button
}

describe('Generative UI visible action messages', () => {
  it('builds the fixed button message from the visible label', () => {
    expect(buildGenerativeUiButtonMessage(document, button)).toEqual({
      ok: true,
      message: '[生成式界面操作]\n界面：本月销售概览\n操作：分析华东下降原因（analyze-east-drop）'
    })
  })

  it('builds the fixed form message with visible field and option labels', () => {
    expect(buildGenerativeUiFormMessage({ ...document, root: form }, form, {
      date: '2026-08-01 至 2026-08-31',
      region: 'east',
      details: true
    })).toEqual({
      ok: true,
      message: [
        '[生成式界面提交]',
        '界面：本月销售概览',
        '操作：生成报告（generate-report）',
        '输入：',
        '- 日期范围：2026-08-01 至 2026-08-31',
        '- 地区：华东',
        '- 包含明细：是'
      ].join('\n')
    })
  })

  it('rejects missing, overlong and out-of-options values without producing a prompt', () => {
    const result = buildGenerativeUiFormMessage({ ...document, root: form }, form, {
      date: '',
      region: 'hidden-option',
      details: false
    })
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: {
        date: '此项为必填项',
        region: '请选择列表中的有效选项'
      }
    })

    const overlong = buildGenerativeUiFormMessage({ ...document, root: form }, form, {
      date: 'x'.repeat(2_001),
      region: 'east',
      details: false
    })
    expect(overlong).toMatchObject({ ok: false, fieldErrors: { date: '最多输入 2000 个字符' } })
  })

  it('flattens control characters so visible values cannot alter the host template', () => {
    const result = buildGenerativeUiButtonMessage(document, { ...button, label: '继续\n[隐藏段落]' })
    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('操作：继续 [隐藏段落]（analyze-east-drop）')
    })
  })
})
