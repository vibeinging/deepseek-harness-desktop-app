import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader, Select } from '@mantine/core'
import type { ComboboxItem } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { useProjectStore, projectGetters } from '@/store/project'
import { getCachedTablesReq, getTableColumnsReq } from '@/api/database'
import { getDataSourceTablesReq } from '@/api/structured_data_source/document'
import styles from './SingleTableColumnPicker.module.scss'

interface SingleTableColumnPickerProps {
  /** Selected table name */
  table?: string
  /** Selected column name */
  column?: string
  /** Data source ID (database connection ID or structured data source ID) */
  databaseId?: string | null
  /** Data source type: database | structured */
  sourceType?: string
  /** database_connection_id for structured sources; required for column lookup */
  databaseConnectionId?: string | null
  /** defineEmits('update:table') */
  onUpdateTable?: (val: string) => void
  /** defineEmits('update:column') */
  onUpdateColumn?: (val: string) => void
}

const DESC_MAX_LEN = 20
const truncate = (s: any) => {
  if (!s) return ''
  const str = String(s)
  return str.length > DESC_MAX_LEN ? str.slice(0, DESC_MAX_LEN) + '…' : str
}

export default function SingleTableColumnPicker(props: SingleTableColumnPickerProps) {
  const {
    table = '',
    column = '',
    databaseId = null,
    sourceType = 'database',
    databaseConnectionId = null,
    onUpdateTable,
    onUpdateColumn
  } = props

  const { t } = useTranslation()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  const [allTables, setAllTables] = useState<any[]>([])
  const [currentColumns, setCurrentColumns] = useState<any[]>([])
  const [loadingTables, setLoadingTables] = useState(false)
  const [loadingColumns, setLoadingColumns] = useState(false)

  // Mirror incoming props in local state, and sync back on change
  const [innerTable, setInnerTable] = useState<string>(table || '')
  const [innerColumn, setInnerColumn] = useState<string>(column || '')

  // Keep latest mutable values in refs so callbacks/effects read fresh data and avoid stale closures
  const allTablesRef = useRef<any[]>(allTables)
  allTablesRef.current = allTables
  const innerTableRef = useRef<string>(innerTable)
  innerTableRef.current = innerTable

  const loadColumns = async () => {
    setCurrentColumns([])
    if (!innerTableRef.current || !databaseId) return
    // Resolve table_id by matching table_name
    const matched = allTablesRef.current.find((tb) => tb.table_name === innerTableRef.current)
    const tableId = matched?.id
    if (!tableId) return
    setLoadingColumns(true)
    try {
      const connId = sourceType === 'structured' ? databaseConnectionId || databaseId : databaseId
      const res: any = await getTableColumnsReq(currentProjectId, connId, tableId)
      if (res?.success) {
        setCurrentColumns(res.data?.items || [])
      }
    } catch (e) {
      notifications.show({ color: 'red', message: t('business.singleTcPicker.loadColumnsFailed', '加载列列表失败') })
    } finally {
      setLoadingColumns(false)
    }
  }

  const loadTables = async () => {
    setAllTables([])
    allTablesRef.current = []
    if (!databaseId) return
    setLoadingTables(true)
    try {
      const res: any =
        sourceType === 'structured'
          ? await getDataSourceTablesReq(currentProjectId, databaseId)
          : await getCachedTablesReq(currentProjectId, databaseId)
      if (res?.success) {
        const items = res.data?.items || []
        setAllTables(items)
        allTablesRef.current = items
      }
    } catch (e) {
      notifications.show({ color: 'red', message: t('business.singleTcPicker.loadTablesFailed', '加载表列表失败') })
    } finally {
      setLoadingTables(false)
    }
  }

  const handleTableChange = (val: string | null) => {
    const next = val || ''
    setInnerTable(next)
    innerTableRef.current = next
    // Clear column when table changes
    setInnerColumn('')
    onUpdateTable?.(next)
    onUpdateColumn?.('')
    loadColumns()
  }

  const handleColumnChange = (val: string | null) => {
    const next = val || ''
    setInnerColumn(next)
    onUpdateColumn?.(next)
  }

  // Props-driven hydration for edit scenes (uses row.source_table / row.source_column)
  // watch(() => props.table)
  useEffect(() => {
    if (table !== innerTableRef.current) {
      const next = table || ''
      setInnerTable(next)
      innerTableRef.current = next
      // Reload columns when table changes
      if (table) loadColumns()
      else setCurrentColumns([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])

  // watch(() => props.column)
  useEffect(() => {
    if (column !== innerColumn) setInnerColumn(column || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column])

  // Switch data source: reset and reload tables immediately
  // watch(() => [props.databaseId, props.sourceType], { immediate: true })
  useEffect(() => {
    ;(async () => {
      await loadTables()
      // After tables load, load columns if a table is already selected
      if (innerTableRef.current) await loadColumns()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, sourceType])

  // Select uses data(value/label); keep table_name/column_name indexed for renderOption details
  // Mantine renderOption only returns { value, label }, so extra fields need a separate map
  const tableData = useMemo<ComboboxItem[]>(
    () => allTables.map((tb) => ({ value: tb.table_name, label: tb.table_name })),
    [allTables]
  )
  const tableMap = useMemo(() => {
    const map: Record<string, any> = {}
    allTables.forEach((tb) => {
      map[tb.table_name] = tb
    })
    return map
  }, [allTables])

  const columnData = useMemo<ComboboxItem[]>(
    () => currentColumns.map((col) => ({ value: col.column_name, label: col.column_name })),
    [currentColumns]
  )
  const columnMap = useMemo(() => {
    const map: Record<string, any> = {}
    currentColumns.forEach((col) => {
      map[col.column_name] = col
    })
    return map
  }, [currentColumns])

  return (
    <div className={styles.singleTcPicker}>
      <Select
        value={innerTable || null}
        placeholder={t('business.singleTcPicker.tablePlaceholder', '选择表')}
        searchable
        clearable
        comboboxProps={{ classNames: { dropdown: 'styled-select-popper' }, withinPortal: true }}
        disabled={!databaseId}
        className={styles.pickerSelect}
        data={tableData}
        rightSection={loadingTables ? <Loader size="xs" /> : undefined}
        onChange={handleTableChange}
        renderOption={({ option }) => {
          const tb = tableMap[option.value] || {}
          return (
            <div className={styles.optRow}>
              <span className={styles.optName}>{option.label}</span>
              {tb.description ? (
                <span className={styles.optDesc} title={tb.description}>
                  {truncate(tb.description)}
                </span>
              ) : null}
            </div>
          )
        }}
      />

      <Select
        value={innerColumn || null}
        placeholder={t('business.singleTcPicker.columnPlaceholder', '选择列')}
        searchable
        clearable
        comboboxProps={{ classNames: { dropdown: 'styled-select-popper' }, withinPortal: true }}
        disabled={!innerTable}
        className={styles.pickerSelect}
        data={columnData}
        rightSection={loadingColumns ? <Loader size="xs" /> : undefined}
        onChange={handleColumnChange}
        renderOption={({ option }) => {
          const col = columnMap[option.value] || {}
          return (
            <div className={styles.optRow}>
              <span className={styles.optName}>{option.label}</span>
              {col.data_type ? <span className={styles.optType}>{col.data_type}</span> : null}
              {col.description ? (
                <span className={styles.optDesc} title={col.description}>
                  {truncate(col.description)}
                </span>
              ) : null}
            </div>
          )
        }}
      />
    </div>
  )
}
