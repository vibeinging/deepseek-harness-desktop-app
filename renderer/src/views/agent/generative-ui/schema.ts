import type { AgentBlock } from '../stream/types'
import {
  GENERATIVE_UI_LIMITS,
  GENERATIVE_UI_SCHEMA_VERSION,
  type GenerativeUiAlertNodeV1,
  type GenerativeUiButtonNodeV1,
  type GenerativeUiChartNodeV1,
  type GenerativeUiCheckboxNodeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiFormFieldNodeV1,
  type GenerativeUiFormNodeV1,
  type GenerativeUiGridNodeV1,
  type GenerativeUiImageNodeV1,
  type GenerativeUiMarkdownNodeV1,
  type GenerativeUiMetricNodeV1,
  type GenerativeUiNodeV1,
  type GenerativeUiParseResult,
  type GenerativeUiSectionNodeV1,
  type GenerativeUiSelectNodeV1,
  type GenerativeUiStackNodeV1,
  type GenerativeUiStateNodeV1,
  type GenerativeUiTableNodeV1,
  type GenerativeUiTextInputNodeV1,
  type GenerativeUiTextNodeV1,
  type GenerativeUiValidationError
} from './types'

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

class GenerativeUiValidationIssue extends Error {
  readonly value: GenerativeUiValidationError

  constructor(value: GenerativeUiValidationError) {
    super(value.message)
    this.value = value
  }
}

interface ValidationState {
  ids: Set<string>
  nodeCount: number
  visibleStringLength: number
  tables: number
  charts: number
  forms: number
}

type NodeContext = 'content' | 'form'

function issue(
  code: GenerativeUiValidationError['code'],
  path: string,
  message: string
): never {
  throw new GenerativeUiValidationIssue({ code, path, message })
}

function addVisibleLength(state: ValidationState, length: number, path: string) {
  state.visibleStringLength += length
  if (state.visibleStringLength > GENERATIVE_UI_LIMITS.visibleStrings) {
    issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `可见文本总长不能超过 ${GENERATIVE_UI_LIMITS.visibleStrings}`)
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', path, '必须是对象')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowedKeys.has(key)) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.${key}`, `不支持字段 ${key}`)
    }
  }
}

function requiredString(
  value: unknown,
  path: string,
  state: ValidationState,
  options: { max?: number; trim?: boolean; visible?: boolean } = {}
) {
  if (typeof value !== 'string') issue('GENERATIVE_UI_SCHEMA_INVALID', path, '必须是字符串')
  const normalized = options.trim === false ? value : value.trim()
  const max = options.max ?? GENERATIVE_UI_LIMITS.string
  if (!normalized || normalized.length > max) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', path, `长度必须在 1 到 ${max} 之间`)
  }
  if (options.visible !== false) {
    addVisibleLength(state, normalized.length, path)
  }
  return normalized
}

function optionalString(
  value: unknown,
  path: string,
  state: ValidationState,
  options: { max?: number; trim?: boolean; visible?: boolean } = {}
) {
  if (value === undefined) return undefined
  return requiredString(value, path, state, options)
}

function identifier(value: unknown, path: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!SAFE_ID_RE.test(normalized) || FORBIDDEN_KEYS.has(normalized)) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', path, '必须是 1 到 64 字符的安全标识符')
  }
  return normalized
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', path, `必须是 ${allowed.join('、')} 之一`)
  }
  return value as T
}

function optionalOneOf<T extends string | number>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  return value === undefined ? undefined : oneOf(value, allowed, path)
}

function optionalBoolean(value: unknown, path: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') issue('GENERATIVE_UI_SCHEMA_INVALID', path, '必须是布尔值')
  return value
}

function nodeBase(raw: Record<string, unknown>, path: string, depth: number, state: ValidationState) {
  if (depth > GENERATIVE_UI_LIMITS.depth) {
    issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `组件树深度不能超过 ${GENERATIVE_UI_LIMITS.depth}`)
  }
  state.nodeCount += 1
  if (state.nodeCount > GENERATIVE_UI_LIMITS.nodes) {
    issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `节点数不能超过 ${GENERATIVE_UI_LIMITS.nodes}`)
  }
  const id = identifier(raw.id, `${path}.id`)
  if (state.ids.has(id)) issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.id`, `节点 id ${id} 重复`)
  state.ids.add(id)
  if (typeof raw.type !== 'string') issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.type`, '必须是字符串')
  return { id, type: raw.type }
}

function childArray(value: unknown, path: string) {
  if (!Array.isArray(value)) issue('GENERATIVE_UI_SCHEMA_INVALID', path, '必须是数组')
  if (value.length > GENERATIVE_UI_LIMITS.children) {
    issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `子节点数不能超过 ${GENERATIVE_UI_LIMITS.children}`)
  }
  return value
}

function safeImageSource(value: unknown, path: string, state: ValidationState) {
  const src = requiredString(value, path, state, { visible: false })
  const safeDataImage = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i.test(src)
  const safeLocal = /^dsh-file:\/\/local\/[a-zA-Z0-9_-]+$/i.test(src)
    || (src.startsWith('/') && !src.startsWith('//'))
    || /^[a-z]:[\\/]/i.test(src)
  let safeHttps = false
  if (/^https:\/\//i.test(src)) {
    try {
      const url = new URL(src)
      safeHttps = url.protocol === 'https:' && !url.username && !url.password
    } catch {
      safeHttps = false
    }
  }
  if (!safeDataImage && !safeLocal && !safeHttps) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', path, '图片地址不安全或不受宿主管理')
  }
  return src
}

function parseTable(raw: Record<string, unknown>, base: { id: string }, path: string, state: ValidationState): GenerativeUiTableNodeV1 {
  exactKeys(raw, ['id', 'type', 'caption', 'columns', 'rows'], path)
  state.tables += 1
  if (state.tables > GENERATIVE_UI_LIMITS.tables) {
    issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `表格数量不能超过 ${GENERATIVE_UI_LIMITS.tables}`)
  }
  if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > GENERATIVE_UI_LIMITS.tableColumns) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.columns`, `表格列数必须在 1 到 ${GENERATIVE_UI_LIMITS.tableColumns} 之间`)
  }
  const columnKeys = new Set<string>()
  const columns = raw.columns.map((value, index) => {
    const columnPath = `${path}.columns[${index}]`
    const column = record(value, columnPath)
    exactKeys(column, ['key', 'label', 'align'], columnPath)
    const key = identifier(column.key, `${columnPath}.key`)
    if (columnKeys.has(key)) issue('GENERATIVE_UI_SCHEMA_INVALID', `${columnPath}.key`, `列 key ${key} 重复`)
    columnKeys.add(key)
    return {
      key,
      label: requiredString(column.label, `${columnPath}.label`, state),
      align: optionalOneOf(column.align, ['left', 'center', 'right'] as const, `${columnPath}.align`)
    }
  })
  if (!Array.isArray(raw.rows) || raw.rows.length > GENERATIVE_UI_LIMITS.tableRows) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.rows`, `表格行数不能超过 ${GENERATIVE_UI_LIMITS.tableRows}`)
  }
  const rows = raw.rows.map((value, rowIndex) => {
    const rowPath = `${path}.rows[${rowIndex}]`
    const row = record(value, rowPath)
    const parsed: Record<string, string | number | boolean | null> = {}
    for (const [key, cell] of Object.entries(row)) {
      if (!columnKeys.has(key) || FORBIDDEN_KEYS.has(key)) {
        issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${key}`, `数据列 ${key} 未声明`)
      }
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) {
        issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${key}`, '单元格只支持字符串、数字、布尔值或 null')
      }
      if (typeof cell === 'number' && !Number.isFinite(cell)) {
        issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${key}`, '数字必须是有限值')
      }
      if (typeof cell === 'string') parsed[key] = requiredString(cell, `${rowPath}.${key}`, state, { trim: false })
      else {
        parsed[key] = cell as number | boolean | null
        addVisibleLength(state, String(cell ?? '').length, `${rowPath}.${key}`)
      }
    }
    return parsed
  })
  return {
    id: base.id,
    type: 'table',
    caption: optionalString(raw.caption, `${path}.caption`, state),
    columns,
    rows
  }
}

function parseChart(raw: Record<string, unknown>, base: { id: string }, path: string, state: ValidationState): GenerativeUiChartNodeV1 {
  exactKeys(raw, ['id', 'type', 'chart_type', 'title', 'data', 'x_key', 'series'], path)
  state.charts += 1
  if (state.charts > GENERATIVE_UI_LIMITS.charts) {
    issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `图表数量不能超过 ${GENERATIVE_UI_LIMITS.charts}`)
  }
  const xKey = identifier(raw.x_key, `${path}.x_key`)
  if (!Array.isArray(raw.series) || raw.series.length < 1 || raw.series.length > GENERATIVE_UI_LIMITS.chartSeries) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.series`, `图表系列数必须在 1 到 ${GENERATIVE_UI_LIMITS.chartSeries} 之间`)
  }
  const seriesKeys = new Set<string>()
  const series = raw.series.map((value, index) => {
    const seriesPath = `${path}.series[${index}]`
    const item = record(value, seriesPath)
    exactKeys(item, ['key', 'label'], seriesPath)
    const key = identifier(item.key, `${seriesPath}.key`)
    if (key === xKey || seriesKeys.has(key)) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${seriesPath}.key`, `图表系列 key ${key} 重复或与 x_key 相同`)
    }
    seriesKeys.add(key)
    return { key, label: requiredString(item.label, `${seriesPath}.label`, state) }
  })
  if (!Array.isArray(raw.data) || raw.data.length < 1 || raw.data.length > GENERATIVE_UI_LIMITS.chartRows) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.data`, `图表数据行数必须在 1 到 ${GENERATIVE_UI_LIMITS.chartRows} 之间`)
  }
  const declaredKeys = new Set([xKey, ...seriesKeys])
  const data = raw.data.map((value, rowIndex) => {
    const rowPath = `${path}.data[${rowIndex}]`
    const row = record(value, rowPath)
    const parsed: Record<string, string | number | null> = {}
    for (const key of Object.keys(row)) {
      if (!declaredKeys.has(key) || FORBIDDEN_KEYS.has(key)) {
        issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${key}`, `图表数据字段 ${key} 未声明`)
      }
    }
    const xValue = row[xKey]
    if (typeof xValue !== 'string' && typeof xValue !== 'number') {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${xKey}`, 'x_key 对应值必须是字符串或数字')
    }
    if (typeof xValue === 'number' && !Number.isFinite(xValue)) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${xKey}`, '数字必须是有限值')
    }
    parsed[xKey] = typeof xValue === 'string'
      ? requiredString(xValue, `${rowPath}.${xKey}`, state, { trim: false })
      : xValue
    if (typeof xValue === 'number') addVisibleLength(state, String(xValue).length, `${rowPath}.${xKey}`)
    for (const key of seriesKeys) {
      const cell = row[key]
      if (cell !== null && typeof cell !== 'number') {
        issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${key}`, '图表系列值必须是数字或 null')
      }
      if (typeof cell === 'number' && !Number.isFinite(cell)) {
        issue('GENERATIVE_UI_SCHEMA_INVALID', `${rowPath}.${key}`, '数字必须是有限值')
      }
      parsed[key] = cell as number | null
      addVisibleLength(state, String(cell ?? '').length, `${rowPath}.${key}`)
    }
    return parsed
  })
  return {
    id: base.id,
    type: 'chart',
    chart_type: oneOf(raw.chart_type, ['bar', 'horizontal_bar', 'line', 'area', 'pie', 'scatter'] as const, `${path}.chart_type`),
    title: optionalString(raw.title, `${path}.title`, state),
    data,
    x_key: xKey,
    series
  }
}

function parseFormField(
  raw: Record<string, unknown>,
  base: { id: string; type: string },
  path: string,
  state: ValidationState
): GenerativeUiFormFieldNodeV1 {
  if (base.type === 'text_input') {
    exactKeys(raw, ['id', 'type', 'name', 'label', 'placeholder', 'required', 'default_value'], path)
    return {
      id: base.id,
      type: 'text_input',
      name: identifier(raw.name, `${path}.name`),
      label: requiredString(raw.label, `${path}.label`, state),
      placeholder: optionalString(raw.placeholder, `${path}.placeholder`, state),
      required: optionalBoolean(raw.required, `${path}.required`),
      default_value: optionalString(raw.default_value, `${path}.default_value`, state, { max: GENERATIVE_UI_LIMITS.input, trim: false })
    } satisfies GenerativeUiTextInputNodeV1
  }
  if (base.type === 'select') {
    exactKeys(raw, ['id', 'type', 'name', 'label', 'required', 'default_value', 'options'], path)
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > GENERATIVE_UI_LIMITS.selectOptions) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.options`, `选项数必须在 1 到 ${GENERATIVE_UI_LIMITS.selectOptions} 之间`)
    }
    const values = new Set<string>()
    const options = raw.options.map((value, index) => {
      const optionPath = `${path}.options[${index}]`
      const option = record(value, optionPath)
      exactKeys(option, ['label', 'value'], optionPath)
      const optionValue = requiredString(option.value, `${optionPath}.value`, state, { visible: false })
      if (values.has(optionValue)) issue('GENERATIVE_UI_SCHEMA_INVALID', `${optionPath}.value`, `选项值 ${optionValue} 重复`)
      values.add(optionValue)
      return {
        label: requiredString(option.label, `${optionPath}.label`, state),
        value: optionValue
      }
    })
    const defaultValue = optionalString(raw.default_value, `${path}.default_value`, state, {
      max: GENERATIVE_UI_LIMITS.input,
      visible: false,
      trim: false
    })
    if (defaultValue !== undefined && !values.has(defaultValue)) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.default_value`, '默认值必须来自 options')
    }
    return {
      id: base.id,
      type: 'select',
      name: identifier(raw.name, `${path}.name`),
      label: requiredString(raw.label, `${path}.label`, state),
      required: optionalBoolean(raw.required, `${path}.required`),
      default_value: defaultValue,
      options
    } satisfies GenerativeUiSelectNodeV1
  }
  if (base.type === 'checkbox') {
    exactKeys(raw, ['id', 'type', 'name', 'label', 'default_checked'], path)
    return {
      id: base.id,
      type: 'checkbox',
      name: identifier(raw.name, `${path}.name`),
      label: requiredString(raw.label, `${path}.label`, state),
      default_checked: optionalBoolean(raw.default_checked, `${path}.default_checked`)
    } satisfies GenerativeUiCheckboxNodeV1
  }
  issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.type`, 'Form 只能包含 text_input、select 或 checkbox')
}

function parseNode(value: unknown, path: string, depth: number, state: ValidationState, context: NodeContext): GenerativeUiNodeV1 {
  const raw = record(value, path)
  const base = nodeBase(raw, path, depth, state)

  if (context === 'form') return parseFormField(raw, base, path, state)
  if (['text_input', 'select', 'checkbox'].includes(base.type)) {
    issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.type`, '表单字段只能出现在 Form 内')
  }

  if (base.type === 'stack') {
    exactKeys(raw, ['id', 'type', 'gap', 'align', 'children'], path)
    return {
      id: base.id,
      type: 'stack',
      gap: optionalOneOf(raw.gap, ['xs', 'sm', 'md', 'lg'] as const, `${path}.gap`),
      align: optionalOneOf(raw.align, ['stretch', 'start', 'center', 'end'] as const, `${path}.align`),
      children: childArray(raw.children, `${path}.children`).map((child, index) => (
        parseNode(child, `${path}.children[${index}]`, depth + 1, state, 'content')
      ))
    } satisfies GenerativeUiStackNodeV1
  }
  if (base.type === 'grid') {
    exactKeys(raw, ['id', 'type', 'columns', 'gap', 'children'], path)
    return {
      id: base.id,
      type: 'grid',
      columns: optionalOneOf(raw.columns, [1, 2, 3, 4] as const, `${path}.columns`),
      gap: optionalOneOf(raw.gap, ['xs', 'sm', 'md', 'lg'] as const, `${path}.gap`),
      children: childArray(raw.children, `${path}.children`).map((child, index) => (
        parseNode(child, `${path}.children[${index}]`, depth + 1, state, 'content')
      ))
    } satisfies GenerativeUiGridNodeV1
  }
  if (base.type === 'section') {
    exactKeys(raw, ['id', 'type', 'title', 'description', 'children'], path)
    return {
      id: base.id,
      type: 'section',
      title: requiredString(raw.title, `${path}.title`, state),
      description: optionalString(raw.description, `${path}.description`, state),
      children: childArray(raw.children, `${path}.children`).map((child, index) => (
        parseNode(child, `${path}.children[${index}]`, depth + 1, state, 'content')
      ))
    } satisfies GenerativeUiSectionNodeV1
  }
  if (base.type === 'text') {
    exactKeys(raw, ['id', 'type', 'text', 'tone', 'size', 'weight'], path)
    return {
      id: base.id,
      type: 'text',
      text: requiredString(raw.text, `${path}.text`, state, { trim: false }),
      tone: optionalOneOf(raw.tone, ['default', 'muted', 'success', 'warning', 'danger'] as const, `${path}.tone`),
      size: optionalOneOf(raw.size, ['sm', 'md', 'lg'] as const, `${path}.size`),
      weight: optionalOneOf(raw.weight, ['regular', 'medium', 'semibold'] as const, `${path}.weight`)
    } satisfies GenerativeUiTextNodeV1
  }
  if (base.type === 'markdown') {
    exactKeys(raw, ['id', 'type', 'content'], path)
    return {
      id: base.id,
      type: 'markdown',
      content: requiredString(raw.content, `${path}.content`, state, { max: GENERATIVE_UI_LIMITS.markdown, trim: false })
    } satisfies GenerativeUiMarkdownNodeV1
  }
  if (base.type === 'metric') {
    exactKeys(raw, ['id', 'type', 'label', 'value', 'delta', 'trend', 'tone'], path)
    if (typeof raw.value !== 'string' && typeof raw.value !== 'number') {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.value`, '指标值必须是字符串或数字')
    }
    if (typeof raw.value === 'number' && !Number.isFinite(raw.value)) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.value`, '数字必须是有限值')
    }
    const metricValue = typeof raw.value === 'string'
      ? requiredString(raw.value, `${path}.value`, state)
      : raw.value
    if (typeof metricValue === 'number') addVisibleLength(state, String(metricValue).length, `${path}.value`)
    return {
      id: base.id,
      type: 'metric',
      label: requiredString(raw.label, `${path}.label`, state),
      value: metricValue,
      delta: optionalString(raw.delta, `${path}.delta`, state),
      trend: optionalOneOf(raw.trend, ['up', 'down', 'flat'] as const, `${path}.trend`),
      tone: optionalOneOf(raw.tone, ['default', 'success', 'warning', 'danger'] as const, `${path}.tone`)
    } satisfies GenerativeUiMetricNodeV1
  }
  if (base.type === 'alert') {
    exactKeys(raw, ['id', 'type', 'tone', 'title', 'message'], path)
    return {
      id: base.id,
      type: 'alert',
      tone: oneOf(raw.tone, ['info', 'success', 'warning', 'danger'] as const, `${path}.tone`),
      title: optionalString(raw.title, `${path}.title`, state),
      message: requiredString(raw.message, `${path}.message`, state)
    } satisfies GenerativeUiAlertNodeV1
  }
  if (base.type === 'state') {
    exactKeys(raw, ['id', 'type', 'state', 'title', 'message'], path)
    return {
      id: base.id,
      type: 'state',
      state: oneOf(raw.state, ['loading', 'empty', 'error'] as const, `${path}.state`),
      title: requiredString(raw.title, `${path}.title`, state),
      message: optionalString(raw.message, `${path}.message`, state)
    } satisfies GenerativeUiStateNodeV1
  }
  if (base.type === 'divider') {
    exactKeys(raw, ['id', 'type'], path)
    return { id: base.id, type: 'divider' }
  }
  if (base.type === 'table') return parseTable(raw, base, path, state)
  if (base.type === 'chart') return parseChart(raw, base, path, state)
  if (base.type === 'image') {
    exactKeys(raw, ['id', 'type', 'src', 'alt', 'caption'], path)
    return {
      id: base.id,
      type: 'image',
      src: safeImageSource(raw.src, `${path}.src`, state),
      alt: requiredString(raw.alt, `${path}.alt`, state),
      caption: optionalString(raw.caption, `${path}.caption`, state)
    } satisfies GenerativeUiImageNodeV1
  }
  if (base.type === 'button') {
    exactKeys(raw, ['id', 'type', 'action_id', 'label', 'variant'], path)
    return {
      id: base.id,
      type: 'button',
      action_id: identifier(raw.action_id, `${path}.action_id`),
      label: requiredString(raw.label, `${path}.label`, state),
      variant: optionalOneOf(raw.variant, ['primary', 'secondary', 'quiet'] as const, `${path}.variant`)
    } satisfies GenerativeUiButtonNodeV1
  }
  if (base.type === 'form') {
    exactKeys(raw, ['id', 'type', 'action_id', 'submit_label', 'children'], path)
    state.forms += 1
    if (state.forms > GENERATIVE_UI_LIMITS.forms) {
      issue('GENERATIVE_UI_RESOURCE_LIMIT', path, `表单数量不能超过 ${GENERATIVE_UI_LIMITS.forms}`)
    }
    const children = childArray(raw.children, `${path}.children`)
    if (children.length < 1 || children.length > GENERATIVE_UI_LIMITS.formFields) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.children`, `表单字段数必须在 1 到 ${GENERATIVE_UI_LIMITS.formFields} 之间`)
    }
    const names = new Set<string>()
    const parsedChildren = children.map((child, index) => {
      const field = parseNode(child, `${path}.children[${index}]`, depth + 1, state, 'form') as GenerativeUiFormFieldNodeV1
      if (names.has(field.name)) issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.children[${index}].name`, `字段名 ${field.name} 重复`)
      names.add(field.name)
      return field
    })
    return {
      id: base.id,
      type: 'form',
      action_id: identifier(raw.action_id, `${path}.action_id`),
      submit_label: requiredString(raw.submit_label, `${path}.submit_label`, state),
      children: parsedChildren
    } satisfies GenerativeUiFormNodeV1
  }

  issue('GENERATIVE_UI_SCHEMA_INVALID', `${path}.type`, `未知组件类型 ${base.type}`)
}

function parseInput(input: unknown) {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input)
  } catch {
    issue('GENERATIVE_UI_INVALID_JSON', '$', '界面内容不是有效 JSON')
  }
}

export function generativeUiSummaryFromContent(input: unknown) {
  if (typeof input === 'string') {
    const plain = input.trim()
    if (plain && !/^[\[{]/.test(plain)) return plain.slice(0, 1_000)
  }
  try {
    const value = typeof input === 'string' ? JSON.parse(input) : input
    const summary = value && typeof value === 'object' && !Array.isArray(value)
      ? String((value as Record<string, unknown>).summary || '').trim()
      : ''
    return summary.slice(0, 1_000)
  } catch {
    return ''
  }
}

export function parseGenerativeUiDocument(input: unknown): GenerativeUiParseResult {
  const fallbackSummary = generativeUiSummaryFromContent(input)
  try {
    const value = parseInput(input)
    let json = ''
    try {
      json = JSON.stringify(value)
    } catch {
      issue('GENERATIVE_UI_INVALID_JSON', '$', '界面内容无法序列化')
    }
    if (new TextEncoder().encode(json).length > GENERATIVE_UI_LIMITS.documentBytes) {
      issue('GENERATIVE_UI_RESOURCE_LIMIT', '$', `界面 JSON 不能超过 ${GENERATIVE_UI_LIMITS.documentBytes} 字节`)
    }
    const raw = record(value, '$')
    exactKeys(raw, ['schema_version', 'surface_id', 'revision', 'title', 'summary', 'root'], '$')
    if (raw.schema_version !== GENERATIVE_UI_SCHEMA_VERSION) {
      issue('GENERATIVE_UI_UNSUPPORTED_VERSION', '$.schema_version', '当前版本不支持此界面版本')
    }
    const state: ValidationState = {
      ids: new Set(),
      nodeCount: 0,
      visibleStringLength: 0,
      tables: 0,
      charts: 0,
      forms: 0
    }
    const surfaceId = identifier(raw.surface_id, '$.surface_id')
    if (!Number.isInteger(raw.revision) || Number(raw.revision) < 1 || Number(raw.revision) > 1_000_000) {
      issue('GENERATIVE_UI_SCHEMA_INVALID', '$.revision', 'revision 必须是 1 到 1000000 的整数')
    }
    const document: GenerativeUiDocumentV1 = {
      schema_version: GENERATIVE_UI_SCHEMA_VERSION,
      surface_id: surfaceId,
      revision: Number(raw.revision),
      title: optionalString(raw.title, '$.title', state, { max: 120 }),
      summary: requiredString(raw.summary, '$.summary', state, { max: 1_000 }),
      root: parseNode(raw.root, '$.root', 1, state, 'content')
    }
    return { ok: true, document }
  } catch (error) {
    const value = error instanceof GenerativeUiValidationIssue
      ? error.value
      : {
          code: 'GENERATIVE_UI_SCHEMA_INVALID' as const,
          path: '$',
          message: '界面结构无效'
        }
    return { ok: false, error: value, summary: fallbackSummary }
  }
}

export function isGenerativeUiBlock(block: Pick<AgentBlock, 'type'>) {
  return block.type === 'generative_ui' || block.type === 'generativeUi'
}

export function generativeUiDocumentInputFromBlock(block: AgentBlock): unknown {
  const metadata = block.metadata && typeof block.metadata === 'object' ? block.metadata : {}
  const envelope = metadata.generative_ui && typeof metadata.generative_ui === 'object'
    ? metadata.generative_ui
    : {}
  if (envelope.document !== undefined) return envelope.document
  // Read-only compatibility for snapshots emitted before the metadata envelope
  // was fixed. New snapshots keep content as a plain-text summary.
  if (typeof block.content === 'string' && /^[\s]*[\[{]/.test(block.content)) return block.content
  return null
}

export function parseGenerativeUiBlock(block: AgentBlock): GenerativeUiParseResult {
  const input = generativeUiDocumentInputFromBlock(block)
  if (input !== null) return parseGenerativeUiDocument(input)
  return {
    ok: false,
    error: {
      code: 'GENERATIVE_UI_SCHEMA_INVALID',
      path: '$.metadata.generative_ui.document',
      message: '界面快照缺少完整 Document'
    },
    summary: generativeUiSummaryFromContent(block.content)
  }
}

export function generativeUiSummaryFromBlock(block: AgentBlock) {
  const parsed = parseGenerativeUiBlock(block)
  return parsed.ok ? parsed.document.summary : parsed.summary || generativeUiSummaryFromContent(block.content)
}

export function generativeUiBlockIdentity(block: AgentBlock) {
  if (!isGenerativeUiBlock(block)) return null
  const parsed = parseGenerativeUiBlock(block)
  if (!parsed.ok) return null
  return {
    surfaceId: parsed.document.surface_id,
    revision: parsed.document.revision
  }
}

/** Keep only the highest valid revision for each Surface while preserving all other block order. */
export function foldGenerativeUiBlocks(blocks: AgentBlock[]) {
  const removed = new Set<number>()
  const latest = new Map<string, { index: number; revision: number }>()
  blocks.forEach((block, index) => {
    const identity = generativeUiBlockIdentity(block)
    if (!identity) return
    const previous = latest.get(identity.surfaceId)
    if (!previous) {
      latest.set(identity.surfaceId, { index, revision: identity.revision })
      return
    }
    if (identity.revision > previous.revision) {
      removed.add(previous.index)
      latest.set(identity.surfaceId, { index, revision: identity.revision })
    } else {
      removed.add(index)
    }
  })
  return removed.size ? blocks.filter((_, index) => !removed.has(index)) : blocks
}
