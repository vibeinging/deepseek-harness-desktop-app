import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, HoverCard, Loader, Table, Tabs, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconFileText } from '@tabler/icons-react'
import { executeMetadataQueryReq, getCachedTablesReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import SqlEditor, { SqlEditorHandle } from '@/components/SqlEditor'
import styles from './DatabaseMetadataQuery.module.scss'

// defineProps → props + interface
interface DatabaseMetadataQueryProps {
  databaseId: string
  dbType: string
}

// Query result item type (source has no strict type, so use loose any)
interface QueryResult {
  id: number
  sql: string
  status: 'running' | 'success' | 'error'
  success: boolean
  columns: any[]
  rows: any[]
  row_count: number
  cost_time: number
  error: string | null
}

export default function DatabaseMetadataQuery(props: DatabaseMetadataQueryProps) {
  const { databaseId } = props

  const { t } = useTranslation()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  // State
  const [sqlQuery, setSqlQuery] = useState('')
  const [queryResults, setQueryResults] = useState<QueryResult[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const sqlEditorRef = useRef<SqlEditorHandle>(null)
  const [activeResultTab, setActiveResultTab] = useState<string>('')

  // abortControllers and currentRunningId are non-render state, kept in refs to avoid stale closures
  const abortControllers = useRef<Record<number, AbortController>>({})
  const currentRunningId = useRef<number | null>(null)

  // Table names and columns (used for autocomplete)
  const [tableNames, setTableNames] = useState<string[]>([])
  const [tableColumns, setTableColumns] = useState<Record<string, any>>({})

  // Load table metadata for autocomplete
  const loadTableMetadata = async () => {
    try {
      const res: any = await getCachedTablesReq(currentProjectId, databaseId)
      const tables = res.data?.items || []
      setTableNames(tables.map((tb: any) => tb.table_name))

      const columnMap: Record<string, any> = {}
      tables.forEach((table: any) => {
        if (table.columns && table.columns.length > 0) {
          columnMap[table.table_name] = table.columns.map((c: any) => c.column_name || c.name)
        }
      })
      setTableColumns(columnMap)
    } catch (error) {
      console.error('Failed to load table metadata:', error)
    }
  }

  // watch(() => props.databaseId, { immediate: true }) -> useEffect depends on databaseId
  useEffect(() => {
    loadTableMetadata()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  const handleSelectSql = (result: QueryResult) => {
    setSqlQuery(result.sql)
  }

  const handleRun = async (sqlToRun?: string) => {
    const sql = (sqlToRun || sqlQuery).trim()
    if (!sql) {
      notifications.show({ color: 'yellow', message: t('database.query.emptySql') })
      return
    }

    const resultId = Date.now()
    const result: QueryResult = {
      id: resultId,
      sql: sql,
      status: 'running',
      success: false,
      columns: [],
      rows: [],
      row_count: 0,
      cost_time: 0,
      error: null
    }

    setQueryResults((prev) => [result, ...prev])
    setActiveResultTab(String(resultId))
    setIsRunning(true)
    currentRunningId.current = resultId

    const startTime = Date.now()
    const controller = new AbortController()
    abortControllers.current[resultId] = controller

    try {
      const res: any = await executeMetadataQueryReq(
        currentProjectId,
        databaseId,
        {
          sql: sql,
          limit: 200,
          timeout: 60
        },
        { signal: controller.signal }
      )

      const costTime = Date.now() - startTime
      const queryData = res.data || res

      if (res.success && queryData) {
        setQueryResults((prev) =>
          prev.map((r) =>
            r.id === resultId
              ? {
                  ...r,
                  success: queryData.success,
                  columns: queryData.columns || [],
                  rows: queryData.rows || [],
                  row_count: queryData.row_count || 0,
                  cost_time: queryData.cost_time || costTime,
                  error: queryData.error,
                  status: queryData.success ? 'success' : 'error'
                }
              : r
          )
        )

        if (queryData.success) {
          notifications.show({ color: 'green', message: t('database.query.querySuccess') })
        } else {
          notifications.show({ color: 'red', message: queryData.error || t('database.query.queryFailed') })
        }
      } else {
        setQueryResults((prev) =>
          prev.map((r) =>
            r.id === resultId
              ? {
                  ...r,
                  status: 'error',
                  error: res.msg || t('database.query.queryFailed'),
                  cost_time: costTime
                }
              : r
          )
        )
        notifications.show({ color: 'red', message: res.msg || t('database.query.queryFailed') })
      }
    } catch (error: any) {
      setQueryResults((prev) =>
        prev.map((r) =>
          r.id === resultId
            ? {
                ...r,
                status: 'error',
                error: error.message || t('database.query.queryFailed'),
                cost_time: Date.now() - startTime
              }
            : r
        )
      )
      notifications.show({ color: 'red', message: t('database.query.queryFailed') })
    } finally {
      delete abortControllers.current[resultId]
      setIsRunning(false)
      currentRunningId.current = null
    }
  }

  const handleCancelCurrent = () => {
    if (currentRunningId.current && abortControllers.current[currentRunningId.current]) {
      const result = queryResults.find((r) => r.id === currentRunningId.current)
      if (result) handleCancel(result)
    }
  }

  const handleCancel = (result: QueryResult) => {
    const resultId = result.id
    if (abortControllers.current[resultId]) {
      abortControllers.current[resultId].abort()
      delete abortControllers.current[resultId]
    }
    setQueryResults((prev) =>
      prev.map((r) =>
        r.id === resultId
          ? {
              ...r,
              status: 'error',
              error: t('database.query.cancelled')
            }
          : r
      )
    )
    setIsRunning(false)
    currentRunningId.current = null
    notifications.show({ color: 'yellow', message: t('database.query.cancelled') })
  }

  const handleRemove = (id: string | number) => {
    const resultId = typeof id === 'string' ? Number(id) : id
    const result = queryResults.find((r) => r.id === resultId)
    if (result?.status === 'running' && abortControllers.current[resultId]) {
      abortControllers.current[resultId].abort()
      delete abortControllers.current[resultId]
      setIsRunning(false)
      currentRunningId.current = null
    }

    setQueryResults((prev) => {
      const index = prev.findIndex((r) => r.id === resultId)
      if (index <= -1) return prev
      const next = [...prev]
      next.splice(index, 1)
      if (activeResultTab === String(resultId)) {
        setActiveResultTab(next.length > 0 ? String(next[0].id) : '')
      }
      return next
    })
  }

  const handleExport = (result: QueryResult) => {
    if (!result.rows || result.rows.length === 0) return
    const columns = displayColumnsForResult(result)
    if (columns.length === 0) return
    const csvContent = generateCSV(result.rows, columns)
    downloadFile(csvContent, `query_result_${result.id}.csv`, 'text/csv;charset=utf-8;')
    notifications.show({ color: 'green', message: t('database.query.exportSuccess') })
  }

  const generateCSV = (data: any[], columns: string[]) => {
    const header = columns.join(',')
    const rows = data.map((row) => {
      return columns
        .map((col) => {
          const value = row[col]
          if (value === null || value === undefined) return ''
          const str = String(value)
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`
          }
          return str
        })
        .join(',')
    })
    return [header, ...rows].join('\n')
  }

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob(['﻿' + content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const getResultTabLabel = (result: QueryResult, index: number) => {
    const sqlPreview = result.sql.trim().substring(0, 20).replace(/\n/g, ' ')
    const suffix = result.sql.length > 20 ? '...' : ''
    return `#${index + 1} ${sqlPreview}${suffix}`
  }

  const formatCellValue = (value: any) => {
    if (value === null) return 'NULL'
    if (value === undefined) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }

  const columnKeyFromMeta = (c: any) => {
    if (c == null) return ''
    if (typeof c === 'string') return c
    return c.column_name || c.name || ''
  }

  const displayColumnsForResult = (result: QueryResult): string[] => {
    const fromMeta = (result.columns || []).map(columnKeyFromMeta).filter(Boolean)
    if (fromMeta.length > 0) return fromMeta
    const row0 = result.rows?.[0]
    if (row0 && typeof row0 === 'object' && !Array.isArray(row0)) return Object.keys(row0)
    return []
  }

  return (
    <div
      className={`${styles['metadata-query-container']} ${
        queryResults.length > 0 ? styles['has-results'] : ''
      }`}
    >
      {/* SQL edit area */}
      {/* In the original source, class="metadata-sql-input" is attached directly to SqlEditor and picked up by :deep theme overrides.
          The React SqlEditor does not pass className through, so wrap it with a div carrying the class.
          This keeps .module.scss .global(metadata-sql-input...) / .cm-* theme overrides effective. */}
      <div className={styles['query-editor']}>
        <div className="metadata-sql-input">
          <SqlEditor
            ref={sqlEditorRef}
            modelValue={sqlQuery}
            {...{ 'onUpdate:modelValue': setSqlQuery }}
            tables={tableNames}
            columns={tableColumns}
            placeholder={t('database.query.placeholder')}
            height={'420px'}
            showToolbar={true}
            showStatusBar={true}
            showSelectionPreview={false}
            vividSelection={true}
            isRunning={isRunning}
            onRun={handleRun}
            onCancel={handleCancelCurrent}
          />
        </div>
      </div>

      {/* Query results area with tab switching */}
      {queryResults.length > 0 ? (
        <div className={styles['query-results']}>
          <Tabs
            value={activeResultTab}
            onChange={(v) => setActiveResultTab(v || '')}
            variant="pills"
          >
            <Tabs.List>
              {queryResults.map((result, index) => (
                <Tabs.Tab
                  key={result.id}
                  value={String(result.id)}
                  leftSection={
                    <span
                      className={[
                        styles['result-tab-dot'],
                        styles[`result-tab-${result.status}`]
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    />
                  }
                  rightSection={
                    <button
                      type="button"
                      className={styles['result-tab-close']}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemove(result.id)
                      }}
                    >
                      ×
                    </button>
                  }
                >
                  {getResultTabLabel(result, index)}
                </Tabs.Tab>
              ))}
            </Tabs.List>

            {queryResults.map((result) => (
              <Tabs.Panel key={result.id} value={String(result.id)}>
                <div
                  className={`${styles['result-content']} ${
                    result.status === 'error' ? styles['result-error'] : ''
                  }`}
                >
                  {/* Running */}
                  {result.status === 'running' ? (
                    <div className={styles['loading-container']}>
                      <Loader size={18} color="gray" />
                      <span>{t('database.query.running')}</span>
                    </div>
                  ) : result.status === 'error' ? (
                    /* Show SQL and error message when failed */
                    <>
                      <div
                        className={`${styles['sql-preview']} ${styles['sql-preview-error']}`}
                        onClick={() => handleSelectSql(result)}
                      >
                        <pre>
                          <code>{result.sql}</code>
                        </pre>
                      </div>
                      {result.error && (
                        <Alert color="red" withCloseButton={false} className={styles['error-alert']}>
                          {result.error}
                        </Alert>
                      )}
                    </>
                  ) : result.success ? (
                    /* Show results on success */
                    <>
                      {/* Result stats and actions */}
                      <div className={styles['result-header']}>
                        <div className={styles['result-stats']}>
                          <span className={`${styles['stat-badge']} ${styles['stat-rows']}`}>
                            <span className={styles['stat-value']}>{result.row_count}</span>
                            <span className={styles['stat-label']}>{t('database.query.rows')}</span>
                          </span>
                          <span className={`${styles['stat-badge']} ${styles['stat-time']}`}>
                            <span className={styles['stat-value']}>{result.cost_time}</span>
                            <span className={styles['stat-label']}>{t('database.query.milliseconds')}</span>
                          </span>
                        </div>
                        <div className={styles['result-actions']}>
                          <HoverCard position="bottom" width={400} withArrow shadow="md">
                            <HoverCard.Target>
                              <Button
                                variant="subtle"
                                size="compact-sm"
                                className={styles['action-btn']}
                                leftSection={<IconFileText size={14} />}
                              >
                                SQL
                              </Button>
                            </HoverCard.Target>
                            <HoverCard.Dropdown>
                              <pre className={styles['sql-popover']}>{result.sql}</pre>
                            </HoverCard.Dropdown>
                          </HoverCard>
                          {result.rows && result.rows.length > 0 && (
                            <Button
                              size="compact-sm"
                              variant="default"
                              className={`${styles['action-btn']} ${styles['export-btn']}`}
                              onClick={() => handleExport(result)}
                            >
                              {t('database.query.export')}
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Result table */}
                      {result.rows && result.rows.length > 0 ? (
                        <Table
                          className={styles['result-table']}
                          style={{ maxHeight: 400, display: 'block', overflow: 'auto' }}
                        >
                          <Table.Thead>
                            <Table.Tr>
                              {displayColumnsForResult(result).map((col) => (
                                <Table.Th key={col} style={{ minWidth: 120 }}>
                                  {col}
                                </Table.Th>
                              ))}
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {result.rows.map((row, rIdx) => (
                              <Table.Tr key={rIdx}>
                                {displayColumnsForResult(result).map((col) => {
                                  const text = formatCellValue(row[col])
                                  return (
                                    <Table.Td key={col} style={{ minWidth: 120 }}>
                                      <Tooltip label={text} multiline maw={400} withArrow openDelay={300}>
                                        <span className={styles['cell-value']}>{text}</span>
                                      </Tooltip>
                                    </Table.Td>
                                  )
                                })}
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      ) : (
                        /* Empty result hint */
                        <div className={styles['empty-result']}>
                          <span>{t('database.query.noResult')}</span>
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              </Tabs.Panel>
            ))}
          </Tabs>
        </div>
      ) : (
        /* Bottom hint when there are no results */
        <div className={styles['query-hint']}>
          {t('database.query.noQueries')} · {t('database.query.shortcutHint')}
        </div>
      )}
    </div>
  )
}
