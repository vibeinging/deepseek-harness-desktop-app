import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Select,
  MultiSelect,
  TextInput,
  Badge,
  Tooltip,
  Pagination,
  Table,
  Modal,
  Center,
  Text,
  ActionIcon,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconSearch,
  IconEdit,
  IconStar,
  IconWand,
  IconCopy,
  IconArrowsMaximize,
  IconRefresh,
} from '@tabler/icons-react'
import {
  updateTableHighRecallReq,
  generateSingleTableDescriptionReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  syncTableExampleValuesReq,
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './TableStructureView.module.scss'

// Column data shape aligned to fields in source currentTable.columns.
interface ColumnItem {
  column_name: string
  data_type?: string
  is_high_recall?: boolean
  description?: string
  example_values?: any[]
  [key: string]: any
}

// Table data shape aligned to fields in source props.tables / currentTable.
interface TableItem {
  id: string
  table_name: string
  schema_name?: string
  description?: string
  is_high_recall?: boolean
  database_connection_id?: string
  columns?: ColumnItem[]
  [key: string]: any
}

export interface TableStructureViewProps {
  databaseId: string
  tables?: TableItem[]
  totalTables?: number
  currentTable?: TableItem | null
  isFromGuide?: boolean
  // defineEmits(['table-change', 'refresh', 'open-edit-dialog', 'load-columns']) -> callback props
  onTableChange?: (table: TableItem) => void
  onRefresh?: () => void
  onOpenEditDialog?: (table: TableItem) => void
  onLoadColumns?: (tableId?: any) => void | Promise<void>
  onOpenRetrievalTest?: (table?: any) => void
}

export default function TableStructureView({
  databaseId,
  tables = [],
  totalTables = 0,
  currentTable = null,
  isFromGuide: _isFromGuide = false,
  onTableChange,
  onRefresh,
  onOpenEditDialog,
  onLoadColumns: _onLoadColumns,
}: TableStructureViewProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // Loading state.
  const [togglingHighRecall, setTogglingHighRecall] = useState(false)
  const [generatingDescriptions, setGeneratingDescriptions] = useState(false)
  const [syncingExampleValues, setSyncingExampleValues] = useState(false)
  const [regeneratingVectors, setRegeneratingVectors] = useState(false)
  const [generateDescBtnState, setGenerateDescBtnState] = useState<
    'idle' | 'generatingDesc' | 'generatingVector'
  >('idle') // 'idle' | 'generatingDesc' | 'generatingVector'

  const generateDescButtonText = useMemo(() => {
    const map: Record<string, string> = {
      idle: 'database.tableStructure.aiGenerateBtn',
      generatingDesc: 'database.tableStructure.generatingDesc',
      generatingVector: 'database.tableStructure.generatingVector',
    }
    return t(map[generateDescBtnState] || map.idle)
  }, [generateDescBtnState, t])

  // Schema filter.
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>([])

  // Table search and pagination.
  const [tableSearchKeyword, setTableSearchKeyword] = useState('')
  const [tableCurrentPage, setTableCurrentPage] = useState(1)
  const tablePageSize = 15

  // Column search and pagination.
  const [columnSearchKeyword, setColumnSearchKeyword] = useState('')
  const [columnCurrentPage, setColumnCurrentPage] = useState(1)
  const [columnPageSize, setColumnPageSize] = useState(20)

  // Fullscreen dialog state.
  const [fullscreenDialogVisible, setFullscreenDialogVisible] = useState(false)
  const [fullscreenSearchKeyword, setFullscreenSearchKeyword] = useState('')
  const [fullscreenCurrentPage, setFullscreenCurrentPage] = useState(1)
  const [fullscreenPageSize, setFullscreenPageSize] = useState(50)

  // Available schema list.
  const availableSchemas = useMemo(() => {
    const schemas = new Set<string>()
    tables.forEach((table) => {
      const schema = table.schema_name || 'default'
      schemas.add(schema)
    })
    return Array.from(schemas).sort()
  }, [tables])

  // Table filtering and pagination.
  const filteredTables = useMemo(() => {
    let result = tables

    // Schema filtering.
    if (selectedSchemas.length > 0) {
      result = result.filter((tb) => {
        const schema = tb.schema_name || 'default'
        return selectedSchemas.includes(schema)
      })
    }

    // Search by table name and description.
    if (tableSearchKeyword.trim()) {
      const keyword = tableSearchKeyword.toLowerCase().trim()
      result = result.filter(
        (tb) =>
          tb.table_name.toLowerCase().includes(keyword) ||
          (tb.description && tb.description.toLowerCase().includes(keyword)) ||
          (tb.schema_name && tb.schema_name.toLowerCase().includes(keyword))
      )
    }

    return result
  }, [tables, selectedSchemas, tableSearchKeyword])

  const paginatedTables = useMemo(() => {
    const start = (tableCurrentPage - 1) * tablePageSize
    const end = start + tablePageSize
    return filteredTables.slice(start, end)
  }, [filteredTables, tableCurrentPage])

  const totalTablePages = useMemo(() => {
    return Math.ceil(filteredTables.length / tablePageSize)
  }, [filteredTables])

  // Column filtering and pagination.
  const filteredColumns = useMemo(() => {
    if (!currentTable?.columns || !Array.isArray(currentTable.columns)) return []
    if (!columnSearchKeyword.trim()) {
      return currentTable.columns
    }
    const keyword = columnSearchKeyword.toLowerCase().trim()
    return currentTable.columns.filter(
      (col) =>
        col.column_name.toLowerCase().includes(keyword) ||
        (col.description && col.description.toLowerCase().includes(keyword))
    )
  }, [currentTable, columnSearchKeyword])

  const paginatedColumns = useMemo(() => {
    const start = (columnCurrentPage - 1) * columnPageSize
    const end = start + columnPageSize
    return filteredColumns.slice(start, end)
  }, [filteredColumns, columnCurrentPage, columnPageSize])

  const totalColumnPages = useMemo(() => {
    return Math.ceil(filteredColumns.length / columnPageSize)
  }, [filteredColumns, columnPageSize])

  // Fullscreen dialog: filtered columns.
  const fullscreenFilteredColumns = useMemo(() => {
    if (!currentTable?.columns) return []
    if (!fullscreenSearchKeyword.trim()) {
      return currentTable.columns
    }
    const keyword = fullscreenSearchKeyword.toLowerCase().trim()
    return currentTable.columns.filter(
      (col) =>
        col.column_name.toLowerCase().includes(keyword) ||
        (col.description && col.description.toLowerCase().includes(keyword))
    )
  }, [currentTable, fullscreenSearchKeyword])

  // Fullscreen dialog: paginated columns (keep default sort by column_name ascending).
  const fullscreenPaginatedColumns = useMemo(() => {
    const sorted = [...fullscreenFilteredColumns].sort((a, b) =>
      String(a.column_name).localeCompare(String(b.column_name))
    )
    const start = (fullscreenCurrentPage - 1) * fullscreenPageSize
    const end = start + fullscreenPageSize
    return sorted.slice(start, end)
  }, [fullscreenFilteredColumns, fullscreenCurrentPage, fullscreenPageSize])

  // Wrap modals.openConfirmModal in a Promise and keep the original try/catch flow.
  const confirmAsync = (options: {
    title: string
    message: string
    confirmLabel: string
    cancelLabel: string
    color?: string
  }): Promise<'confirm'> =>
    new Promise((resolve, reject) => {
      modals.openConfirmModal({
        title: options.title,
        children: options.message,
        labels: { confirm: options.confirmLabel, cancel: options.cancelLabel },
        confirmProps: options.color ? { color: options.color } : undefined,
        onConfirm: () => resolve('confirm'),
        onCancel: () => reject('cancel'),
      })
    })

  // Handle schema filter changes.
  const handleSchemaFilterChange = (vals: string[]) => {
    setSelectedSchemas(vals)
    setTableCurrentPage(1)
    // Clear current selection if it is not in the filtered list.
    // Recompute filtered list using the new vals to avoid stale async state.
    let result = tables
    if (vals.length > 0) {
      result = result.filter((tb) => {
        const schema = tb.schema_name || 'default'
        return vals.includes(schema)
      })
    }
    if (tableSearchKeyword.trim()) {
      const keyword = tableSearchKeyword.toLowerCase().trim()
      result = result.filter(
        (tb) =>
          tb.table_name.toLowerCase().includes(keyword) ||
          (tb.description && tb.description.toLowerCase().includes(keyword)) ||
          (tb.schema_name && tb.schema_name.toLowerCase().includes(keyword))
      )
    }
    if (currentTable && result.length > 0) {
      const found = result.find((tb) => tb.id === currentTable.id)
      if (!found) {
        // Select the first table from the filtered list.
        onTableChange?.(result[0])
      }
    }
  }

  // Handle search input updates.
  const handleTableSearch = (val: string) => {
    setTableSearchKeyword(val)
    setTableCurrentPage(1)
  }

  const handleColumnSearch = (val: string) => {
    setColumnSearchKeyword(val)
    setColumnCurrentPage(1)
  }

  const handleColumnSizeChange = (size: number) => {
    setColumnPageSize(size)
    setColumnCurrentPage(1)
  }

  // Fullscreen dialog handlers.
  const handleOpenFullscreenDialog = () => {
    setFullscreenSearchKeyword('')
    setFullscreenCurrentPage(1)
    setFullscreenDialogVisible(true)
  }

  const handleFullscreenSearch = (val: string) => {
    setFullscreenSearchKeyword(val)
    setFullscreenCurrentPage(1)
  }

  const handleFullscreenSizeChange = (size: number) => {
    setFullscreenPageSize(size)
    setFullscreenCurrentPage(1)
  }

  const handleFullscreenPageChange = (page: number) => {
    setFullscreenCurrentPage(page)
  }

  // Table selection.
  const handleTableClick = (table: TableItem) => {
    if (currentTable?.id === table.id) return
    onTableChange?.(table)
  }

  // Reset column pagination when selected table changes.
  // watch(() => props.currentTable?.id, ...)
  useEffect(() => {
    setColumnCurrentPage(1)
    setColumnSearchKeyword('')
  }, [currentTable?.id])

  // Reset table pagination and schema filters when table list changes.
  // watch(() => props.tables, ...) is skipped on first render (using ref guard to match Vue watch default non-immediate behavior).
  const tablesFirstRender = useRef(true)
  useEffect(() => {
    if (tablesFirstRender.current) {
      tablesFirstRender.current = false
      return
    }
    setTableCurrentPage(1)
    setTableSearchKeyword('')
    // Reset schema filters so all tables are visible when table list changes.
    setSelectedSchemas([])
  }, [tables])

  // Edit a single table.
  const handleEditSingleTable = (table: TableItem) => {
    onOpenEditDialog?.(table)
  }

  // Resolve connectionId for a table (prefer table.database_connection_id, fallback to props.databaseId).
  const getTableConnectionId = (table?: TableItem | null) => {
    return table?.database_connection_id || databaseId
  }

  // Toggle high-recall status.
  const handleToggleHighRecall = async (table: TableItem) => {
    if (!table) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.pleaseSelectTable') })
      return
    }

    const connectionId = getTableConnectionId(table)
    if (!connectionId) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.cannotGetConnId') })
      return
    }

    try {
      const newStatus = !table.is_high_recall
      const actionText = newStatus
        ? t('database.tableStructure.setHighRecall')
        : t('database.tableStructure.unsetHighRecall')

      await confirmAsync({
        title: t('database.tableStructure.confirmAction'),
        message: t('database.tableStructure.highRecallConfirm', {
          action: actionText,
          table: table.table_name,
        }),
        confirmLabel: t('database.action.confirm'),
        cancelLabel: t('database.action.cancel'),
        color: newStatus ? 'blue' : 'orange',
      })

      setTogglingHighRecall(true)

      const res: any = await updateTableHighRecallReq(
        currentProjectId,
        connectionId,
        table.id,
        newStatus
      )

      if (res.success) {
        notifications.show({
          color: 'green',
          message: t('database.tableStructure.actionSuccess', { action: actionText }),
        })
        onRefresh?.()
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.tableStructure.actionFailed', { action: actionText }),
        })
      }
    } catch (error: any) {
      if (error !== 'cancel') {
        console.error('切换高召回状态失败:', error)
        notifications.show({ color: 'red', message: t('database.tableStructure.operationFailed') })
      }
    } finally {
      setTogglingHighRecall(false)
    }
  }

  // Generate AI description for one table (column and table description).
  const handleGenerateTableDescriptions = async (table: TableItem) => {
    if (!table) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.pleaseSelectTable') })
      return
    }

    const connectionId = getTableConnectionId(table)
    if (!connectionId) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.cannotGetConnId') })
      return
    }

    try {
      await confirmAsync({
        title: t('database.tableStructure.confirmGenerateVector'),
        message: t('database.tableStructure.generateDescConfirm', { table: table.table_name }),
        confirmLabel: t('database.tableStructure.confirmGenerate'),
        cancelLabel: t('database.action.cancel'),
        color: 'blue',
      })

      setGeneratingDescriptions(true)
      setGenerateDescBtnState('generatingDesc')

      // 1. Call single-table description API (column + table description).
      const descRes: any = await generateSingleTableDescriptionReq(
        currentProjectId,
        connectionId,
        table.id,
        2 // limit_examples: fetch 2 sample values per column
      )

      if (!descRes.success || !descRes.data) {
        notifications.show({
          color: 'red',
          message: descRes.msg || t('database.tableStructure.generateDescFailed'),
        })
        return
      }

      const { columns_generated, table_description_generated } = descRes.data

      notifications.show({
        color: 'green',
        message: t('database.tableStructure.generateDescSuccess', {
          columns: columns_generated,
          tableUpdated: table_description_generated,
        }),
      })

      // 2. Generate or refresh vectors for this table in the vector index.
      try {
        setGenerateDescBtnState('generatingVector')
        // Table-level description vector.
        await storeSingleTableVectorReq(currentProjectId, connectionId, table.id)

        // Column-level description vector.
        await storeTableColumnsVectorReq(currentProjectId, connectionId, table.id)
      } catch (e) {
        console.error('生成表/列向量失败:', e)
        notifications.show({
          color: 'yellow',
          message: t('database.tableStructure.vectorPartialFailed'),
        })
      }

      // 3. Refresh frontend cache for table and columns (server cache cleanup happens on backend).
      onRefresh?.()
    } catch (error: any) {
      if (error !== 'cancel') {
        console.error('生成描述失败:', error)
        notifications.show({
          color: 'red',
          message:
            t('database.tableStructure.generateError') +
            (error?.message || t('database.tableStructure.unknownError')),
        })
      }
    } finally {
      setGenerateDescBtnState('idle')
      setGeneratingDescriptions(false)
    }
  }

  // Generate example values for a single table.
  const handleSyncExampleValues = async (table: TableItem) => {
    if (!table) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.pleaseSelectTable') })
      return
    }
    const connectionId = getTableConnectionId(table)
    if (!connectionId) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.cannotGetConnId') })
      return
    }
    try {
      setSyncingExampleValues(true)
      const res: any = await syncTableExampleValuesReq(currentProjectId, connectionId, table.id)
      if (res?.success !== true) {
        notifications.show({
          color: 'red',
          message: res?.msg || t('database.tableStructure.generateExampleFailed'),
        })
        return
      }
      notifications.show({
        color: 'green',
        message:
          res?.data?.message ||
          t('database.tableStructure.generateExampleSuccess', { table: table.table_name }),
      })
      onRefresh?.()
    } catch (error: any) {
      console.error('生成示例值失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('database.tableStructure.generateExampleFailed') +
          (error?.message || t('database.tableStructure.unknownError')),
      })
    } finally {
      setSyncingExampleValues(false)
    }
  }

  // Regenerate recall vectors.
  const handleRegenerateVectors = async (table: TableItem) => {
    if (!table) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.pleaseSelectTable') })
      return
    }
    const connectionId = getTableConnectionId(table)
    if (!connectionId) {
      notifications.show({ color: 'yellow', message: t('database.tableStructure.cannotGetConnId') })
      return
    }
    try {
      setRegeneratingVectors(true)
      await Promise.all([
        storeSingleTableVectorReq(currentProjectId, connectionId, table.id),
        storeTableColumnsVectorReq(currentProjectId, connectionId, table.id),
      ])
      notifications.show({
        color: 'green',
        message: t('database.tableStructure.regenerateVectorsSuccess'),
      })
    } catch (error) {
      console.error('重新生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('database.tableStructure.regenerateVectorsFailed'),
      })
    } finally {
      setRegeneratingVectors(false)
    }
  }

  // Utility helpers.
  // Backend stores column_metadata.example_values as JSON text array in PG, and some endpoints may return raw strings.
  // Normalize to array here to avoid .filter/.map errors that can crash the page.
  const toExampleArray = (values: any): any[] => {
    if (Array.isArray(values)) return values
    if (values === null || values === undefined || values === '') return []
    if (typeof values === 'string') {
      try {
        const parsed = JSON.parse(values)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        return [values]
      }
    }
    return [values]
  }

  const formatExampleValuesAsJson = (values: any) => {
    try {
      return JSON.stringify(toExampleArray(values), null, 2)
    } catch {
      return String(values)
    }
  }

  const formatExampleValuesPreview = (raw: any) => {
    const values = toExampleArray(raw)
    if (values.length === 0) return '[]'

    const validValues = values.filter((v) => v !== null && v !== undefined && v !== '')
    if (validValues.length === 0) return '[]'

    if (validValues.length === 1) {
      const strValue = String(validValues[0])
      return strValue.length <= 10 ? `[${strValue}]` : `[${strValue.substring(0, 10)}...]`
    }

    const preview = validValues.slice(0, 2).map((v) => {
      const strValue = String(v)
      return strValue.length > 6 ? strValue.substring(0, 6) + '...' : strValue
    })

    return validValues.length > 2 ? `[${preview.join(', ')}...]` : `[${preview.join(', ')}]`
  }

  const shouldShowTooltip = (raw: any) => {
    const values = toExampleArray(raw)
    return values.filter((v) => v !== null && v !== undefined && v !== '').length > 0
  }

  // Render example values cell (shared by list and fullscreen views).
  const renderExampleValuesCell = (col: ColumnItem) => {
    const exampleValues = toExampleArray(col.example_values)
    return (
    <div className={styles.exampleValues}>
      {exampleValues.length > 0 ? (
        <Tooltip
          color="dark"
          position="top"
          multiline
          label={
            <span style={{ whiteSpace: 'pre' }}>
              {formatExampleValuesAsJson(exampleValues)}
            </span>
          }
          disabled={!shouldShowTooltip(exampleValues)}
        >
          <span className={styles.jsonPreview}>
            {formatExampleValuesPreview(exampleValues)}
          </span>
        </Tooltip>
      ) : (
        <span className={styles.noExampleValues}>{t('database.tableStructure.none')}</span>
      )}
    </div>
    )
  }

  return (
    <div className={styles.tableStructureContainer}>
      {/* Left panel: table list */}
      <div className={styles.tableSelectPanel}>
        <div className={styles.panelHeader}>
          <span className={styles.tableCount}>
            {t('database.tableStructure.totalTables', { count: totalTables })}
          </span>
        </div>
        {/* Schema filter (visible only when multiple schemas exist) */}
        {availableSchemas.length > 1 && (
          <div className={styles.schemaFilterBox}>
            <MultiSelect
              // Mantine does not have direct collapse-tags/tooltip equivalents; all selected items are shown by default.
              data={availableSchemas.map((schema) => ({ value: schema, label: schema }))}
              clearable
              size="xs"
              placeholder={t('database.tableStructure.filterSchema')}
              value={selectedSchemas}
              onChange={(vals) => handleSchemaFilterChange(vals || [])}
            />
          </div>
        )}
        <div className={styles.searchBox}>
          <TextInput
            value={tableSearchKeyword}
            placeholder={t('database.tableStructure.searchTable')}
            leftSection={<IconSearch size={14} />}
            size="xs"
            onChange={(e) => handleTableSearch(e.currentTarget.value)}
          />
        </div>
        {filteredTables.length > 0 ? (
          <div className={styles.tableList}>
            {paginatedTables.map((table) => (
              <div
                key={table.id}
                className={`${styles.tableItem} ${
                  currentTable?.id === table.id ? styles.active : ''
                }`}
                onClick={() => handleTableClick(table)}
              >
                <div className={styles.tableNameRow}>
                  <span className={styles.tableName}>
                    {table.schema_name && table.schema_name !== 'default'
                      ? `${table.schema_name}.${table.table_name}`
                      : table.table_name}
                  </span>
                  {table.is_high_recall && (
                    <Badge color="yellow" size="sm">
                      {t('database.tableStructure.highRecall')}
                    </Badge>
                  )}
                </div>
                {table.description && (
                  <div className={styles.tableDesc} title={table.description}>
                    {table.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyHint}>
            <span>
              {tableSearchKeyword
                ? t('database.tableStructure.noMatchTable')
                : t('database.tableStructure.noTable')}
            </span>
          </div>
        )}
        {totalTablePages > 1 && (
          <div className={styles.paginationBox}>
            <Pagination
              size="sm"
              total={totalTablePages}
              value={tableCurrentPage}
              onChange={setTableCurrentPage}
            />
          </div>
        )}
      </div>

      {/* Right panel: column information */}
      <div className={styles.columnInfoPanel}>
        {currentTable ? (
          <>
            {/* Table action buttons */}
            <div className={styles.tableActionsBar}>
              <Button
                size="xs"
                leftSection={<IconEdit size={14} />}
                onClick={() => handleEditSingleTable(currentTable)}
              >
                {t('database.tableStructure.editTable')}
              </Button>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconStar size={14} />}
                loading={togglingHighRecall}
                onClick={() => handleToggleHighRecall(currentTable)}
              >
                {currentTable.is_high_recall
                  ? t('database.tableStructure.cancelHighRecall')
                  : t('database.tableStructure.markHighRecall')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                leftSection={<IconWand size={14} />}
                loading={generatingDescriptions}
                onClick={() => handleGenerateTableDescriptions(currentTable)}
              >
                {generateDescButtonText}
              </Button>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconCopy size={14} />}
                loading={syncingExampleValues}
                onClick={() => handleSyncExampleValues(currentTable)}
              >
                {t('database.tableStructure.getExampleValues')}
              </Button>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconRefresh size={14} />}
                loading={regeneratingVectors}
                onClick={() => handleRegenerateVectors(currentTable)}
              >
                {t('database.tableStructure.regenerateVectors')}
              </Button>
            </div>

            {/* Table description */}
            {currentTable.description && (
              <div className={styles.tableDescriptionBar}>
                <strong>{t('database.tableStructure.tableDesc')}</strong>
                <span className={styles.descText}>{currentTable.description}</span>
              </div>
            )}

            {/* Column search and statistics */}
            <div className={styles.columnHeader}>
              <div className={styles.columnSearch}>
                <TextInput
                  className={styles.columnSearchInput}
                  value={columnSearchKeyword}
                  placeholder={t('database.tableStructure.searchColumn')}
                  leftSection={<IconSearch size={14} />}
                  size="xs"
                  onChange={(e) => handleColumnSearch(e.currentTarget.value)}
                />
                <span className={styles.columnCount}>
                  {t('database.tableStructure.totalColumns', {
                    count: currentTable.columns?.length || 0,
                  })}
                </span>
                <Tooltip label={t('database.tableStructure.fullscreen')} position="top">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    className={styles.fullscreenBtn}
                    onClick={handleOpenFullscreenDialog}
                  >
                    <IconArrowsMaximize size={16} />
                  </ActionIcon>
                </Tooltip>
              </div>
            </div>

            {/* Column table */}
            <div className={styles.columnTableContainer}>
              <Table highlightOnHover stickyHeader style={{ width: '100%' }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('database.tableStructure.columnName')}</Table.Th>
                    <Table.Th style={{ width: 100, textAlign: 'center' }}>
                      {t('database.tableStructure.dataType')}
                    </Table.Th>
                    <Table.Th style={{ width: 80, textAlign: 'center' }}>
                      {t('database.tableStructure.highRecall')}
                    </Table.Th>
                    <Table.Th>{t('database.tableStructure.description')}</Table.Th>
                    <Table.Th style={{ width: 180, textAlign: 'center' }}>
                      {t('database.tableStructure.exampleValues')}
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {paginatedColumns.map((col, idx) => (
                    <Table.Tr key={`${col.column_name}-${idx}`}>
                      <Table.Td>{col.column_name}</Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>{col.data_type}</Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>
                        <Badge color={col.is_high_recall ? 'green' : 'gray'} size="sm">
                          {col.is_high_recall ? 'YES' : 'NO'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <span>{col.description || ''}</span>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>
                        {renderExampleValuesCell(col)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>

            {/* Pagination */}
            {totalColumnPages > 1 && (
              <div className={styles.columnPaginationBox}>
                <Pagination
                  total={totalColumnPages}
                  value={columnCurrentPage}
                  onChange={setColumnCurrentPage}
                />
                {/* Page sizes [10,20,50,100] controlled by Select */}
                <Select
                  ml="sm"
                  size="xs"
                  w={110}
                  data={[
                    { value: '10', label: `10 / page` },
                    { value: '20', label: `20 / page` },
                    { value: '50', label: `50 / page` },
                    { value: '100', label: `100 / page` },
                  ]}
                  value={String(columnPageSize)}
                  onChange={(v) => handleColumnSizeChange(Number(v))}
                />
              </div>
            )}
          </>
        ) : (
          <div className={styles.noTableSelected}>
            <Center>
              <Text c="dimmed">{t('database.tableStructure.selectTableHint')}</Text>
            </Center>
          </div>
        )}
      </div>

      {/* Fullscreen dialog for column details */}
      <Modal
        opened={fullscreenDialogVisible}
        onClose={() => setFullscreenDialogVisible(false)}
        fullScreen
        withCloseButton
        className={styles.columnFullscreenDialog}
        title={
          <div className={styles.fullscreenDialogHeader}>
            <span className={styles.dialogTitle}>
              {currentTable?.table_name || ''} - {t('database.tableStructure.columnInfo')}
            </span>
            <div className={styles.headerRight}>
              <TextInput
                value={fullscreenSearchKeyword}
                placeholder={t('database.tableStructure.searchColumnOrDesc')}
                leftSection={<IconSearch size={14} />}
                style={{ width: 280 }}
                onChange={(e) => handleFullscreenSearch(e.currentTarget.value)}
              />
              <span className={styles.columnCount}>
                {t('database.tableStructure.totalColumns', {
                  count: fullscreenFilteredColumns.length,
                })}
              </span>
            </div>
          </div>
        }
      >
        <div className={styles.fullscreenContent}>
          {/* Column table */}
          <div className={styles.fullscreenTableContainer}>
            <Table highlightOnHover stickyHeader style={{ width: '100%' }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('database.tableStructure.columnName')}</Table.Th>
                  <Table.Th style={{ width: 150, textAlign: 'center' }}>
                    {t('database.tableStructure.dataType')}
                  </Table.Th>
                  <Table.Th style={{ width: 100, textAlign: 'center' }}>
                    {t('database.tableStructure.highRecall')}
                  </Table.Th>
                  <Table.Th>{t('database.tableStructure.description')}</Table.Th>
                  <Table.Th>{t('database.tableStructure.exampleValues')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {fullscreenPaginatedColumns.map((col, idx) => (
                  <Table.Tr key={`${col.column_name}-${idx}`}>
                    <Table.Td>{col.column_name}</Table.Td>
                    <Table.Td style={{ textAlign: 'center' }}>{col.data_type}</Table.Td>
                    <Table.Td style={{ textAlign: 'center' }}>
                      <Badge color={col.is_high_recall ? 'green' : 'gray'} size="sm">
                        {col.is_high_recall ? 'YES' : 'NO'}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip
                        label={col.description || '-'}
                        position="top"
                        multiline
                        disabled={!col.description}
                      >
                        <span>{col.description || '-'}</span>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>{renderExampleValuesCell(col)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>

          {/* Pagination */}
          <div className={styles.fullscreenPagination}>
            <Pagination
              total={Math.ceil(fullscreenFilteredColumns.length / fullscreenPageSize)}
              value={fullscreenCurrentPage}
              onChange={handleFullscreenPageChange}
            />
            {/* page-sizes [20,50,100,200] */}
            <Select
              ml="sm"
              size="xs"
              w={120}
              data={[
                { value: '20', label: `20 / page` },
                { value: '50', label: `50 / page` },
                { value: '100', label: `100 / page` },
                { value: '200', label: `200 / page` },
              ]}
              value={String(fullscreenPageSize)}
              onChange={(v) => handleFullscreenSizeChange(Number(v))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
