export const GENERATIVE_UI_SCHEMA_VERSION = 1 as const

export const GENERATIVE_UI_LIMITS = {
  documentBytes: 128 * 1024,
  nodes: 128,
  depth: 8,
  children: 32,
  string: 4_000,
  markdown: 20_000,
  visibleStrings: 40_000,
  tables: 4,
  tableColumns: 24,
  tableRows: 200,
  charts: 4,
  chartRows: 200,
  chartSeries: 8,
  forms: 4,
  formFields: 24,
  selectOptions: 50,
  input: 2_000,
  actionMessage: 40_000
} as const

export type GenerativeUiGap = 'xs' | 'sm' | 'md' | 'lg'
export type GenerativeUiTone = 'default' | 'muted' | 'success' | 'warning' | 'danger'
export type GenerativeUiCell = string | number | boolean | null
export type GenerativeUiChartCell = string | number | null

export interface GenerativeUiNodeBase {
  id: string
  type: GenerativeUiNodeType
}

export interface GenerativeUiStackNodeV1 extends GenerativeUiNodeBase {
  type: 'stack'
  gap?: GenerativeUiGap
  align?: 'stretch' | 'start' | 'center' | 'end'
  children: GenerativeUiNodeV1[]
}

export interface GenerativeUiGridNodeV1 extends GenerativeUiNodeBase {
  type: 'grid'
  columns?: 1 | 2 | 3 | 4
  gap?: GenerativeUiGap
  children: GenerativeUiNodeV1[]
}

export interface GenerativeUiSectionNodeV1 extends GenerativeUiNodeBase {
  type: 'section'
  title: string
  description?: string
  children: GenerativeUiNodeV1[]
}

export interface GenerativeUiTextNodeV1 extends GenerativeUiNodeBase {
  type: 'text'
  text: string
  tone?: GenerativeUiTone
  size?: 'sm' | 'md' | 'lg'
  weight?: 'regular' | 'medium' | 'semibold'
}

export interface GenerativeUiMarkdownNodeV1 extends GenerativeUiNodeBase {
  type: 'markdown'
  content: string
}

export interface GenerativeUiMetricNodeV1 extends GenerativeUiNodeBase {
  type: 'metric'
  label: string
  value: string | number
  delta?: string
  trend?: 'up' | 'down' | 'flat'
  tone?: Exclude<GenerativeUiTone, 'muted'>
}

export interface GenerativeUiAlertNodeV1 extends GenerativeUiNodeBase {
  type: 'alert'
  tone: 'info' | 'success' | 'warning' | 'danger'
  title?: string
  message: string
}

export interface GenerativeUiStateNodeV1 extends GenerativeUiNodeBase {
  type: 'state'
  state: 'loading' | 'empty' | 'error'
  title: string
  message?: string
}

export interface GenerativeUiDividerNodeV1 extends GenerativeUiNodeBase {
  type: 'divider'
}

export interface GenerativeUiTableColumnV1 {
  key: string
  label: string
  align?: 'left' | 'center' | 'right'
}

export interface GenerativeUiTableNodeV1 extends GenerativeUiNodeBase {
  type: 'table'
  caption?: string
  columns: GenerativeUiTableColumnV1[]
  rows: Array<Record<string, GenerativeUiCell>>
}

export interface GenerativeUiChartSeriesV1 {
  key: string
  label: string
}

export interface GenerativeUiChartNodeV1 extends GenerativeUiNodeBase {
  type: 'chart'
  chart_type: 'bar' | 'horizontal_bar' | 'line' | 'area' | 'pie' | 'scatter'
  title?: string
  data: Array<Record<string, GenerativeUiChartCell>>
  x_key: string
  series: GenerativeUiChartSeriesV1[]
}

export interface GenerativeUiImageNodeV1 extends GenerativeUiNodeBase {
  type: 'image'
  src: string
  alt: string
  caption?: string
}

export interface GenerativeUiButtonNodeV1 extends GenerativeUiNodeBase {
  type: 'button'
  action_id: string
  label: string
  variant?: 'primary' | 'secondary' | 'quiet'
}

export interface GenerativeUiTextInputNodeV1 extends GenerativeUiNodeBase {
  type: 'text_input'
  name: string
  label: string
  placeholder?: string
  required?: boolean
  default_value?: string
}

export interface GenerativeUiSelectOptionV1 {
  label: string
  value: string
}

export interface GenerativeUiSelectNodeV1 extends GenerativeUiNodeBase {
  type: 'select'
  name: string
  label: string
  required?: boolean
  default_value?: string
  options: GenerativeUiSelectOptionV1[]
}

export interface GenerativeUiCheckboxNodeV1 extends GenerativeUiNodeBase {
  type: 'checkbox'
  name: string
  label: string
  default_checked?: boolean
}

export type GenerativeUiFormFieldNodeV1 =
  | GenerativeUiTextInputNodeV1
  | GenerativeUiSelectNodeV1
  | GenerativeUiCheckboxNodeV1

export interface GenerativeUiFormNodeV1 extends GenerativeUiNodeBase {
  type: 'form'
  action_id: string
  submit_label: string
  children: GenerativeUiFormFieldNodeV1[]
}

export type GenerativeUiNodeV1 =
  | GenerativeUiStackNodeV1
  | GenerativeUiGridNodeV1
  | GenerativeUiSectionNodeV1
  | GenerativeUiTextNodeV1
  | GenerativeUiMarkdownNodeV1
  | GenerativeUiMetricNodeV1
  | GenerativeUiAlertNodeV1
  | GenerativeUiStateNodeV1
  | GenerativeUiDividerNodeV1
  | GenerativeUiTableNodeV1
  | GenerativeUiChartNodeV1
  | GenerativeUiImageNodeV1
  | GenerativeUiButtonNodeV1
  | GenerativeUiFormNodeV1
  | GenerativeUiFormFieldNodeV1

export type GenerativeUiNodeType = GenerativeUiNodeV1['type']

export interface GenerativeUiDocumentV1 {
  schema_version: typeof GENERATIVE_UI_SCHEMA_VERSION
  surface_id: string
  revision: number
  title?: string
  summary: string
  root: GenerativeUiNodeV1
}

export interface GenerativeUiValidationError {
  code:
    | 'GENERATIVE_UI_INVALID_JSON'
    | 'GENERATIVE_UI_SCHEMA_INVALID'
    | 'GENERATIVE_UI_UNSUPPORTED_VERSION'
    | 'GENERATIVE_UI_RESOURCE_LIMIT'
  path: string
  message: string
}

export type GenerativeUiParseResult =
  | { ok: true; document: GenerativeUiDocumentV1 }
  | { ok: false; error: GenerativeUiValidationError; summary: string }

export type GenerativeUiFormValue = string | boolean
export type GenerativeUiFormValues = Record<string, GenerativeUiFormValue>
