import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Drawer,
  Progress,
  Select,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { IconChevronDown, IconInfoCircleFilled } from '@tabler/icons-react'
import {
  applyMetricViewRecommendationReq,
  getLatestMetricViewRecommendationReq,
  getMetricViewRecommendationTaskReq,
  runMetricViewRecommendationReq,
} from '@/api/business-semantic'
import styles from './MetricViewRecommendationDrawer.module.scss'

export interface MetricViewRecommendationDrawerProps {
  modelValue?: boolean
  projectId: string
  businessId: string
  dataSources?: any[]
  // Parent notifies Drawer: this candidate was just edited in Wizard and auto-saved as draft.
  // It has been persisted as draft, so Drawer should add it to appliedIds and show "saved as draft".
  externallyAppliedCandidateId?: string | null
  onUpdateModelValue?: (v: boolean) => void
  onEditCandidate?: (candidate: any) => void
  onApplied?: (results: any[]) => void
}

export interface MetricViewRecommendationDrawerRef {
  startAnalyze: () => void
  resetTask: () => void
}

const PHASE_PERCENT: Record<string, number> = {
  pending: 5,
  extracting: 30,
  clustering: 55,
  synthesizing: 80,
  completed: 100,
  failed: 100,
}

// Keep in sync with backend _IN_FLIGHT_STATUSES (recommendation_service.py)
const IN_FLIGHT_STATUSES = ['pending', 'extracting', 'clustering', 'synthesizing']

const MetricViewRecommendationDrawer = forwardRef<
  MetricViewRecommendationDrawerRef,
  MetricViewRecommendationDrawerProps
>(function MetricViewRecommendationDrawer(props, ref) {
  const {
    modelValue = false,
    projectId,
    businessId,
    dataSources = [],
    externallyAppliedCandidateId = null,
    onUpdateModelValue,
    onEditCandidate,
    onApplied,
  } = props

  const { i18n } = useTranslation()

  const t = useMemo(() => {
    const isZh = String(i18n.language || '').startsWith('zh')
    return isZh
      ? {
          drawerTitle: '从历史问题智能推荐业务视图',
          sourceLabel: '数据源(可选)',
          sourcePlaceholder: '不限',
          sourceHint: '限定本次分析使用的数据源；结果出来后切换可过滤展示',
          filteredOut: '已被过滤',
          timeRangeLabel: '时间窗',
          daysUnit: '天',
          maxQuestionsLabel: '最大问题数',
          startAnalyze: '开始分析',
          analyzing: '分析中...',
          loadLatest: '加载上次结果',
          phasePending: '排队中,准备开始分析',
          phaseExtracting: '正在读取当前项目的历史问题、指标和字段',
          phaseClustering: '正在整理相似问题',
          phaseSynthesizing: 'AI 正在判断值得复用的指标',
          phaseCompleted: '分析完成',
          phaseFailed: '分析失败',
          progressHint: '任务在后台执行，可以等待结果自动刷新',
          statsScanned: '扫描问题',
          statsClusters: '模型初选',
          statsCandidates: '候选数',
          statsLLMCalls: 'LLM 调用',
          statsElapsed: '耗时',
          statusFailed: '任务失败',
          confidenceLabel: '置信度',
          intentLabel: '能力维度',
          keyChallenges: '关键挑战',
          intentReasoning: '意图推理',
          sourceTagLabel: '数据源',
          unknownSource: '未知数据源',
          appliedTag: '已存为草稿',
          editCandidate: '编辑',
          validationErrorTitle: '需要在业务视图列表里继续完善',
          validationErrorHint:
            '该候选的部分字段(如维度的 field/列名)LLM 未能稳定输出。保存为草稿后,在业务视图列表中打开此条编辑、补全字段、再切换为启用。',
          validationErrorDetail: '查看原始错误',
          historicalLoaded: '当前展示的是 {time} 的历史推荐结果。点击"开始分析"将丢弃此结果重新跑一次。',
          noHistoricalResult: '该业务暂无历史推荐结果',
          supportingQuestions: '支撑问题',
          skippedTitle: '{n} 条候选未生成',
          skippedQuestions: '条问题',
          skippedExpand: '展开明细',
          skippedCollapse: '收起',
          reasoning: '推荐理由',
          applyButton: '批量保存为草稿',
          applyHint: '保存为草稿后,可在业务视图列表中继续编辑、完善后启用',
          emptyAfterRun: '当前历史问题集未能抽象出可推荐的视图',
          emptyNoQuestions: '尚未发现可用历史问题,先去问几个业务问题再试',
          selectedCount: '已勾选',
          applyOk: '已成功保存 {n} 个草稿,可在业务视图列表中继续完善',
          applyPartial: '部分候选保存失败,详见列表',
        }
      : {
          drawerTitle: 'Smart Metric View Recommendations from History',
          sourceLabel: 'Source (optional)',
          sourcePlaceholder: 'Any',
          sourceHint: 'Limits this analysis to one source; also filters the result list.',
          filteredOut: 'filtered',
          timeRangeLabel: 'Time window',
          daysUnit: 'days',
          maxQuestionsLabel: 'Max questions',
          startAnalyze: 'Analyze',
          analyzing: 'Analyzing...',
          loadLatest: 'Load latest',
          phasePending: 'Queued, waiting to start',
          phaseExtracting: 'Loading project history, metrics, and fields',
          phaseClustering: 'Organizing similar questions',
          phaseSynthesizing: 'AI is selecting reusable metrics',
          phaseCompleted: 'Analysis completed',
          phaseFailed: 'Analysis failed',
          progressHint: 'The task runs in the background and refreshes automatically.',
          statsScanned: 'Scanned',
          statsClusters: 'AI shortlist',
          statsCandidates: 'Candidates',
          statsLLMCalls: 'LLM calls',
          statsElapsed: 'Elapsed',
          statusFailed: 'Task failed',
          confidenceLabel: 'Confidence',
          intentLabel: 'Capabilities',
          keyChallenges: 'Key challenges',
          intentReasoning: 'Intent reasoning',
          sourceTagLabel: 'Source',
          unknownSource: 'Unknown source',
          appliedTag: 'Saved as draft',
          editCandidate: 'Edit',
          validationErrorTitle: 'Needs completion in the view list',
          validationErrorHint:
            'LLM did not stably emit some fields (e.g. dimension field/column). Save it as a draft, then open it in the metric view list to complete and activate.',
          validationErrorDetail: 'Show raw error',
          historicalLoaded: 'Showing historical result from {time}. Clicking "Analyze" will discard it and run again.',
          noHistoricalResult: 'No previous recommendation for this business',
          supportingQuestions: 'Supporting questions',
          skippedTitle: '{n} candidate(s) were not generated',
          skippedQuestions: 'questions',
          skippedExpand: 'Show details',
          skippedCollapse: 'Hide',
          reasoning: 'Reasoning',
          applyButton: 'Save selected as drafts',
          applyHint: 'Drafts are saved into the metric view list; you can complete and activate them there',
          emptyAfterRun: 'No abstractable view candidates from current history',
          emptyNoQuestions: 'No usable history questions yet',
          selectedCount: 'Selected',
          applyOk: 'Saved {n} draft(s); complete them in the metric view list',
          applyPartial: 'Some candidates failed; check the list',
        }
  }, [i18n.language])

  // form (reactive)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [timeRangeDays, setTimeRangeDays] = useState<number>(90)
  const [maxQuestions, setMaxQuestions] = useState<number>(30)
  // include_negative_feedback is fixed to false and only passed through payload
  const includeNegativeFeedback = false

  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [task, setTask] = useState<any>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set())
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set())
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const drawerScrollRef = useRef<HTMLDivElement | null>(null)
  const [loadedFromHistory, setLoadedFromHistory] = useState(false)
  const [skippedExpanded, setSkippedExpanded] = useState(false)

  // visibleProxy.set → emit('update:modelValue', v)
  const setVisible = useCallback(
    (v: boolean) => {
      onUpdateModelValue?.(v)
    },
    [onUpdateModelValue],
  )

  const isHistoricalResult = useMemo(
    () =>
      loadedFromHistory &&
      !!task &&
      (task.status === 'completed' || task.status === 'failed'),
    [loadedFromHistory, task],
  )

  const historicalTitle = useMemo(() => {
    if (!task) return ''
    const raw = task.updated_at || task.created_at
    let timeText = raw || ''
    try {
      if (raw) timeText = new Date(raw).toLocaleString()
    } catch (e) {
      timeText = raw
    }
    return t.historicalLoaded.replace('{time}', timeText)
  }, [task, t])

  function formatValidationError(text: any) {
    if (!text) return ''
    return String(text).slice(0, 500)
  }

  const skippedClusters = useMemo<any[]>(() => {
    if (!task || !task.stats) return []
    return Array.isArray(task.stats.skipped_clusters) ? task.stats.skipped_clusters : []
  }, [task])

  function dedupedSupportingQuestions(candidate: any): any[] {
    if (!candidate || !Array.isArray(candidate.supporting_questions)) return []
    const seen = new Set<string>()
    const result: any[] = []
    for (const q of candidate.supporting_questions) {
      const key = (q?.text || '').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      result.push(q)
    }
    return result
  }

  const progressPercent = useMemo(() => {
    if (!task) return running ? 5 : 0
    return PHASE_PERCENT[task.status] ?? 0
  }, [task, running])

  const progressPhase = useMemo(() => {
    if (!task) return running ? t.phasePending : ''
    const map: Record<string, string> = {
      pending: t.phasePending,
      extracting: t.phaseExtracting,
      clustering: t.phaseClustering,
      synthesizing: t.phaseSynthesizing,
      completed: t.phaseCompleted,
      failed: t.phaseFailed,
    }
    return map[task.status] ?? ''
  }, [task, running, t])

  const visibleCandidates = useMemo<any[]>(() => {
    if (!task || !task.candidates) return []
    return (task.candidates || []).filter((c: any) => {
      if (!c || c.merged_into) return false
      if (rejectedIds.has(c.candidate_id)) return false
      if (sourceId && String(c.source_id) !== String(sourceId)) return false
      return true
    })
  }, [task, rejectedIds, sourceId])

  const filteredOutCount = useMemo(() => {
    if (!task || !task.candidates || !sourceId) return 0
    return (task.candidates || []).filter(
      (c: any) =>
        c &&
        !c.merged_into &&
        !rejectedIds.has(c.candidate_id) &&
        String(c.source_id) !== String(sourceId),
    ).length
  }, [task, rejectedIds, sourceId])

  function getDataSourceDisplayName(ds: any) {
    if (!ds) return ''
    return ds.display_name || ds.name || ds.source_id
  }

  function sourceDisplayName(srcId: any) {
    if (!srcId) return t.unknownSource
    const hit = (dataSources || []).find((ds: any) => String(ds.source_id) === String(srcId))
    if (hit) return getDataSourceDisplayName(hit)
    return `${t.unknownSource} (${String(srcId).slice(0, 8)}...)`
  }

  function formatPercent(value: any) {
    const n = Number(value) || 0
    return `${Math.round(n * 100)}%`
  }

  function formatConflict(cf: any) {
    const sim = Number(cf.similarity || 0)
    return `${cf.name || cf.view_id}  (sim=${(sim * 100).toFixed(0)}%)`
  }

  function toggleSelect(candidateId: string) {
    setSelectedIds((prev) => {
      const idx = prev.indexOf(candidateId)
      if (idx >= 0) {
        const next = prev.slice()
        next.splice(idx, 1)
        return next
      }
      return [...prev, candidateId]
    })
  }

  function onCardClick(event: React.MouseEvent, candidateId: string) {
    if (appliedIds.has(candidateId)) return
    // Ignore check-toggle when clicking interactive elements (details/collapse already stopPropagation)
    const tag = ((event.target as HTMLElement).tagName || '').toLowerCase()
    if (['summary', 'a', 'button', 'input', 'code', 'details'].includes(tag)) return
    toggleSelect(candidateId)
  }

  function emitEdit(candidate: any) {
    onEditCandidate?.(JSON.parse(JSON.stringify(candidate)))
  }

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const resetTask = useCallback(() => {
    stopPolling()
    setTask(null)
    setSelectedIds([])
    setRejectedIds(new Set())
    setAppliedIds(new Set())
    setErrorMessage('')
    setLoadedFromHistory(false)
  }, [stopPolling])

  const startPolling = useCallback(
    (taskId: string) => {
      stopPolling()
      pollTimerRef.current = setInterval(async () => {
        try {
          const res = await getMetricViewRecommendationTaskReq(projectId, taskId)
          const next = res?.data
          if (!next) return
          setTask(next)
          if (next.status === 'completed' || next.status === 'failed') {
            stopPolling()
            setRunning(false)
            if (next.status === 'failed') {
              setErrorMessage(next.error_message || 'unknown error')
            }
          }
        } catch (e: any) {
          setErrorMessage(e?.message || String(e))
        }
      }, 2000)
    },
    [stopPolling, projectId, businessId],
  )

  const startAnalyze = useCallback(async () => {
    if (running) return
    resetTask()
    setRunning(true)
    try {
      const payload = {
        source_id: sourceId || null,
        time_range_days: timeRangeDays,
        max_questions: maxQuestions,
        include_negative_feedback: includeNegativeFeedback,
      }
      const res = await runMetricViewRecommendationReq(projectId, payload)
      const nextTask = res.data
      setTask(nextTask)
      const taskId = nextTask && (nextTask.task_id || nextTask.id)
      if (!taskId) {
        throw new Error('task_id missing in response')
      }
      if (nextTask.status === 'completed' || nextTask.status === 'failed') {
        setRunning(false)
        if (nextTask.status === 'failed') {
          setErrorMessage(nextTask.error_message || 'unknown error')
        }
        return
      }
      startPolling(taskId)
    } catch (e: any) {
      setRunning(false)
      const msg = e?.message || String(e)
      setErrorMessage(msg)
      notifications.show({ color: 'red', message: msg })
    }
  }, [
    running,
    resetTask,
    sourceId,
    timeRangeDays,
    maxQuestions,
    includeNegativeFeedback,
    projectId,
    businessId,
    startPolling,
  ])

  async function loadLatest() {
    resetTask()
    try {
      const res = await getLatestMetricViewRecommendationReq(projectId)
      if (!res?.data) {
        notifications.show({ color: 'blue', message: t.noHistoricalResult })
        return
      }
      const nextTask = res.data
      setTask(nextTask)
      // In-flight task (other tab/session running): auto resume polling and disable "Start Analyze".
      // Otherwise progress bar stays visible but never updates, appearing stuck at X%.
      const taskId = nextTask.task_id || nextTask.id
      if (taskId && IN_FLIGHT_STATUSES.includes(nextTask.status)) {
        setRunning(true)
        startPolling(taskId)
        return
      }
      setLoadedFromHistory(true)
      if (Array.isArray(nextTask.applied_view_ids)) {
        setAppliedIds((prev) => {
          const next = new Set(prev)
          nextTask.applied_view_ids.forEach((rec: any) => {
            if (rec?.candidate_id) next.add(rec.candidate_id)
          })
          return next
        })
      }
    } catch (e: any) {
      setErrorMessage(e?.message || String(e))
    }
  }

  async function applySelections() {
    if (!task || !selectedIds.length) return
    setApplying(true)
    try {
      const selections = selectedIds.map((id) => ({ candidate_id: id }))
      const res = await applyMetricViewRecommendationReq(projectId, task.task_id || task.id,
        selections,
      )
      const results = res?.data?.results || []
      const okCount = results.filter((r: any) => r.success).length
      setAppliedIds((prev) => {
        const next = new Set(prev)
        results.forEach((r: any) => {
          if (r.success) next.add(r.candidate_id)
        })
        return next
      })
      if (okCount === results.length) {
        notifications.show({
          color: 'green',
          message: t.applyOk.replace('{n}', String(okCount)),
        })
      } else {
        notifications.show({ color: 'yellow', message: t.applyPartial })
      }
      setSelectedIds([])
      const updatedTask = res?.data?.task || task
      setTask(updatedTask)
      onApplied?.(results)
      // Auto-close Drawer when all succeed; keep open if any failure so users can review
      if (okCount > 0 && okCount === results.length) {
        setVisible(false)
      }
    } catch (e: any) {
      const msg = e?.message || String(e)
      setErrorMessage(msg)
      notifications.show({ color: 'red', message: msg })
    } finally {
      setApplying(false)
    }
  }

  // watch(props.modelValue)
  useEffect(() => {
    if (modelValue) {
      // When Drawer opens, do not resetTask; keep previous task and candidates (supports "edit candidate -> reopen Drawer" flow).
      // User can start fresh by clicking "Start Analyze" or "Load latest", which naturally triggers reset.
      // Reset content scroll bar to top separately; parameter bar sits above and does not scroll.
      queueMicrotask(() => {
        if (drawerScrollRef.current) {
          drawerScrollRef.current.scrollTop = 0
        }
      })
    } else {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelValue])

  // Receive parent-pushed pending candidate id and add to appliedIds to show "saved as draft".
  useEffect(() => {
    const cid = externallyAppliedCandidateId
    if (!cid) return
    setAppliedIds((prev) => {
      const next = new Set(prev)
      next.add(cid)
      return next
    })
    // Also remove it from selectedIds because user handled it through edit flow.
    setSelectedIds((prev) => {
      const idx = prev.indexOf(cid)
      if (idx >= 0) {
        const next = prev.slice()
        next.splice(idx, 1)
        return next
      }
      return prev
    })
  }, [externallyAppliedCandidateId])

  // onBeforeUnmount
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  useImperativeHandle(ref, () => ({ startAnalyze, resetTask }), [startAnalyze, resetTask])

  const progressStatusColor =
    task && task.status === 'failed' ? 'red' : task && task.status === 'completed' ? 'green' : 'blue'

  return (
    <Drawer
      opened={modelValue}
      onClose={() => setVisible(false)}
      title={t.drawerTitle}
      position="right"
      size="65%"
      closeOnClickOutside={false}
      keepMounted={false}
    >
      <div className={styles.recommendDrawer}>
        {/* Parameter bar (does not scroll, always visible at top) */}
        <Card className={styles.paramCard} shadow="none" withBorder padding="sm">
          <div className={styles.paramForm}>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t.sourceLabel}</div>
              <Select
                value={sourceId}
                onChange={(v) => setSourceId(v)}
                clearable
                placeholder={t.sourcePlaceholder}
                style={{ width: 220 }}
                data={(dataSources || []).map((ds: any) => ({
                  value: String(ds.source_id),
                  label: getDataSourceDisplayName(ds),
                }))}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t.timeRangeLabel}</div>
              <Select
                value={String(timeRangeDays)}
                onChange={(v) => setTimeRangeDays(Number(v))}
                style={{ width: 120 }}
                allowDeselect={false}
                data={[30, 60, 90, 180].map((d) => ({
                  value: String(d),
                  label: `${d} ${t.daysUnit}`,
                }))}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 13 }}>{t.maxQuestionsLabel}</div>
              <Select
                value={String(maxQuestions)}
                onChange={(v) => setMaxQuestions(Number(v))}
                style={{ width: 120 }}
                allowDeselect={false}
                data={[10, 20, 30, 50].map((m) => ({ value: String(m), label: String(m) }))}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Button loading={running} onClick={startAnalyze}>
                {running ? t.analyzing : t.startAnalyze}
              </Button>
              <Button variant="default" disabled={running} onClick={loadLatest}>
                {t.loadLatest}
              </Button>
            </div>
          </div>
          {(running || progressPhase) && (
            <div className={styles.progressBlock}>
              <Progress value={progressPercent} color={progressStatusColor} size={6} />
              <div className={styles.progressPhase}>{progressPhase}</div>
            </div>
          )}
          {errorMessage && <div className={styles.errorHint}>{errorMessage}</div>}
        </Card>

        {/* Scroll area: metrics / skipped clusters / candidate list (parameter bar above, not scrolling) */}
        <div ref={drawerScrollRef} className={styles.recommendScroll}>
          {/* Historical result hint */}
          {isHistoricalResult && (
            <Alert
              title={historicalTitle}
              color="blue"
              withCloseButton={false}
              icon={<IconInfoCircleFilled size={18} />}
              className={styles.historicalAlert}
            />
          )}

          {/* Metrics */}
          {task && task.stats && (task.status === 'completed' || task.status === 'failed') && (
            <div className={styles.statsBar}>
              <Badge variant="light" color="gray">
                {t.statsScanned}: {task.stats.questions_scanned ?? 0}
              </Badge>
              <Badge variant="light" color="gray">
                {t.statsClusters}: {task.stats.clusters ?? 0}
              </Badge>
              <Badge variant="light" color="green">
                {t.statsCandidates}: {visibleCandidates.length}
                {filteredOutCount ? (
                  <span className={styles.filteredOut}>
                    {' '}
                    (+{filteredOutCount} {t.filteredOut})
                  </span>
                ) : null}
              </Badge>
              <Badge variant="light" color="yellow">
                {t.statsLLMCalls}: {task.stats.llm_calls ?? 0}
              </Badge>
              <Badge variant="light" color="gray">
                {t.statsElapsed}: {Math.round((task.stats.elapsed_ms || 0) / 1000)}s
              </Badge>
              {task.status === 'failed' && (
                <span className={styles.statusFailed}>{t.statusFailed}</span>
              )}
            </div>
          )}

          {skippedClusters.length > 0 && (
            <div
              className={`${styles.skippedCard}${skippedExpanded ? ` ${styles.isOpen}` : ''}`}
            >
              <div
                className={styles.skippedCardHeader}
                onClick={() => setSkippedExpanded((v) => !v)}
              >
                <span className={styles.skippedCardIcon}>
                  <IconInfoCircleFilled size={16} />
                </span>
                <span className={styles.skippedCardTitle}>
                  {t.skippedTitle.replace('{n}', String(skippedClusters.length))}
                </span>
                <span className={styles.skippedCardAction}>
                  {skippedExpanded ? t.skippedCollapse : t.skippedExpand}
                  <span
                    className={`${styles.skippedCardToggle}${
                      skippedExpanded ? ` ${styles.isOpen}` : ''
                    }`}
                  >
                    <IconChevronDown size={14} />
                  </span>
                </span>
              </div>
              {skippedExpanded && (
                <ul className={styles.skippedList}>
                  {skippedClusters.map((item: any, idx: number) => (
                    <li key={idx}>
                      {typeof item === 'string' ? (
                        <span className={styles.skippedView}>{item}</span>
                      ) : (
                        <>
                          <span className={styles.skippedQ}>「{item.representative_text}」</span>
                          <span className={styles.skippedArrow}>→</span>
                          <span className={styles.skippedView}>{item.covered_by_name}</span>
                          <span className={styles.skippedMeta}>
                            (sim={Math.round((item.similarity || 0) * 100)}%, {item.member_count}{' '}
                            {t.skippedQuestions})
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Candidate list */}
          {visibleCandidates.length > 0 ? (
            <div className={styles.candidateList}>
              {visibleCandidates.map((candidate: any) => {
                const isSelected = selectedIds.includes(candidate.candidate_id)
                const isApplied = appliedIds.has(candidate.candidate_id)
                const isClickable = !isApplied
                const cardCls = [
                  styles.candidateCard,
                  isSelected ? styles.isSelected : '',
                  isApplied ? styles.isApplied : '',
                  isClickable ? styles.isClickable : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                const supporting = dedupedSupportingQuestions(candidate)
                return (
                  <Card
                    key={candidate.candidate_id}
                    className={cardCls}
                    shadow="sm"
                    withBorder
                    padding="md"
                    onClick={(e: React.MouseEvent) =>
                      onCardClick(e, candidate.candidate_id)
                    }
                  >
                    <div className={styles.candidateHeader}>
                      <div className={styles.candidateName}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isApplied}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(candidate.candidate_id)}
                        />
                        <span
                          className={`${styles.nameText}${
                            (candidate.confidence ?? 0) < 0.6 ? ` ${styles.lowConfidence}` : ''
                          }`}
                        >
                          {candidate.name}
                        </span>
                        <Badge color="blue" size="sm" variant="outline">
                          {t.sourceTagLabel}: {sourceDisplayName(candidate.source_id)}
                        </Badge>
                        <Badge color="gray" size="sm" variant="light">
                          {t.confidenceLabel}: {formatPercent(candidate.confidence)}
                        </Badge>
                        {isApplied && (
                          <Badge color="green" size="sm">
                            {t.appliedTag}
                          </Badge>
                        )}
                      </div>
                      <div
                        className={styles.candidateActions}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation()
                            emitEdit(candidate)
                          }}
                        >
                          {t.editCandidate}
                        </Button>
                      </div>
                    </div>

                    {candidate.description && (
                      <div className={styles.candidateDesc}>{candidate.description}</div>
                    )}

                    {/* Intent tag (level 2): quick glance at LLM-classified question type */}
                    {candidate.intent_labels && candidate.intent_labels.length > 0 && (
                      <div
                        className={styles.candidateIntents}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className={styles.intentPrefix}>{t.intentLabel}:</span>
                        {candidate.intent_labels.map((lab: string) => (
                          <Badge
                            key={lab}
                            size="sm"
                            color="blue"
                            variant="outline"
                            className={styles.intentChip}
                          >
                            {lab}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {candidate.aliases && candidate.aliases.length > 0 && (
                      <div className={styles.candidateAliases}>
                        {candidate.aliases.map((a: string) => (
                          <Badge key={a} size="sm" variant="light" color="gray">
                            {a}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {/* Key challenges (level 2): collapsed view of LLM-identified issues */}
                    {candidate.key_challenges && candidate.key_challenges.length > 0 && (
                      <details
                        className={styles.candidateChallenges}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary>
                          {t.keyChallenges} ({candidate.key_challenges.length})
                        </summary>
                        <ul className={styles.challengesList}>
                          {candidate.key_challenges.map((ch: string, idx: number) => (
                            <li key={idx}>{ch}</li>
                          ))}
                        </ul>
                        {candidate.intent_reasoning && (
                          <div className={styles.intentReasoning}>
                            <span className={styles.reasoningLabel}>{t.intentReasoning}:</span>{' '}
                            {candidate.intent_reasoning}
                          </div>
                        )}
                      </details>
                    )}

                    {candidate.validation_error && (
                      <Alert
                        title={t.validationErrorTitle}
                        color="yellow"
                        withCloseButton={false}
                        className={styles.candidateWarning}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        <div>{t.validationErrorHint}</div>
                        <details
                          className={styles.validationDetail}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <summary>{t.validationErrorDetail}</summary>
                          <code>{formatValidationError(candidate.validation_error)}</code>
                        </details>
                      </Alert>
                    )}

                    {candidate.conflict_with_existing &&
                      candidate.conflict_with_existing.length > 0 && (
                        <div className={styles.candidateConflicts}>
                          {candidate.conflict_with_existing.map((cf: any) => (
                            <Badge
                              key={cf.view_id}
                              color="red"
                              size="sm"
                              variant="outline"
                            >
                              {formatConflict(cf)}
                            </Badge>
                          ))}
                        </div>
                      )}

                    {supporting.length > 0 && (
                      <details
                        className={styles.candidateQuestions}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary>
                          {t.supportingQuestions} ({supporting.length})
                        </summary>
                        <ul>
                          {supporting.map((q: any) => (
                            <li key={q.question_id}>{q.text}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {candidate.reasoning && (
                      <div className={styles.candidateReasoning}>
                        <span className={styles.reasoningLabel}>{t.reasoning}:</span>{' '}
                        {candidate.reasoning}
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          ) : (
            task &&
            !running && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '40px 0',
                  color: '#909399',
                  fontSize: 13,
                }}
              >
                {task.stats && task.stats.questions_scanned > 0
                  ? t.emptyAfterRun
                  : t.emptyNoQuestions}
              </div>
            )
          )}
        </div>
        {/* /recommendScroll */}

        {/* Action bar (does not scroll, always fixed at bottom) */}
        {visibleCandidates.length > 0 && (
          <div className={styles.footerBar}>
            <span className={styles.applyHint}>{t.applyHint}</span>
            <span className={styles.selectedCount}>
              {t.selectedCount}: {selectedIds.length}
            </span>
            <Button
              disabled={!selectedIds.length || applying}
              loading={applying}
              onClick={applySelections}
            >
              {t.applyButton} ({selectedIds.length})
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  )
})

export default MetricViewRecommendationDrawer
