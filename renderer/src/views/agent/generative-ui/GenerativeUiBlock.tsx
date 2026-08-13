import { memo, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import AppSelect from '@/components/AppSelect'
import { buildChartOption } from '@/utils/chartRegistry'
import { renderSafeMarkdown } from '@/utils/markdownConfig'
import type { AgentBlock } from '../stream/types'
import { imageSrcFromPath } from '../stream/uiCapabilities'
import { useAgentTheme } from '../themeContext'
import { buildGenerativeUiButtonMessage, buildGenerativeUiFormMessage } from './action'
import { parseGenerativeUiBlock } from './schema'
import {
  GENERATIVE_UI_LIMITS,
  type GenerativeUiButtonNodeV1,
  type GenerativeUiChartNodeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiFormNodeV1,
  type GenerativeUiFormValue,
  type GenerativeUiFormValues,
  type GenerativeUiImageNodeV1,
  type GenerativeUiNodeV1,
  type GenerativeUiTableNodeV1
} from './types'
import styles from './GenerativeUi.module.scss'

export interface GenerativeUiBlockProps {
  block: AgentBlock
  canInteract: boolean
  onAction: (message: string) => Promise<void>
}

function chartThemeTokens(scheme: 'light' | 'dark') {
  const fallback = scheme === 'dark'
    ? { text: '#f4f3f8', muted: '#c1becb', border: 'rgba(255,255,255,.09)', surface: '#16141b' }
    : { text: '#20201d', muted: '#6e6a61', border: 'rgba(36,35,31,.08)', surface: '#fffefa' }
  if (typeof document === 'undefined') return fallback
  const root = document.querySelector('.dsh-root')
  if (!root) return fallback
  const computed = getComputedStyle(root)
  const read = (name: string, value: string) => computed.getPropertyValue(name).trim() || value
  return {
    text: read('--dsh-text', fallback.text),
    muted: read('--dsh-muted', fallback.muted),
    border: read('--dsh-border', fallback.border),
    surface: read('--dsh-surface-raw', fallback.surface)
  }
}

function themedAxis(axis: any, tokens: ReturnType<typeof chartThemeTokens>): any {
  if (!axis) return axis
  if (Array.isArray(axis)) return axis.map((item) => themedAxis(item, tokens))
  return {
    ...axis,
    nameTextStyle: { ...(axis.nameTextStyle || {}), color: tokens.muted },
    axisLabel: { ...(axis.axisLabel || {}), color: tokens.muted },
    axisLine: { ...(axis.axisLine || {}), lineStyle: { ...(axis.axisLine?.lineStyle || {}), color: tokens.border } },
    splitLine: { ...(axis.splitLine || {}), lineStyle: { ...(axis.splitLine?.lineStyle || {}), color: tokens.border } }
  }
}

function generativeChartOption(
  node: GenerativeUiChartNodeV1,
  scheme: 'light' | 'dark',
  description: string
) {
  const base: any = buildChartOption(node.chart_type, {
    data: node.data,
    x_axis_field: node.x_key,
    y_axis_fields: node.series.map((series) => series.key),
    title: node.title || ''
  }, node.id)
  if (!base) return null
  const tokens = chartThemeTokens(scheme)
  const labels = new Map(node.series.map((series) => [series.key, series.label]))
  const series = Array.isArray(base.series)
    ? base.series.map((item: any) => ({
        ...item,
        name: labels.get(String(item.name || '')) || item.name,
        label: { ...(item.label || {}), color: tokens.text },
        itemStyle: {
          ...(item.itemStyle || {}),
          ...(node.chart_type === 'pie' ? { borderColor: tokens.surface } : {})
        }
      }))
    : base.series
  return {
    ...base,
    aria: { enabled: true, label: { description } },
    textStyle: { ...(base.textStyle || {}), color: tokens.text },
    title: base.title ? { ...base.title, textStyle: { ...(base.title.textStyle || {}), color: tokens.text } } : undefined,
    legend: base.legend ? { ...base.legend, textStyle: { ...(base.legend.textStyle || {}), color: tokens.muted } } : undefined,
    tooltip: {
      ...(base.tooltip || {}),
      backgroundColor: tokens.surface,
      borderColor: tokens.border,
      textStyle: { ...(base.tooltip?.textStyle || {}), color: tokens.text }
    },
    xAxis: themedAxis(base.xAxis, tokens),
    yAxis: themedAxis(base.yAxis, tokens),
    series
  }
}

function Markdown({ content }: { content: string }) {
  const html = useMemo(() => renderSafeMarkdown(content), [content])
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />
}

function ImageNode({ node }: { node: GenerativeUiImageNodeV1 }) {
  const [failed, setFailed] = useState(false)
  const src = imageSrcFromPath(node.src)
  if (failed) {
    return (
      <figure className={styles.imageFallback} role="group" aria-label={node.alt}>
        <strong>图片无法加载</strong>
        <span>{node.alt}</span>
        {node.caption && <figcaption>{node.caption}</figcaption>}
      </figure>
    )
  }
  return (
    <figure className={styles.image}>
      <img
        src={src}
        alt={node.alt}
        referrerPolicy={/^https:\/\//i.test(src) ? 'no-referrer' : undefined}
        onError={() => setFailed(true)}
      />
      {node.caption && <figcaption>{node.caption}</figcaption>}
    </figure>
  )
}

function TableNode({ node }: { node: GenerativeUiTableNodeV1 }) {
  const [page, setPage] = useState(1)
  const pageSize = 20
  const totalPages = Math.max(1, Math.ceil(node.rows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const visibleRows = node.rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const caption = node.caption || '数据表格'
  return (
    <div className={styles.tableBlock}>
      {node.caption && <div className={styles.dataTitle}>{node.caption}</div>}
      <div className={styles.tableRegion} role="region" aria-label={caption} tabIndex={0}>
        <table>
          <caption className={styles.srOnly}>{caption}</caption>
          <thead>
            <tr>
              {node.columns.map((column) => (
                <th key={column.key} scope="col" data-align={column.align || 'left'}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={`${currentPage}:${rowIndex}`}>
                {node.columns.map((column) => (
                  <td key={column.key} data-align={column.align || 'left'}>{String(row[column.key] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className={styles.pager} aria-label={`${caption}分页`}>
          <button type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <span aria-live="polite">{currentPage} / {totalPages}</span>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
        </div>
      )}
    </div>
  )
}

function ChartNode({
  node,
  summary
}: {
  node: GenerativeUiChartNodeV1
  summary: string
}) {
  const { scheme } = useAgentTheme()
  const description = `${node.title || '数据图表'}。${summary}`
  const option = useMemo(
    () => generativeChartOption(node, scheme, description),
    [description, node, scheme]
  )
  if (!option) {
    return <div className={styles.localError} role="alert"><strong>图表无法显示</strong><span>图表数据不完整。</span></div>
  }
  return (
    <figure className={styles.chart}>
      {node.title && <figcaption>{node.title}</figcaption>}
      <div className={styles.chartCanvas} role="img" aria-label={description}>
        <ReactECharts
          option={option}
          notMerge
          lazyUpdate
          style={{ width: '100%', height: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>
      <details className={styles.chartData}>
        <summary>查看图表数据</summary>
        <div className={styles.tableRegion} role="region" aria-label={`${node.title || '图表'}数据`} tabIndex={0}>
          <table>
            <thead><tr><th scope="col">{node.x_key}</th>{node.series.map((series) => <th key={series.key} scope="col">{series.label}</th>)}</tr></thead>
            <tbody>{node.data.map((row, index) => (
              <tr key={index}><td>{String(row[node.x_key] ?? '')}</td>{node.series.map((series) => <td key={series.key}>{String(row[series.key] ?? '')}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

function ActionButton({
  document,
  node,
  canInteract,
  onAction
}: {
  document: GenerativeUiDocumentV1
  node: GenerativeUiButtonNodeV1
  canInteract: boolean
  onAction: (message: string) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const activate = async () => {
    if (!canInteract || submitting) return
    const result = buildGenerativeUiButtonMessage(document, node)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onAction(result.message)
    } catch (actionError: any) {
      setError(actionError?.message || '消息发送失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className={styles.actionRow}>
      <button
        type="button"
        className={styles.actionButton}
        data-variant={node.variant || 'secondary'}
        disabled={!canInteract || submitting}
        title={!canInteract ? '等待当前任务完成后再操作' : undefined}
        onClick={() => void activate()}
      >
        {submitting ? '正在发送…' : node.label}
      </button>
      {error && <span className={styles.actionError} role="alert">{error}</span>}
    </div>
  )
}

function initialFormValues(form: GenerativeUiFormNodeV1): GenerativeUiFormValues {
  return Object.fromEntries(form.children.map((field) => [
    field.name,
    field.type === 'checkbox' ? Boolean(field.default_checked) : field.default_value || ''
  ]))
}

function FormNode({
  document,
  node,
  canInteract,
  onAction
}: {
  document: GenerativeUiDocumentV1
  node: GenerativeUiFormNodeV1
  canInteract: boolean
  onAction: (message: string) => Promise<void>
}) {
  const [values, setValues] = useState<GenerativeUiFormValues>(() => initialFormValues(node))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const controlsRef = useRef<Record<string, HTMLElement | null>>({})
  const formId = `generative-ui-${document.surface_id}-${document.revision}-${node.id}`
  const updateValue = (name: string, value: GenerativeUiFormValue) => {
    setValues((current) => ({ ...current, [name]: value }))
    setFieldErrors((current) => {
      if (!current[name]) return current
      const next = { ...current }
      delete next[name]
      return next
    })
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canInteract || submitting) return
    const result = buildGenerativeUiFormMessage(document, node, values)
    if (!result.ok) {
      setFieldErrors(result.fieldErrors)
      setActionError(result.error)
      const firstInvalid = node.children.find((field) => result.fieldErrors[field.name])
      if (firstInvalid) controlsRef.current[firstInvalid.name]?.focus()
      return
    }
    setSubmitting(true)
    setActionError('')
    setFieldErrors({})
    try {
      await onAction(result.message)
    } catch (error: any) {
      setActionError(error?.message || '消息发送失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <p className={styles.formNotice}>提交后将作为普通对话消息发送</p>
      <div className={styles.formFields}>
        {node.children.map((field) => {
          const controlId = `${formId}-${field.id}`
          const errorId = `${controlId}-error`
          if (field.type === 'checkbox') {
            return (
              <div className={styles.checkboxField} key={field.id}>
                <input
                  ref={(element) => { controlsRef.current[field.name] = element }}
                  id={controlId}
                  type="checkbox"
                  checked={values[field.name] === true}
                  disabled={!canInteract || submitting}
                  aria-invalid={Boolean(fieldErrors[field.name])}
                  aria-describedby={fieldErrors[field.name] ? errorId : undefined}
                  onChange={(event) => updateValue(field.name, event.currentTarget.checked)}
                />
                <label htmlFor={controlId}>{field.label}</label>
                {fieldErrors[field.name] && <span id={errorId} className={styles.fieldError}>{fieldErrors[field.name]}</span>}
              </div>
            )
          }
          return (
            <div className={styles.field} key={field.id}>
              <label htmlFor={controlId}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>
              {field.type === 'select' ? (
                <div
                  ref={(element) => {
                    controlsRef.current[field.name] = element?.querySelector('input') || element
                  }}
                >
                  <AppSelect<string>
                    id={controlId}
                    value={String(values[field.name] || '')}
                    options={[{ value: '', label: '未选择' }, ...field.options]}
                    placeholder="请选择"
                    required={field.required}
                    disabled={!canInteract || submitting}
                    aria-invalid={Boolean(fieldErrors[field.name])}
                    aria-describedby={fieldErrors[field.name] ? errorId : undefined}
                    onChange={(value) => updateValue(field.name, value)}
                  />
                </div>
              ) : (
                <input
                  ref={(element) => { controlsRef.current[field.name] = element }}
                  id={controlId}
                  type="text"
                  value={String(values[field.name] || '')}
                  placeholder={field.placeholder}
                  required={field.required}
                  maxLength={GENERATIVE_UI_LIMITS.input}
                  disabled={!canInteract || submitting}
                  aria-invalid={Boolean(fieldErrors[field.name])}
                  aria-describedby={fieldErrors[field.name] ? errorId : undefined}
                  onChange={(event) => updateValue(field.name, event.currentTarget.value)}
                />
              )}
              {fieldErrors[field.name] && <span id={errorId} className={styles.fieldError}>{fieldErrors[field.name]}</span>}
            </div>
          )
        })}
      </div>
      <div className={styles.formActions}>
        <button type="submit" disabled={!canInteract || submitting} title={!canInteract ? '等待当前任务完成后再提交' : undefined}>
          {submitting ? '正在发送…' : node.submit_label}
        </button>
        {actionError && <span className={styles.actionError} role="alert">{actionError}</span>}
      </div>
    </form>
  )
}

function RenderNode({
  document,
  node,
  canInteract,
  onAction
}: {
  document: GenerativeUiDocumentV1
  node: GenerativeUiNodeV1
  canInteract: boolean
  onAction: (message: string) => Promise<void>
}) {
  const children = (items: GenerativeUiNodeV1[]) => items.map((child) => (
    <RenderNode key={child.id} document={document} node={child} canInteract={canInteract} onAction={onAction} />
  ))
  switch (node.type) {
    case 'stack':
      return <div className={styles.stack} data-gap={node.gap || 'md'} data-align={node.align || 'stretch'}>{children(node.children)}</div>
    case 'grid':
      return <div className={styles.grid} data-gap={node.gap || 'md'} data-columns={node.columns || 1}>{children(node.children)}</div>
    case 'section': {
      const titleId = `generative-ui-${document.surface_id}-${document.revision}-${node.id}-title`
      return <section className={styles.section} aria-labelledby={titleId}><div className={styles.sectionHeading}><h3 id={titleId}>{node.title}</h3>{node.description && <p>{node.description}</p>}</div>{children(node.children)}</section>
    }
    case 'text':
      return <p className={styles.text} data-tone={node.tone || 'default'} data-size={node.size || 'md'} data-weight={node.weight || 'regular'}>{node.text}</p>
    case 'markdown':
      return <Markdown content={node.content} />
    case 'metric':
      return <div className={styles.metric} data-tone={node.tone || 'default'}><span>{node.label}</span><strong>{node.value}</strong>{node.delta && <small>{node.trend === 'up' ? '↑ ' : node.trend === 'down' ? '↓ ' : node.trend === 'flat' ? '→ ' : ''}{node.delta}</small>}</div>
    case 'alert':
      return <div className={styles.alert} data-tone={node.tone} role={node.tone === 'danger' ? 'alert' : 'status'}>{node.title && <strong>{node.title}</strong>}<span>{node.message}</span></div>
    case 'state':
      return <div className={styles.state} data-state={node.state} role={node.state === 'error' ? 'alert' : 'status'} aria-live={node.state === 'loading' ? 'polite' : undefined}><strong>{node.title}</strong>{node.message && <span>{node.message}</span>}</div>
    case 'divider':
      return <hr className={styles.divider} />
    case 'table':
      return <TableNode node={node} />
    case 'chart':
      return <ChartNode node={node} summary={document.summary} />
    case 'image':
      return <ImageNode node={node} />
    case 'button':
      return <ActionButton document={document} node={node} canInteract={canInteract} onAction={onAction} />
    case 'form':
      return <FormNode document={document} node={node} canInteract={canInteract} onAction={onAction} />
    case 'text_input':
    case 'select':
    case 'checkbox':
      return <div className={styles.localError} role="alert">表单字段不能脱离 Form 使用。</div>
    default: {
      const exhaustive: never = node
      return <div className={styles.localError} role="alert">未知组件：{String((exhaustive as any)?.type || '')}</div>
    }
  }
}

export const GenerativeUiBlock = memo(function GenerativeUiBlock({ block, canInteract, onAction }: GenerativeUiBlockProps) {
  const parsed = useMemo(() => parseGenerativeUiBlock(block), [block])
  if (!parsed.ok) {
    const unsupported = parsed.error.code === 'GENERATIVE_UI_UNSUPPORTED_VERSION'
    return (
      <section className={styles.fallback} data-generative-ui-error={parsed.error.code} role="alert">
        <span className={styles.hostLabel}>Agent 生成界面</span>
        <strong>{unsupported ? '当前版本不支持此界面版本' : '这个界面暂时无法显示'}</strong>
        {parsed.summary && <p>{parsed.summary}</p>}
        <small>{parsed.error.path}：{parsed.error.message}</small>
      </section>
    )
  }
  const document = parsed.document
  const titleId = `generative-ui-${document.surface_id}-${document.revision}-title`
  const summaryId = `${titleId}-summary`
  return (
    <section
      className={styles.surface}
      data-generative-ui-surface={document.surface_id}
      data-generative-ui-revision={document.revision}
      aria-labelledby={document.title ? titleId : undefined}
      aria-label={document.title ? undefined : 'Agent 生成界面'}
      aria-describedby={summaryId}
    >
      <header className={styles.surfaceHeader}>
        <span className={styles.hostLabel}>Agent 生成界面</span>
        {document.title && <h2 id={titleId}>{document.title}</h2>}
      </header>
      <p id={summaryId} className={styles.srOnly}>{document.summary}</p>
      <RenderNode document={document} node={document.root} canInteract={canInteract} onAction={onAction} />
    </section>
  )
}, (previous, next) => (
  previous.block === next.block
  && previous.canInteract === next.canInteract
  && previous.onAction === next.onAction
))
