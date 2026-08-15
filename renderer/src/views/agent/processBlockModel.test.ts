import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { queryValidationPresentation, toolCallPresentation } from './processBlockModel'

describe('assistant process detail presentation', () => {
  it('reduces a passed query validation to one readable line', () => {
    expect(queryValidationPresentation({
      status: 'passed',
      scope: 'execution_only',
      summary: { total: 14, passed: 14, failed: 0 },
      checks: [
        { name: 'query_succeeded', passed: true, severity: 'error' },
        { name: 'unit', passed: true, severity: 'info' }
      ]
    }, 'SQL 基础校验通过')).toMatchObject({
      title: 'SQL 基础校验通过',
      tone: 'ok',
      scopeLabel: '基础执行检查',
      summary: '14/14 项通过',
      issueSummary: ''
    })
  })

  it('names failed and inconclusive checks without exposing internal keys', () => {
    const failed = queryValidationPresentation({
      status: 'failed',
      scope: 'result_contract',
      summary: { total: 3, passed: 1, failed: 2 },
      checks: [
        { name: 'query_succeeded', passed: true, severity: 'error' },
        { name: 'critical_filters', passed: false, severity: 'error' },
        { name: 'required_columns', passed: false, severity: 'error' }
      ]
    })
    expect(failed.summary).toBe('1/3 项通过 · 2 项未通过')
    expect(failed.issueSummary).toBe('未通过：关键筛选条件、必需字段')
    expect(failed.issueSummary).not.toContain('critical_filters')

    const inconclusive = queryValidationPresentation({
      status: 'inconclusive',
      scope: 'execution_only',
      summary: { total: 2, passed: 1, failed: 0, inconclusive: 1 },
      checks: [
        { name: 'query_succeeded', passed: true, severity: 'error' },
        { name: 'result_contract_declared', passed: false, severity: 'warning' }
      ]
    })
    expect(inconclusive).toMatchObject({
      tone: 'warn',
      summary: '1/2 项通过 · 1 项待确认',
      issueSummary: '待确认：结果约束'
    })
  })

  it('turns tool JSON into a short summary and keeps formatted parameters on demand', () => {
    const tool = toolCallPresentation(
      '查询数据库 {"question":"统计含磷或溴的三键分子的总原子数","database_name":"molecules","sql":"SELECT SUM(atom_count) FROM molecules"}',
      'execute_readonly_sql'
    )
    expect(tool.label).toBe('查询数据库')
    expect(tool.summary).toBe('统计含磷或溴的三键分子的总原子数 · 数据源：molecules')
    expect(tool.rawArguments).toContain('\n  "question"')

    expect(toolCallPresentation('grep_columns {"table_name":"bond"}', 'grep_columns')).toMatchObject({
      label: '检索字段',
      summary: '数据表：bond'
    })
  })

  it('uses progressive disclosure instead of generic Markdown for validation JSON', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./conversation/AssistantContent.tsx', import.meta.url)),
      'utf8'
    ).replace(/\r\n/g, '\n')
    expect(source).toContain("if (b.type === 'evidence_validation')")
    expect(source).toContain('data-query-validation')
    expect(source).toContain('aria-controls={detailId}')
    expect(source).toContain("expanded && (\n            <div id={detailId} className={styles.queryValidationDetails}>")
  })
})

describe('toolCallPresentation dshView title priority', () => {
  it('uses the dshView title when present, ignoring the tool-name table', () => {
    const tool = toolCallPresentation('', 'unknown_tool', {
      for: 'call',
      view: { card: 'generic', title: '自定义标题' }
    })
    expect(tool.label).toBe('自定义标题')
  })

  it('falls back to TOOL_DISPLAY_LABELS when dshView is absent', () => {
    const tool = toolCallPresentation('', 'execute_readonly_sql')
    expect(tool.label).toBe('查询数据库')
  })

  it('falls back to TOOL_DISPLAY_LABELS when dshView has no title', () => {
    const tool = toolCallPresentation('', 'execute_readonly_sql', {
      for: 'call',
      view: { card: 'generic' }
    })
    expect(tool.label).toBe('查询数据库')
  })

  it('dshView title wins over the tool-name table even for a known tool', () => {
    const tool = toolCallPresentation('', 'grep_columns', {
      for: 'call',
      view: { card: 'generic', title: '检索字段（精确）' }
    })
    expect(tool.label).toBe('检索字段（精确）')
  })
})
