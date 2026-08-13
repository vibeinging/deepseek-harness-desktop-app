// Migrated from views/database/components/guide/advanced/EntitySuggestDialog.vue
// el-dialog converted to Mantine Modal; per-table sequential analysis logic and Step 1/2/3 flow are fully preserved.
import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Modal,
  Button,
  TextInput,
  Checkbox,
  Progress,
  MultiSelect,
  Center,
  Text,
  Badge
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconSearch,
  IconLoader2,
  IconCircleCheck,
  IconCircleX,
  IconChevronUp,
  IconChevronDown
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import {
  suggestEntityColumnsReq,
  batchCreateEntityConfigsReq,
  getTableColumnsReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './EntitySuggestDialog.module.scss'

export interface EntitySuggestDialogProps {
  modelValue?: boolean
  databaseId?: string | null
  tables?: any[]
  'onUpdate:modelValue'?: (val: boolean) => void
  onCreated?: () => void
}

interface TableProgress {
  tableId: any
  displayName: string
  columnCount: number
  status: 'pending' | 'running' | 'done' | 'error'
  foundCount: number
}

export default function EntitySuggestDialog(props: EntitySuggestDialogProps) {
  const { modelValue = false, databaseId = null, tables = [] } = props
  const { t } = useTranslation()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // ====== Core state ======
  const [step, setStep] = useState(1)
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [creating, setCreating] = useState(false)
  const [tableProgress, setTableProgress] = useState<TableProgress[]>([])
  const [currentTableName, setCurrentTableName] = useState('')
  const [selectedTableIds, setSelectedTableIds] = useState<any[]>([])
  const [editableConfigs, setEditableConfigs] = useState<any[]>([])

  // cancelled uses ref so analysis loop can always read the latest value (same as Vue's cancelled.value)
  const cancelledRef = useRef(false)
  // Accumulated suggestions; append during loop and sync with state, matching Vue's allSuggestions.value behavior.
  const allSuggestionsRef = useRef<any[]>([])

  // ====== Step 1: Select tables ======
  const [tableSearchQuery, setTableSearchQuery] = useState('')

  const tableItems = useMemo(() => {
    return tables.map((table) => ({
      ...table,
      displayName:
        table.schema_name && table.schema_name !== 'default'
          ? `${table.schema_name}.${table.table_name}`
          : table.table_name
    }))
  }, [tables])

  const filteredTableItems = useMemo(() => {
    const q = tableSearchQuery.trim().toLowerCase()
    if (!q) return tableItems
    return tableItems.filter((tb) => tb.displayName.toLowerCase().includes(q))
  }, [tableItems, tableSearchQuery])

  const isAllSelected = useMemo(() => {
    return tables.length > 0 && selectedTableIds.length === tables.length
  }, [tables.length, selectedTableIds.length])

  const toggleTable = (tableId: any) => {
    setSelectedTableIds((prev) => {
      const idx = prev.indexOf(tableId)
      if (idx >= 0) {
        const next = [...prev]
        next.splice(idx, 1)
        return next
      }
      return [...prev, tableId]
    })
  }

  const toggleSelectAll = () => {
    const visibleIds = filteredTableItems.map((tb) => tb.id)
    setSelectedTableIds((prev) => {
      const allVisibleSelected = visibleIds.every((id) => prev.includes(id))
      if (allVisibleSelected) {
        // Deselect currently visible items
        return prev.filter((id) => !visibleIds.includes(id))
      }
        // Select currently visible items (keep previously selected hidden items)
      const set = new Set(prev)
      visibleIds.forEach((id) => set.add(id))
      return [...set]
    })
  }

  // ====== Step 2: Analyze ======
  const totalTableCount = tableProgress.length
  const completedCount = tableProgress.filter(
    (tb) => tb.status === 'done' || tb.status === 'error'
  ).length
  const progressPercent = useMemo(() => {
    if (totalTableCount === 0) return 0
    return Math.round((completedCount / totalTableCount) * 100)
  }, [totalTableCount, completedCount])

  // Column cache: tableId → columns[] (stored in ref to avoid stale closure values in loop)
  const tableColumnsCacheRef = useRef<Record<string, any[]>>({})
  const [, forceColumnsTick] = useState(0)

  const goToAnalysis = () => {
    setStep(2)
    startAnalysis()
  }

  const startAnalysis = async () => {
    setRunning(true)
    setFinished(false)
    cancelledRef.current = false
    allSuggestionsRef.current = []

    // Initialize progress list (equivalent to initTableProgress)
    const selectedSet = new Set(selectedTableIds)
    const initial: TableProgress[] = tableItems
      .filter((tb) => selectedSet.has(tb.id))
      .map((table) => ({
        tableId: table.id,
        displayName: table.displayName,
        columnCount: table.column_count || 0,
        status: 'pending',
        foundCount: 0
      }))
    // Local working copy, update in place during loop and sync to state
    const progress = initial.map((p) => ({ ...p }))
    setTableProgress(progress.map((p) => ({ ...p })))

    const sync = () => setTableProgress(progress.map((p) => ({ ...p })))

    for (let i = 0; i < progress.length; i++) {
      if (cancelledRef.current) break

      const item = progress[i]
      item.status = 'running'
      setCurrentTableName(item.displayName)
      sync()

      try {
        const res: any = await suggestEntityColumnsReq(currentProjectId, databaseId, {
          table_ids: [item.tableId],
          min_score: 0.6
        })

        if (cancelledRef.current) break

        if (res.success && res.data) {
          const items = res.data.items || res.data || []
          item.foundCount = items.length
          item.status = 'done'
          allSuggestionsRef.current.push(...items)
        } else {
          item.status = 'done'
          item.foundCount = 0
        }
      } catch (error) {
        console.error(`分析表 ${item.displayName} 失败:`, error)
        item.status = 'error'
      }
      sync()
    }

    setRunning(false)
    setCurrentTableName('')
    if (!cancelledRef.current) {
      setFinished(true)
    }
    // Auto jump to Step 3
    buildEditableConfigs()
    setStep(3)
  }

  const cancelAnalysis = () => {
    cancelledRef.current = true
    setRunning(false)
    setFinished(true)
    buildEditableConfigs()
    setStep(3)
  }

  // ====== Step 3: Confirm and edit ======
  const buildEditableConfigs = () => {
    const built = [...allSuggestionsRef.current]
      .sort((a, b) => {
        if (a.already_exists !== b.already_exists) return a.already_exists ? 1 : -1
        return b.score - a.score
      })
      .map((item) => ({
        ...item,
        _displayTable:
          item.schema_name && item.schema_name !== 'default'
            ? `${item.schema_name}.${item.table_name}`
            : item.table_name,
        _checked: !item.already_exists,
        _expanded: false,
        rule: item.column_description || '',
        metadata_fields: [] as string[]
      }))
    setEditableConfigs(built)
  }

  const checkedConfigs = useMemo(
    () => editableConfigs.filter((c) => c._checked && !c.already_exists),
    [editableConfigs]
  )

  const isAllChecked = useMemo(() => {
    const selectable = editableConfigs.filter((c) => !c.already_exists)
    return selectable.length > 0 && selectable.every((c) => c._checked)
  }, [editableConfigs])

  const isIndeterminate = useMemo(() => {
    const selectable = editableConfigs.filter((c) => !c.already_exists)
    const checked = selectable.filter((c) => c._checked)
    return checked.length > 0 && checked.length < selectable.length
  }, [editableConfigs])

  const toggleCheckAll = (val: boolean) => {
    setEditableConfigs((prev) =>
      prev.map((c) => (c.already_exists ? c : { ...c, _checked: val }))
    )
  }

  // Update one config field (immutable update)
  const updateConfigAt = (index: number, patch: Record<string, any>) => {
    setEditableConfigs((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const loadTableColumns = async (tableId: any) => {
    if (tableColumnsCacheRef.current[tableId]) return
    try {
      const res: any = await getTableColumnsReq(currentProjectId, databaseId, tableId)
      if (res.success && res.data) {
        tableColumnsCacheRef.current[tableId] = res.data.items || res.data || []
        forceColumnsTick((n) => n + 1)
      }
    } catch (e) {
      console.error('加载列信息失败:', e)
    }
  }

  const handleExpand = async (config: any, index: number) => {
    const nextExpanded = !config._expanded
    updateConfigAt(index, { _expanded: nextExpanded })
    if (nextExpanded && !config.already_exists) {
      await loadTableColumns(config.table_id)
    }
  }

  const getColumnsForMetadata = (tableId: any, excludeColumnName: string) => {
    const cols = tableColumnsCacheRef.current[tableId] || []
    return cols.filter((col) => col.column_name !== excludeColumnName)
  }

  const selectAllMetadata = (index: number) => {
    const config = editableConfigs[index]
    const cols = getColumnsForMetadata(config.table_id, config.column_name)
    updateConfigAt(index, { metadata_fields: cols.map((c) => c.column_name) })
  }

  const getScoreClass = (score: number) => {
    if (score >= 0.7) return styles.scoreHigh
    if (score >= 0.4) return styles.scoreMid
    return styles.scoreLow
  }

  const handleCreate = async () => {
    if (checkedConfigs.length === 0) return
    setCreating(true)
    try {
      const columns = checkedConfigs.map((item) => ({
        table_id: item.table_id,
        column_name: item.column_name,
        rule: item.rule || '',
        metadata_fields: item.metadata_fields || []
      }))
      const res: any = await batchCreateEntityConfigsReq(
        currentProjectId,
        databaseId,
        columns,
        undefined
      )
      if (res.success) {
        const created = (res.data?.results || []).filter((r: any) => r.success).length
        notifications.show({
          color: 'green',
          message: t('database.guide.advanced.suggestCreateSuccess', { count: created })
        })
        props.onCreated?.()
        props['onUpdate:modelValue']?.(false)
      }
    } catch (error) {
      console.error('批量创建失败:', error)
      notifications.show({
        color: 'red',
        message: t('database.guide.advanced.suggestCreateError')
      })
    } finally {
      setCreating(false)
    }
  }

  // ====== Navigation and modal control ======
  const goBackToSelect = () => {
    setStep(1)
    allSuggestionsRef.current = []
    setEditableConfigs([])
    setTableProgress([])
    setFinished(false)
  }

  const handleClose = () => {
    props['onUpdate:modelValue']?.(false)
  }

  // Mantine Modal @update:model-value/before-close: cancel analysis if it is still running
  const handleModalClose = () => {
    if (running) {
      cancelAnalysis()
    }
    props['onUpdate:modelValue']?.(false)
  }

  // Reset state when modal opens (equivalent to watch modelValue)
  useEffect(() => {
    if (modelValue) {
      setStep(1)
      setFinished(false)
      setRunning(false)
      cancelledRef.current = false
      setCreating(false)
      allSuggestionsRef.current = []
      setEditableConfigs([])
      setTableProgress([])
      setTableSearchQuery('')
      tableColumnsCacheRef.current = {}
      setSelectedTableIds(tables.map((tb) => tb.id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelValue])

  const renderCheckSvg = () => (
    <svg className={styles.checkIcon} viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  // ─── Footer content (switches by step) ───
  const footer = (
    <div className={styles.dialogFooter}>
      {step === 1 && (
        <>
          <Button variant="default" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={goToAnalysis} disabled={selectedTableIds.length === 0}>
            {t('database.guide.advanced.suggestStartAnalysis')}
            {selectedTableIds.length > 0 ? ` (${selectedTableIds.length})` : ''}
          </Button>
        </>
      )}
      {step === 2 && (
        <Button variant="default" onClick={cancelAnalysis} disabled={!running}>
          {t('database.guide.advanced.suggestCancel')}
        </Button>
      )}
      {step === 3 && (
        <>
          <Button variant="default" onClick={goBackToSelect}>
            {t('database.guide.advanced.suggestBackToSelect')}
          </Button>
          {editableConfigs.length > 0 ? (
            <Button
              onClick={handleCreate}
              loading={creating}
              disabled={checkedConfigs.length === 0}
            >
              {t('database.guide.advanced.suggestCreateEntities')}
              {checkedConfigs.length > 0 ? ` (${checkedConfigs.length})` : ''}
            </Button>
          ) : (
            <Button variant="default" onClick={handleClose}>
              {t('common.close')}
            </Button>
          )}
        </>
      )}
    </div>
  )

  return (
    <Modal
      opened={modelValue}
      onClose={handleModalClose}
      title={t('database.guide.advanced.suggestEntity')}
      size="80%"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!running}
      className="entity-suggest-dialog"
      classNames={{ content: styles.dialogContent }}
    >
      {/* Step indicators */}
      <div className={styles.stepsBar}>
        <div className={clsx(styles.step, { [styles.active]: step === 1, [styles.done]: step > 1 })}>
          <span className={styles.stepDot}>
            {step > 1 ? renderCheckSvg() : <span>1</span>}
          </span>
          <span className={styles.stepLabel}>
            {t('database.guide.advanced.suggestStepSelect')}
          </span>
        </div>
        <div className={styles.stepLine}>
          <div className={clsx(styles.stepLineFill, { [styles.done]: step > 1 })} />
        </div>
        <div className={clsx(styles.step, { [styles.active]: step === 2, [styles.done]: step > 2 })}>
          <span className={styles.stepDot}>
            {step > 2 ? (
              renderCheckSvg()
            ) : step === 2 && running ? (
              <span className={styles.pulseRing} />
            ) : (
              <span>2</span>
            )}
          </span>
          <span className={styles.stepLabel}>
            {t('database.guide.advanced.suggestStepAnalyze')}
          </span>
        </div>
        <div className={styles.stepLine}>
          <div className={clsx(styles.stepLineFill, { [styles.done]: step > 2 })} />
        </div>
        <div className={clsx(styles.step, { [styles.active]: step === 3 })}>
          <span className={styles.stepDot}>
            <span>3</span>
          </span>
          <span className={styles.stepLabel}>
            {t('database.guide.advanced.suggestStepConfirm')}
          </span>
        </div>
      </div>

      <div className={styles.dialogBody}>
              {/* Step 1: Select tables */}
        {step === 1 && (
          <>
            <div className={styles.selectHeader}>
              <span className={styles.selectTitle}>
                {t('database.guide.advanced.suggestSelectTables')}
              </span>
              <div className={styles.selectActions}>
                <Button variant="subtle" size="compact-sm" onClick={toggleSelectAll}>
                  {isAllSelected
                    ? t('database.guide.advanced.suggestDeselectAll')
                    : t('database.guide.advanced.suggestSelectAll')}
                </Button>
                <span className={styles.selectCount}>
                  {selectedTableIds.length} / {tables.length}
                </span>
              </div>
            </div>
            <TextInput
              value={tableSearchQuery}
              onChange={(e) => setTableSearchQuery(e.currentTarget.value)}
              placeholder={t('database.guide.advanced.suggestSearchTable')}
              size="sm"
              className={styles.tableSearchInput}
              leftSection={<IconSearch size={14} />}
            />
            <div className={styles.tableSelectList}>
              {filteredTableItems.map((table) => (
                <div
                  key={table.id}
                  className={clsx(styles.selectItem, {
                    [styles.selected]: selectedTableIds.includes(table.id)
                  })}
                  onClick={() => toggleTable(table.id)}
                >
                  <Checkbox
                    checked={selectedTableIds.includes(table.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleTable(table.id)}
                  />
                  <span className={styles.itemName}>{table.displayName}</span>
                  <span className={styles.itemCols}>
                    {table.column_count || 0} {t('database.guide.advanced.suggestColumns')}
                  </span>
                </div>
              ))}
              {filteredTableItems.length === 0 && (
                <div className={styles.noMatchHint}>
                  {t('database.guide.advanced.suggestNoMatch')}
                </div>
              )}
            </div>
          </>
        )}

        {/* Step 2: Analysis progress */}
        {step === 2 && (
          <>
            <div className={styles.overallProgress}>
              <div className={styles.progressHeader}>
                <span className={styles.progressTitle}>
                  {running
                    ? t('database.guide.advanced.suggestAnalyzing')
                    : t('database.guide.advanced.suggestAnalysisDone')}
                </span>
                <span className={styles.progressStats}>
                  {completedCount} / {totalTableCount}
                </span>
              </div>
              <Progress
                value={progressPercent}
                color={!running && finished ? 'green' : 'grape'}
                size={6}
              />
              {running && currentTableName && (
                <div className={styles.progressDetail}>
                  {t('database.guide.advanced.suggestCurrentTable', { table: currentTableName })}
                </div>
              )}
            </div>

            <div className={styles.tableProgressList}>
              {tableProgress.map((item) => (
                <div
                  key={item.tableId}
                  className={clsx(styles.progressItem, {
                    [styles.isRunning]: item.status === 'running',
                    [styles.isDone]: item.status === 'done',
                    [styles.isError]: item.status === 'error'
                  })}
                >
                  <div className={styles.progressItemLeft}>
                    <span className={styles.statusIcon}>
                      {item.status === 'running' ? (
                        <IconLoader2 size={16} className={styles.isLoading} />
                      ) : item.status === 'done' ? (
                        <IconCircleCheck size={16} className={styles.doneIcon} />
                      ) : item.status === 'error' ? (
                        <IconCircleX size={16} className={styles.errorIcon} />
                      ) : (
                        <span className={styles.pendingDot} />
                      )}
                    </span>
                    <span className={styles.progressTableName}>{item.displayName}</span>
                    <span className={styles.progressColCount}>
                      {item.columnCount} {t('database.guide.advanced.suggestColumns')}
                    </span>
                  </div>
                  <div className={styles.progressItemRight}>
                    {item.status === 'done' && item.foundCount > 0 ? (
                      <span className={styles.foundCount}>
                        {t('database.guide.advanced.suggestFoundEntities', {
                          count: item.foundCount
                        })}
                      </span>
                    ) : item.status === 'done' ? (
                      <span className={styles.foundNone}>
                        {t('database.guide.advanced.suggestNoEntities')}
                      </span>
                    ) : item.status === 'error' ? (
                      <span className={styles.errorText}>
                        {t('database.guide.advanced.suggestTableError')}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Step 3: Confirm results and edit configs */}
        {step === 3 &&
          (editableConfigs.length > 0 ? (
            <div className={styles.resultSection}>
              <div className={styles.resultHeader}>
                <span className={styles.resultSummary}>
                  {t('database.guide.advanced.suggestResultSummary', {
                    total: editableConfigs.length,
                    selected: checkedConfigs.length
                  })}
                </span>
                <Checkbox
                  checked={isAllChecked}
                  indeterminate={isIndeterminate}
                  onChange={(e) => toggleCheckAll(e.currentTarget.checked)}
                  label={t('database.guide.advanced.suggestSelectAll')}
                />
              </div>
              <div className={styles.configList}>
                {editableConfigs.map((config, index) => (
                  <div
                    key={`${config.table_id}-${config.column_name}`}
                    className={clsx(styles.configCard, {
                      [styles.disabled]: config.already_exists
                    })}
                  >
                    {/* Card header: check box + table.column + score + samples */}
                    <div className={styles.configCardHeader}>
                      <Checkbox
                        checked={!!config._checked}
                        disabled={config.already_exists}
                        onChange={(e) => updateConfigAt(index, { _checked: e.currentTarget.checked })}
                      />
                      <div className={styles.configCardInfo}>
                        <span className={styles.configTableCol}>
                          <span className={styles.monoText}>
                            {config._displayTable}.{config.column_name}
                          </span>
                          {config.already_exists && (
                            <Badge size="sm" color="gray" variant="light">
                              {t('database.guide.advanced.suggestAlreadyExists')}
                            </Badge>
                          )}
                        </span>
                        <div className={styles.configCardMeta}>
                          <span className={clsx(styles.scoreBadge, getScoreClass(config.score))}>
                            {config.score?.toFixed(2)}
                          </span>
                          {config.sample_values?.length ? (
                            <span className={styles.samplePreview}>
                              {config.sample_values.slice(0, 3).join('、')}
                              {config.sample_values.length > 3 && (
                                <span className={styles.moreText}>
                                  {' '}
                                  +{config.sample_values.length - 3}
                                </span>
                              )}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        className={styles.expandBtn}
                        leftSection={
                          config._expanded ? (
                            <IconChevronUp size={14} />
                          ) : (
                            <IconChevronDown size={14} />
                          )
                        }
                        onClick={() => handleExpand(config, index)}
                      >
                        {config._expanded
                          ? t('database.guide.advanced.suggestCollapse')
                          : t('database.guide.advanced.suggestExpand')}
                      </Button>
                    </div>

                    {/* Expanded section: rule + metadata fields */}
                    {config._expanded && !config.already_exists && (
                      <div className={styles.configCardBody}>
                        <div className={styles.fieldRow}>
                          <span className={styles.fieldLabel}>
                            {t('business.entity.configDescription')}
                          </span>
                          <TextInput
                            value={config.rule}
                            onChange={(e) =>
                              updateConfigAt(index, { rule: e.currentTarget.value })
                            }
                            placeholder={t('business.entity.configDescPlaceholder')}
                            size="sm"
                            maxLength={500}
                          />
                        </div>
                        <div className={styles.fieldRow}>
                          <div className={styles.fieldLabelWithActions}>
                            <span className={styles.fieldLabel}>
                              {t('business.entity.metadataFieldsLabel')}
                            </span>
                            <Button
                              variant="subtle"
                              size="compact-sm"
                              onClick={() => selectAllMetadata(index)}
                            >
                              {t('business.entity.selectAll')}
                            </Button>
                            <Button
                              variant="subtle"
                              size="compact-sm"
                              onClick={() => updateConfigAt(index, { metadata_fields: [] })}
                              disabled={!config.metadata_fields?.length}
                            >
                              {t('business.entity.deselect')}
                            </Button>
                          </div>
                          <MultiSelect
                            value={config.metadata_fields}
                            onChange={(val) => updateConfigAt(index, { metadata_fields: val })}
                            searchable
                            placeholder={t('business.entity.metadataPlaceholder')}
                            size="sm"
                            style={{ width: '100%' }}
                            data={getColumnsForMetadata(config.table_id, config.column_name).map(
                              (col: any) => ({
                                value: col.column_name,
                                label: col.column_name
                              })
                            )}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.emptyResult}>
              <Center>
                <Text c="dimmed" size="sm">
                  {t('database.guide.advanced.noSuggestions')}
                </Text>
              </Center>
            </div>
          ))}
      </div>

      {footer}
    </Modal>
  )
}
