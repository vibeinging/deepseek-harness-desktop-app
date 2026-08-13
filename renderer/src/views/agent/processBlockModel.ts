type JsonRecord = Record<string, unknown>

export type ProcessDetailTone = 'ok' | 'warn' | 'danger' | 'neutral'

export interface QueryValidationPresentation {
  title: string
  tone: ProcessDetailTone
  scopeLabel: string
  summary: string
  issueSummary: string
  rawJson: string
}

export interface ToolCallPresentation {
  label: string
  summary: string
  rawArguments: string
}

const VALIDATION_CHECK_LABELS: Record<string, string> = {
  executor_evidence: '执行来源',
  query_succeeded: '查询执行',
  sql_read_only: '只读安全',
  execution_consistency: '结果一致性',
  non_empty: '非空结果',
  required_columns: '必需字段',
  non_null: '空值检查',
  unique_keys: '唯一性',
  numeric_ranges: '数值范围',
  critical_filters: '关键筛选条件',
  required_predicates: '查询条件',
  aggregation: '聚合口径',
  time_range: '时间范围',
  unit: '单位',
  aggregate_detail_reconciliation: '汇总与明细对账',
  result_contract_declared: '结果约束',
  evidence_exists: '查询证据'
}

const VALIDATION_SCOPE_LABELS: Record<string, string> = {
  execution_only: '基础执行检查',
  result_contract: '查询约束检查',
  saved_definition: '业务定义检查'
}

const TOOL_ARGUMENT_LABELS: Record<string, string> = {
  database_name: '数据源',
  table_name: '数据表',
  table: '数据表',
  path: '文件',
  file_path: '文件',
  url: '地址',
  sql: 'SQL'
}

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  grep_datasource: '检索数据源',
  grep_tables: '检索数据表',
  grep_columns: '检索字段',
  execute_readonly_sql: '查询数据库',
  align_metric: '对齐业务定义',
  execute_metric: '执行业务定义',
  align_value: '对齐实体值',
  semantic_scan_operator: '检索文档',
  semantic_filter_operator: '语义过滤',
  semantic_extract_operator: '语义抽取',
  semantic_join_operator: '语义关联',
  web_search_operator: '联网搜索',
  format_result: '生成结果展示',
  project_rules_get: '读取项目规则',
  project_rules_update: '更新项目规则'
}

function asRecord(value: unknown): JsonRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null
  } catch {
    return null
  }
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function compact(value: unknown, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function defaultValidationTitle(status: string) {
  if (status === 'passed') return '结果检查通过'
  if (status === 'inconclusive') return '结果检查需要补充'
  if (status === 'failed') return '结果检查未通过'
  return '结果检查'
}

export function queryValidationPresentation(value: unknown, suppliedTitle = ''): QueryValidationPresentation {
  const payload = asRecord(value) || {}
  const checks = Array.isArray(payload.checks)
    ? payload.checks.filter((check): check is JsonRecord => Boolean(check && typeof check === 'object'))
    : []
  const summary = asRecord(payload.summary) || {}
  const status = String(payload.status || '').toLowerCase()
  const failedChecks = checks.filter((check) => check.passed !== true)
  const errorCount = failedChecks.filter((check) => check.severity !== 'warning' && check.severity !== 'info').length
  const warningCount = failedChecks.length - errorCount
  const total = finiteNumber(summary.total, checks.length)
  const passed = finiteNumber(summary.passed, checks.filter((check) => check.passed === true).length)
  const failed = finiteNumber(summary.failed, errorCount)
  const inconclusive = finiteNumber(summary.inconclusive, warningCount)
  const tone: ProcessDetailTone = status === 'passed'
    ? 'ok'
    : status === 'failed'
      ? 'danger'
      : status === 'inconclusive'
        ? 'warn'
        : 'neutral'
  const summaryParts = total > 0 ? [`${passed}/${total} 项通过`] : []
  if (failed > 0) summaryParts.push(`${failed} 项未通过`)
  if (inconclusive > 0) summaryParts.push(`${inconclusive} 项待确认`)
  if (!summaryParts.length) {
    summaryParts.push(status === 'passed' ? '检查通过' : status === 'failed' ? '检查未通过' : '等待检查结果')
  }
  const issueLabels = failedChecks.map((check) => (
    VALIDATION_CHECK_LABELS[String(check.name || '')] || compact(check.name, 28) || '未命名检查'
  ))
  const visibleIssues = issueLabels.slice(0, 3)
  const remainingIssueCount = issueLabels.length - visibleIssues.length
  const issueSummary = visibleIssues.length
    ? `${status === 'inconclusive' ? '待确认' : '未通过'}：${visibleIssues.join('、')}${remainingIssueCount > 0 ? `等 ${issueLabels.length} 项` : ''}`
    : ''

  return {
    title: suppliedTitle.trim() || defaultValidationTitle(status),
    tone,
    scopeLabel: VALIDATION_SCOPE_LABELS[String(payload.scope || '')] || '结果检查',
    summary: summaryParts.join(' · '),
    issueSummary,
    rawJson: JSON.stringify(payload, null, 2)
  }
}

function splitToolContent(content: string) {
  const objectStart = content.search(/[\[{]/)
  if (objectStart < 0) return { label: content.trim(), rawArguments: '' }
  return {
    label: content.slice(0, objectStart).trim(),
    rawArguments: content.slice(objectStart).trim()
  }
}

function toolArgumentSummary(rawArguments: string) {
  const payload = asRecord(rawArguments)
  if (!payload) return ''
  const primary = ['question', 'query', 'prompt', 'description']
    .map((key) => compact(payload[key], 96))
    .find(Boolean)
  const details = Object.entries(TOOL_ARGUMENT_LABELS)
    .flatMap(([key, label]) => {
      const value = compact(payload[key], key === 'sql' ? 84 : 44)
      return value ? [`${label}：${value}`] : []
    })
    .slice(0, primary ? 1 : 2)
  return [primary, ...details].filter(Boolean).join(' · ')
}

export function toolCallPresentation(content: unknown, toolName = '', dshView?: unknown): ToolCallPresentation {
  const text = String(content || '').trim()
  const { label, rawArguments } = splitToolContent(text)
  const parsedArguments = asRecord(rawArguments)
  // Label priority: the DSH presenter's title (authoritative, tool-supplied)
  // → the legacy tool-name table → the content text → the raw tool name.
  // This stops the renderer from guessing the card title from the tool name
  // alone when the tool supplied a view.
  const viewTitle = typeof (dshView as any)?.view?.title === 'string'
    ? (dshView as any).view.title
    : undefined
  return {
    label: viewTitle || TOOL_DISPLAY_LABELS[toolName] || label || toolName || '工具',
    summary: toolArgumentSummary(rawArguments),
    rawArguments: parsedArguments ? JSON.stringify(parsedArguments, null, 2) : rawArguments
  }
}
