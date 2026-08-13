import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconDatabase,
  IconFile,
  IconLoader2,
  IconRefresh,
  IconShieldCheck
} from '@tabler/icons-react'
import {
  getAgentEvidenceBundle,
  rerunAgentEvidenceBundle,
  type AgentEvidenceBundle,
  type AgentEvidenceBundleRef,
  type AgentEvidenceRerunResult
} from '@/api/agent'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import { revealInFinder } from './folders'
import { evidenceRerunCopy, evidenceStatusCopy } from './evidenceCardModel'
import styles from './evidenceCard.module.scss'

const CHECK_NAMES: Record<string, string> = {
  executor_evidence: '执行来源',
  query_succeeded: '查询状态',
  sql_read_only: 'SQL 只读',
  execution_consistency: '结果一致',
  non_empty: '结果非空',
  required_columns: '字段完整',
  non_null: '空值检查',
  unique_keys: '重复检查',
  numeric_ranges: '数值范围',
  critical_filters: '关键条件',
  time_range: '时间范围',
  unit: '单位口径',
  aggregate_detail_reconciliation: '汇总对账'
}

function sourceName(evidence: NonNullable<AgentEvidenceBundle['evidence']>[number]) {
  const source = evidence.source || {}
  return String(
    source.datasource_name || source.name || source.database_name || source.database || source.connection_id || '项目数据源'
  )
}

function sourceMeta(evidence: NonNullable<AgentEvidenceBundle['evidence']>[number]) {
  const source = evidence.source || {}
  const tables = Array.isArray(evidence.schema?.referenced_tables)
    ? evidence.schema.referenced_tables.map((table: any) => [table.schema_name, table.table_name].filter(Boolean).join('.')).filter(Boolean)
    : []
  return [source.db_type, tables.join('、')].filter(Boolean).join(' · ')
}

function uniqueEvidence(bundle: AgentEvidenceBundle | null) {
  const seen = new Set<string>()
  return (bundle?.evidence || []).filter((item) => {
    const id = String(item.evidence_id || item.statement?.text || '')
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export default function EvidenceCard({
  evidenceRef,
  expanded = false,
  onExpandedChange
}: {
  evidenceRef: AgentEvidenceBundleRef
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [bundle, setBundle] = useState<AgentEvidenceBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [rerunning, setRerunning] = useState(false)
  const [rerunError, setRerunError] = useState('')
  const [rerunResult, setRerunResult] = useState<AgentEvidenceRerunResult | null>(null)
  const status = evidenceStatusCopy(bundle?.status || evidenceRef.status)
  const evidence = useMemo(() => uniqueEvidence(bundle), [bundle])
  const validations = bundle?.validations || []
  const failedChecks = validations.flatMap((validation) =>
    (validation.checks || []).filter((check) => !check.passed && check.severity !== 'info')
  )
  const passedChecks = validations.flatMap((validation) =>
    (validation.checks || []).filter((check) => check.passed)
  )
  const rerunCopy = evidenceRerunCopy(rerunResult?.comparison)

  const load = useCallback(async () => {
    if (bundle || loading || !evidenceRef.id) return
    setLoading(true)
    setError('')
    try {
      const response: any = await getAgentEvidenceBundle(evidenceRef.id)
      setBundle(response?.data || null)
    } catch (err: any) {
      setError(err?.message || '依据加载失败')
    } finally {
      setLoading(false)
    }
  }, [bundle, evidenceRef.id, loading])

  useEffect(() => {
    if (expanded) void load()
  }, [expanded, load])

  const toggle = () => {
    const next = !expanded
    onExpandedChange?.(next)
    if (next) void load()
  }

  const openReview = (view: 'runs' | 'trace') => {
    eventBus.emit(EVENT_TYPES.OPEN_AGENT_REVIEW, { view, runId: bundle?.run_id || null })
  }

  const rerun = async () => {
    if (rerunning || !evidenceRef.id) return
    setRerunning(true)
    setRerunError('')
    try {
      const response: any = await rerunAgentEvidenceBundle(evidenceRef.id)
      setRerunResult(response?.data || null)
    } catch (err: any) {
      setRerunError(err?.message || '复跑失败')
    } finally {
      setRerunning(false)
    }
  }

  return (
    <section
      className={styles.card}
      data-evidence-card
      data-evidence-bundle-id={evidenceRef.id}
      data-evidence-status={bundle?.status || evidenceRef.status || ''}
      data-evidence-loading={loading ? 'true' : 'false'}
      data-evidence-error={error || undefined}
      data-evidence-rerunning={rerunning ? 'true' : 'false'}
      data-evidence-rerun-error={rerunError || undefined}
    >
      <button type="button" className={styles.head} aria-expanded={expanded} onClick={toggle} data-evidence-toggle>
        <IconChevronRight size={14} className={expanded ? styles.chevronOpen : styles.chevron} />
        <IconShieldCheck size={15} className={styles.shield} />
        <span className={styles.title}>查看依据</span>
        <span className={styles.summary}>{bundle ? `${evidence.length} 次查询 · ${passedChecks.length} 项检查` : '来源、计算和检查'}</span>
        <span className={styles.status} data-tone={status.tone}>{status.label}</span>
      </button>

      <div className={styles.reveal} data-expanded={expanded ? 'true' : 'false'} data-evidence-reveal>
        <div className={styles.revealInner}>
          <div className={styles.body} data-evidence-body>
            {loading && (
              <div className={styles.state}><IconLoader2 size={15} className={styles.spin} />正在读取同一份证据快照…</div>
            )}
            {error && (
              <div className={styles.error}>
                <IconAlertTriangle size={14} />
                <span>{error}</span>
                <button type="button" onClick={() => void load()}><IconRefresh size={13} />重试</button>
              </div>
            )}
            {bundle && (
              <>
                <div className={styles.section}>
                  <div className={styles.sectionLabel}><IconDatabase size={14} />数据来自哪里</div>
                  <div className={styles.sourceList}>
                    {evidence.map((item) => (
                      <div key={item.evidence_id || item.statement?.text} className={styles.sourceRow} data-evidence-source>
                        <strong>{sourceName(item)}</strong>
                        <span>{sourceMeta(item) || `${Number(item.result?.row_count || 0)} 行结果`}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionLabel}><IconCode size={14} />实际算了什么</div>
                  <div className={styles.sqlList}>
                    {evidence.map((item, index) => (
                      <details key={item.evidence_id || index} className={styles.sqlItem} data-evidence-sql>
                        <summary>
                          查询 {index + 1}
                          <span>{Number(item.result?.row_count || 0)} 行 · {Number(item.timing?.duration_ms || 0)} ms</span>
                        </summary>
                        <pre>{item.statement?.text || '未记录 SQL'}</pre>
                        {Boolean(item.statement?.parameters?.length) && (
                          <code>参数：{JSON.stringify(item.statement?.parameters)}</code>
                        )}
                      </details>
                    ))}
                  </div>
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionLabel}>
                    {failedChecks.length ? <IconAlertTriangle size={14} /> : <IconCheck size={14} />}
                    检查了什么
                  </div>
                  {validations.length ? (
                    <div className={styles.checks}>
                      {passedChecks.slice(0, 8).map((check, index) => (
                        <span key={`${check.name}-${index}`} data-state="passed" data-evidence-check={check.name}>
                          <IconCheck size={11} />{CHECK_NAMES[String(check.name || '')] || check.name}
                        </span>
                      ))}
                      {failedChecks.map((check, index) => (
                        <span key={`${check.name}-failed-${index}`} data-state="failed" data-evidence-check={check.name}>
                          <IconAlertTriangle size={11} />{CHECK_NAMES[String(check.name || '')] || check.name}
                        </span>
                      ))}
                    </div>
                  ) : <p className={styles.muted}>本轮有执行依据，但没有单独的结果校验。</p>}
                </div>

                {bundle.uncertainty?.has_uncertainty && (
                  <div className={styles.uncertainty}>
                    <IconAlertTriangle size={14} />
                    <div>
                      <strong>存在待确认项</strong>
                      <span>{(bundle.uncertainty.items || []).map((item: any) => item.type).join('、') || '部分步骤未通过检查'}</span>
                    </div>
                  </div>
                )}

                {rerunError && (
                  <div className={styles.error} data-evidence-rerun-result="error">
                    <IconAlertTriangle size={14} /><span>{rerunError}</span>
                  </div>
                )}
                {rerunCopy && rerunResult && (
                  <div className={styles.rerunResult} data-tone={rerunCopy.tone} data-evidence-rerun-result={rerunCopy.tone}>
                    {rerunCopy.tone === 'ok' ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}
                    <div><strong>{rerunCopy.title}</strong><span>{rerunCopy.detail}</span></div>
                    <button
                      type="button"
                      onClick={() => eventBus.emit(EVENT_TYPES.OPEN_AGENT_REVIEW, { view: 'runs', runId: rerunResult.run_id })}
                      data-evidence-action="rerun-run"
                    >查看新运行</button>
                  </div>
                )}

                <div className={styles.actions}>
                  <button type="button" onClick={() => void rerun()} disabled={rerunning} data-evidence-action="rerun">
                    <IconRefresh size={14} className={rerunning ? styles.spin : undefined} />
                    {rerunning ? '正在复跑…' : '同一查询复跑'}
                  </button>
                  <button type="button" onClick={() => openReview('runs')} data-evidence-action="runs">
                    <IconActivityHeartbeat size={14} />运行详情
                  </button>
                  <button type="button" onClick={() => openReview('trace')} data-evidence-action="trace">
                    <IconActivityHeartbeat size={14} />Trace
                  </button>
                  {(bundle.artifacts || []).filter((artifact) => artifact.path).map((artifact) => (
                    <button key={artifact.id || artifact.path} type="button" onClick={() => artifact.path && void revealInFinder(artifact.path)}>
                      <IconFile size={14} />{String(artifact.path).split(/[\\/]/).filter(Boolean).pop() || '打开产物'}
                    </button>
                  ))}
                </div>
                <div className={styles.snapshot} title={bundle.snapshot_hash || ''}>
                  快照 {String(bundle.snapshot_hash || '').replace(/^sha256:/, '').slice(0, 12)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
