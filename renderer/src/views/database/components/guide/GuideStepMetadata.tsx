import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { IconArrowLeft, IconArrowRight, IconWand, IconInfoCircleFilled, IconBox } from '@tabler/icons-react'
import ElSvgIcon from '@/components/ElSvgIcon'

import {
  getCachedTablesReq,
  generateDatabaseDescriptionReq,
  getTableColumnsReq,
  getDatabaseDetailReq,
  updateDatabaseReq,
  generateColumnsDescriptionsReq,
  getSyncPendingReq,
  clearSyncPendingReq,
  storeTableVectorsReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'

// These two subcomponents are still migration stubs and keep any typing to preserve expected callback contracts (matching Vue emits).
import TableStructureViewRaw from '../TableStructureView'
import TableEditDialogRaw from '../TableEditDialog'

const TableStructureView = TableStructureViewRaw as React.ComponentType<any>
const TableEditDialog = TableEditDialogRaw as React.ComponentType<any>

import styles from './GuideStepMetadata.module.scss'

export interface GuideStepMetadataProps {
  projectId: string
  database?: any
  databaseId?: string | null
  isFirstStep?: boolean
  standalone?: boolean
  graphContent?: ReactNode
  initialBodyViewMode?: 'table' | 'er'
  // defineEmits(['step-completed', 'prev'])
  onStepCompleted?: () => void
  onPrev?: () => void
}

export default function GuideStepMetadata({
  database = null,
  databaseId = null,
  isFirstStep = false,
  standalone = false,
  graphContent = null,
  initialBodyViewMode = 'table',
  onStepCompleted,
  onPrev
}: GuideStepMetadataProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // ── Table data ─────────────────────────────────────────────
  const [tables, setTables] = useState<any[]>([])
  const [totalColumns, setTotalColumns] = useState(0)
  const [tablesWithDescription, setTablesWithDescription] = useState(0)
  const [columnsWithDescription, setColumnsWithDescription] = useState(0)
  const [databaseWithDescription, setDatabaseWithDescription] = useState(false)

  // Database description text (for inline editing)
  const [databaseDescription, setDatabaseDescription] = useState('')

  // Redis synced table info
  const [syncPendingInfo, setSyncPendingInfo] = useState<any>(null)

  // Current selected table and column
  const [currentTable, setCurrentTable] = useState<any>(null)
  const [bodyViewMode, setBodyViewMode] = useState<'table' | 'er'>(initialBodyViewMode)

  // Database description edit state
  const [dbDescFocused, setDbDescFocused] = useState(false)
  const [savingDbDesc, setSavingDbDesc] = useState(false)

  // Edit table dialog
  const [editDialogVisible, setEditDialogVisible] = useState(false)
  const [editingTable, setEditingTable] = useState<any>(null)

  // Generation state
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generatingTableDesc, setGeneratingTableDesc] = useState(false)
  const [generatingColumnDesc, setGeneratingColumnDesc] = useState(false)
  const [generatingDatabaseDesc, setGeneratingDatabaseDesc] = useState(false)

  // Vector generation state
  const [generatingTableVectors, setGeneratingTableVectors] = useState(false)
  const [generatingColumnVectors, setGeneratingColumnVectors] = useState(false)
  const generatingVectors = generatingTableVectors || generatingColumnVectors
  const [apiTablesWithVectors, setApiTablesWithVectors] = useState(0)
  const [apiTablesWithColumnVectors, setApiTablesWithColumnVectors] = useState(0)
  const [genTableVectorCount, setGenTableVectorCount] = useState(0)
  const [genColumnVectorCount, setGenColumnVectorCount] = useState(0)
  const [genTableVectorTotal, setGenTableVectorTotal] = useState(0)
  const [genColumnVectorTotal, setGenColumnVectorTotal] = useState(0)

  // ── Ref mirror (aligned with Vue ref.value semantics for latest async reads/writes, avoiding stale closures) ──
  const tablesRef = useRef<any[]>(tables)
  const totalColumnsRef = useRef(totalColumns)
  const columnsWithDescriptionRef = useRef(columnsWithDescription)
  const tablesWithDescriptionRef = useRef(tablesWithDescription)
  const syncPendingInfoRef = useRef<any>(syncPendingInfo)
  const currentTableRef = useRef<any>(currentTable)
  const generatingColumnDescRef = useRef(generatingColumnDesc)
  const generatingTableDescRef = useRef(generatingTableDesc)
  const databaseDescriptionRef = useRef(databaseDescription)
  const projectIdRef = useRef(currentProjectId)
  const databaseIdRef = useRef(databaseId)

  useEffect(() => {
    tablesRef.current = tables
  }, [tables])
  useEffect(() => {
    totalColumnsRef.current = totalColumns
  }, [totalColumns])
  useEffect(() => {
    columnsWithDescriptionRef.current = columnsWithDescription
  }, [columnsWithDescription])
  useEffect(() => {
    tablesWithDescriptionRef.current = tablesWithDescription
  }, [tablesWithDescription])
  useEffect(() => {
    syncPendingInfoRef.current = syncPendingInfo
  }, [syncPendingInfo])
  useEffect(() => {
    currentTableRef.current = currentTable
  }, [currentTable])
  useEffect(() => {
    setBodyViewMode(initialBodyViewMode)
  }, [databaseId, initialBodyViewMode])
  useEffect(() => {
    if (!graphContent && bodyViewMode === 'er') {
      setBodyViewMode('table')
    }
  }, [graphContent, bodyViewMode])
  useEffect(() => {
    generatingColumnDescRef.current = generatingColumnDesc
  }, [generatingColumnDesc])
  useEffect(() => {
    generatingTableDescRef.current = generatingTableDesc
  }, [generatingTableDesc])
  useEffect(() => {
    databaseDescriptionRef.current = databaseDescription
  }, [databaseDescription])
  useEffect(() => {
    projectIdRef.current = currentProjectId
  }, [currentProjectId])
  useEffect(() => {
    databaseIdRef.current = databaseId
  }, [databaseId])

  // ── Computed values ───────────────────────────────────────
  const tablesWithVectors = generatingTableVectors ? genTableVectorCount : apiTablesWithVectors
  const tablesWithColumnVectors = generatingColumnVectors ? genColumnVectorCount : apiTablesWithColumnVectors

  const vectorPendingTablesCount = useMemo(() => {
    if (generatingTableVectors && genTableVectorTotal > 0) return genTableVectorTotal
    if (generatingColumnVectors && genColumnVectorTotal > 0) return genColumnVectorTotal
    if (!syncPendingInfo) return tables.length
    if (syncPendingInfo.is_full_sync) return tables.length
    const tableKeys = syncPendingInfo.table_keys || []
    const tableIds = syncPendingInfo.table_ids || []
    const count = tableKeys.length > 0 ? tableKeys.length : tableIds.length
    return count > 0 ? count : tables.length
  }, [
    generatingTableVectors,
    genTableVectorTotal,
    generatingColumnVectors,
    genColumnVectorTotal,
    syncPendingInfo,
    tables
  ])

  const tableVectorCompleted = useMemo(() => {
    const target = vectorPendingTablesCount
    return tablesWithVectors >= target && target > 0
  }, [vectorPendingTablesCount, tablesWithVectors])

  const columnVectorCompleted = useMemo(() => {
    const target = vectorPendingTablesCount
    return tablesWithColumnVectors >= target && target > 0
  }, [vectorPendingTablesCount, tablesWithColumnVectors])

  const tableVectorProgressPercentage = useMemo(() => {
    const target = vectorPendingTablesCount
    if (target === 0) return 0
    return Math.min(100, Math.round((tablesWithVectors / target) * 100))
  }, [vectorPendingTablesCount, tablesWithVectors])

  const columnVectorProgressPercentage = useMemo(() => {
    const target = vectorPendingTablesCount
    if (target === 0) return 0
    return Math.min(100, Math.round((tablesWithColumnVectors / target) * 100))
  }, [vectorPendingTablesCount, tablesWithColumnVectors])

  const allVectorsCompleted = tableVectorCompleted && columnVectorCompleted

  // Whether any operation is running
  const isAnyOperationRunning =
    generatingAll || generatingColumnDesc || generatingTableDesc || generatingDatabaseDesc || generatingVectors

  // Computed pending table count
  const pendingTablesCount = useMemo(() => {
    if (!syncPendingInfo) return tables.length
    if (syncPendingInfo.is_full_sync) return tables.length
    const tableKeys = syncPendingInfo.table_keys || []
    const tableIds = syncPendingInfo.table_ids || []
    const count = tableKeys.length > 0 ? tableKeys.length : tableIds.length
    return count > 0 ? count : tables.length
  }, [syncPendingInfo, tables])

  // Computed pending column count
  const pendingColumnsCount = useMemo(() => {
    if (!syncPendingInfo) return totalColumns
    if (syncPendingInfo.is_full_sync) return totalColumns

    let cols = 0
    let hasMatchedTables = false

    if (syncPendingInfo.table_keys && syncPendingInfo.table_keys.length > 0) {
      for (const tableKey of syncPendingInfo.table_keys) {
        const table = tables.find((tb: any) => {
          const key = tb.schema_name ? `${tb.schema_name}.${tb.table_name}` : tb.table_name
          return key === tableKey
        })
        if (table && table.column_count !== undefined) {
          cols += table.column_count || 0
          hasMatchedTables = true
        }
      }
    } else if (syncPendingInfo.table_ids && syncPendingInfo.table_ids.length > 0) {
      for (const tableId of syncPendingInfo.table_ids) {
        const table = tables.find((tb: any) => tb.id === tableId)
        if (table && table.column_count !== undefined) {
          cols += table.column_count || 0
          hasMatchedTables = true
        }
      }
    }

    return hasMatchedTables ? cols : totalColumns
  }, [syncPendingInfo, tables, totalColumns])

  // Column description completion (depends only on its own data)
  const isColumnDescCompleted = useMemo(() => {
    if (generatingColumnDesc) return false
    const targetCount = pendingColumnsCount
    return columnsWithDescription === targetCount && targetCount > 0
  }, [generatingColumnDesc, pendingColumnsCount, columnsWithDescription])

  // Table description completion (depends only on its own data)
  const isTableDescCompleted = useMemo(() => {
    if (generatingTableDesc) return false
    const targetCount = pendingTablesCount
    return tablesWithDescription === targetCount && targetCount > 0
  }, [generatingTableDesc, pendingTablesCount, tablesWithDescription])

  // Database description completion
  const isDatabaseDescCompleted = databaseWithDescription

  // The main action also generates schema vectors, so they are part of completion.
  const isAllCompleted =
    isColumnDescCompleted && isTableDescCompleted && isDatabaseDescCompleted && allVectorsCompleted

  // ── Load Redis synced table info ───────────────────────────
  const loadSyncPendingInfo = useCallback(async () => {
    if (!databaseIdRef.current) return
    try {
      const res: any = await getSyncPendingReq(projectIdRef.current, databaseIdRef.current)
      if (res.success && res.data && res.data.pending !== false) {
        setSyncPendingInfo(res.data)
        syncPendingInfoRef.current = res.data
      } else {
        setSyncPendingInfo(null)
        syncPendingInfoRef.current = null
      }
    } catch (error) {
      console.error('加载 Redis 同步表信息失败:', error)
      setSyncPendingInfo(null)
      syncPendingInfoRef.current = null
    }
  }, [])

  // ── Load table data ───────────────────────────────────────
  // Declare first and share via ref for handleTableChange to avoid cross-dependency.
  const handleTableChangeRef = useRef<(table: any) => Promise<void>>(async () => {})

  const loadTables = useCallback(async () => {
    if (!databaseIdRef.current) return

    try {
      const res: any = await getCachedTablesReq(projectIdRef.current, databaseIdRef.current)
      if (res.success && res.data) {
        const tableList = res.data.items || res.data || []
        setTables(tableList)
        tablesRef.current = tableList

        const sync = syncPendingInfoRef.current

        // Load pending table list
        let tablesToCount = tableList
        if (sync && !sync.is_full_sync) {
          if (sync.table_keys && sync.table_keys.length > 0) {
            tablesToCount = tableList.filter((table: any) => {
              const tableKey = table.schema_name ? `${table.schema_name}.${table.table_name}` : table.table_name
              return sync.table_keys.includes(tableKey)
            })
          } else if (sync.table_ids && sync.table_ids.length > 0) {
            tablesToCount = tableList.filter((table: any) => sync.table_ids.includes(table.id))
          }
        }

        // Calculate description and vector completion.
        let totalCols = 0
        let tablesWithDesc = 0
        let colsWithDesc = 0
        let tablesWithVec = 0
        let tablesWithColVec = 0

        for (const table of tablesToCount) {
          if (table.description && table.description.trim()) tablesWithDesc++
          if (table.column_count !== undefined) totalCols += table.column_count || 0
          if (table.columns_with_description !== undefined) colsWithDesc += table.columns_with_description || 0
          if (table.has_embedding) tablesWithVec++
          if (
            table.columns_with_vectors !== undefined &&
            table.column_count !== undefined &&
            Number(table.columns_with_vectors || 0) >= Number(table.column_count || 0)
          ) {
            tablesWithColVec++
          }
        }

        setApiTablesWithVectors(tablesWithVec)
        setApiTablesWithColumnVectors(tablesWithColVec)

        setTotalColumns(totalCols)
        totalColumnsRef.current = totalCols

        if (!generatingColumnDescRef.current) {
          setColumnsWithDescription(colsWithDesc)
          columnsWithDescriptionRef.current = colsWithDesc
        }

        if (!generatingTableDescRef.current) {
          setTablesWithDescription(tablesWithDesc)
          tablesWithDescriptionRef.current = tablesWithDesc
        }

        // Check database description
        try {
          const dbRes: any = await getDatabaseDetailReq(projectIdRef.current, databaseIdRef.current)
          if (dbRes.success && dbRes.data) {
            setDatabaseWithDescription(!!(dbRes.data.description && dbRes.data.description.trim()))
            const desc = dbRes.data.description || ''
            setDatabaseDescription(desc)
            databaseDescriptionRef.current = desc
          }
        } catch (error) {
          console.error('获取数据库详情失败:', error)
        }

        // Sync latest data for current table, or auto-select first table
        const cur = currentTableRef.current
        if (cur) {
          const updated = tableList.find((tb: any) => tb.id === cur.id)
          if (updated) {
            // Keep previously loaded column data
            const merged = { ...updated, columns: cur.columns }
            setCurrentTable(merged)
            currentTableRef.current = merged
          }
        } else if (tableList.length > 0) {
          await handleTableChangeRef.current(tableList[0])
        }
      }
    } catch (error) {
      console.error('加载表数据失败:', error)
    }
  }, [])

  // ── Save database description ─────────────────────────────
  const handleSaveDatabaseDescription = useCallback(async () => {
    if (!databaseIdRef.current || isAnyOperationRunningRef.current) return
    setSavingDbDesc(true)
    try {
      const res: any = await updateDatabaseReq(projectIdRef.current, {
        id: databaseIdRef.current,
        description: databaseDescriptionRef.current
      })
      if (res.success) {
        setDatabaseWithDescription(
          !!(databaseDescriptionRef.current && databaseDescriptionRef.current.trim())
        )
        notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescSaved') })
      } else {
        notifications.show({ color: 'red', message: res.msg || t('database.guide.metadata.dbDescSaveFailed') })
      }
    } catch (error) {
      console.error('保存数据库描述失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.metadata.dbDescSaveFailed') })
    } finally {
      setSavingDbDesc(false)
      setDbDescFocused(false)
    }
  }, [t])

  // ── Database description blur handling ─────────────────────
  const dbDescBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleDbDescBlur = useCallback(() => {
    // Delay close so save button mousedown can fire.
    if (dbDescBlurTimer.current) clearTimeout(dbDescBlurTimer.current)
    dbDescBlurTimer.current = setTimeout(() => {
      setDbDescFocused(false)
      dbDescBlurTimer.current = null
    }, 150)
  }, [])

  // ── Handle table switch ───────────────────────────────────
  const handleTableChange = useCallback(async (table: any) => {
    if (!table) return
    // Load columns first if they are not loaded.
    if (!table.columns || table.columns.length === 0) {
      try {
        const res: any = await getTableColumnsReq(projectIdRef.current, databaseIdRef.current, table.id)
        if (res.success && res.data) {
          table.columns = res.data.items || res.data || []
        }
      } catch (error) {
        console.error('加载列数据失败:', error)
      }
    }
    setCurrentTable(table)
    currentTableRef.current = table
  }, [])

  useEffect(() => {
    handleTableChangeRef.current = handleTableChange
  }, [handleTableChange])

  // ── Handle column loading triggered by TableStructureView ──
  const handleLoadColumns = useCallback(async (tableId: any) => {
    try {
      const res: any = await getTableColumnsReq(projectIdRef.current, databaseIdRef.current, tableId)
      if (res.success && res.data) {
        const table = tablesRef.current.find((tb: any) => tb.id === tableId)
        if (table) {
          table.columns = res.data.items || res.data || []
        }
      }
    } catch (error) {
      console.error('加载列数据失败:', error)
    }
  }, [])

  // ── Handle refresh triggered by TableStructureView ────────
  const handleRefreshFromStructure = useCallback(async () => {
    await loadTables()
    // Reload columns when current table exists.
    const cur = currentTableRef.current
    if (cur) {
      try {
        const res: any = await getTableColumnsReq(projectIdRef.current, databaseIdRef.current, cur.id)
        if (res.success && res.data) {
          const columns = res.data.items || res.data || []
          const tableInList = tablesRef.current.find((tb: any) => tb.id === cur.id)
          if (tableInList) {
            tableInList.columns = columns
            const merged = { ...tableInList, columns }
            setCurrentTable(merged)
            currentTableRef.current = merged
          }
        }
      } catch (error) {
        console.error('刷新列数据失败:', error)
      }
    }
  }, [loadTables])

  // ── Open edit table dialog ────────────────────────────────
  const handleOpenEditDialog = useCallback((table: any) => {
    setEditingTable(table)
    setEditDialogVisible(true)
  }, [])

  // ── Refresh after table edit save ─────────────────────────
  const handleAfterTableEditSaved = useCallback(async () => {
    await loadTables()
    if (currentTableRef.current) {
      await handleRefreshFromStructure()
    }
  }, [loadTables, handleRefreshFromStructure])

  // ── Helper: get pending table IDs ─────────────────────────
  const getPendingTableIds = useCallback(async () => {
    let tableIds: any[] | null = null
    try {
      const pendingRes: any = await getSyncPendingReq(projectIdRef.current, databaseIdRef.current)
      if (pendingRes.success && pendingRes.data) {
        const visiblePending = pendingRes.data.pending === false ? null : pendingRes.data
        setSyncPendingInfo(visiblePending)
        syncPendingInfoRef.current = visiblePending
        if (pendingRes.data.is_full_sync) {
          tableIds = tablesRef.current.map((table: any) => table.id)
        } else {
          if (pendingRes.data.table_keys && pendingRes.data.table_keys.length > 0) {
            const matchedTables = tablesRef.current.filter((table: any) => {
              const tableKey = table.schema_name ? `${table.schema_name}.${table.table_name}` : table.table_name
              return pendingRes.data.table_keys.includes(tableKey)
            })
            tableIds = matchedTables.map((table: any) => table.id)
          } else if (pendingRes.data.table_ids && pendingRes.data.table_ids.length > 0) {
            tableIds = pendingRes.data.table_ids
          }
        }
      }
    } catch (error) {
      console.warn('获取待处理表信息失败，使用全量处理:', error)
    }
    if (!tableIds || tableIds.length === 0) {
      tableIds = tablesRef.current.map((table: any) => table.id)
    }
    return tableIds
  }, [])

  // ── One-click generate all descriptions (main flow after confirmation) ─
  const runGenerateAll = useCallback(async () => {
    if (isAnyOperationRunningRef.current) return
    const failedSteps: string[] = []
    try {
      setGeneratingAll(true)
      const tableIds = await getPendingTableIds()

      // Step 1: batch generate column and table descriptions
      notifications.show({ color: 'blue', message: t('database.guide.metadata.step1Generating') })
      setGeneratingColumnDesc(true)
      generatingColumnDescRef.current = true
      setGeneratingTableDesc(true)
      generatingTableDescRef.current = true

      try {
        const res: any = await generateColumnsDescriptionsReq(
          projectIdRef.current,
          databaseIdRef.current,
          tableIds,
          2,
          false
        )

        if (res.success && res.data) {
          const { columns_generated = 0, tables_generated = 0, details = [], status } = res.data
          await loadTables()
          const failedTables = details
            .filter((r: any) => !r.success || r.error)
            .map((r: any) => r.table_name)
            .filter(Boolean)
            .join('、')
          if (status !== 'completed' || failedTables) {
            failedSteps.push(
              failedTables
                ? t('database.guide.metadata.failedDescriptionsForTables', { tables: failedTables })
                : t('database.guide.metadata.descriptionStepIncomplete')
            )
            notifications.show({
              color: 'yellow',
              message: t('database.guide.metadata.descGeneratedWithFailures', {
                columns: columns_generated,
                tables: tables_generated,
                failed: failedTables
              })
            })
          } else {
            notifications.show({
              color: 'green',
              message: t('database.guide.metadata.descGenerated', {
                columns: columns_generated,
                tables: tables_generated
              })
            })
          }
        } else {
          throw new Error(res.msg || t('database.guide.metadata.batchGenerateFailed'))
        }
      } catch (error: any) {
        failedSteps.push(t('database.guide.metadata.descriptionStepIncomplete'))
        console.error('批量生成列描述和表描述失败:', error)
        notifications.show({
          color: 'red',
          message:
            t('database.guide.metadata.generateError') +
            (error.message || t('database.guide.metadata.unknownError'))
        })
      } finally {
        setGeneratingColumnDesc(false)
        generatingColumnDescRef.current = false
        setGeneratingTableDesc(false)
        generatingTableDescRef.current = false
        await loadTables()
      }

      // Step 2: generate database description
      notifications.show({ color: 'blue', message: t('database.guide.metadata.step2Generating') })
      setGeneratingDatabaseDesc(true)

      try {
        const res: any = await generateDatabaseDescriptionReq(projectIdRef.current, databaseIdRef.current)
        if (res.success && res.data) {
          const desc = String(res.data.description || '').trim()
          if (!desc) throw new Error(t('database.guide.metadata.dbDescGenerateFailed'))
          setDatabaseWithDescription(true)
          setDatabaseDescription(desc)
          databaseDescriptionRef.current = desc
          notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescGenerateComplete') })
        } else {
          throw new Error(res.msg || t('database.guide.metadata.dbDescGenerateFailed'))
        }
      } catch (error: any) {
        failedSteps.push(t('database.guide.metadata.databaseDescriptionStepIncomplete'))
        console.error('生成数据库描述失败:', error)
        notifications.show({
          color: 'yellow',
          message: error.message || t('database.guide.metadata.dbDescGenerateFailed')
        })
      }

      setGeneratingDatabaseDesc(false)
      await loadTables()
      await loadSyncPendingInfo()

      // Step 3: generate table and column vectors in one real batch request.
      notifications.show({ color: 'blue', message: t('database.guide.metadata.step3GeneratingVectors') })
      setGenTableVectorCount(0)
      setGenColumnVectorCount(0)
      setGenTableVectorTotal(tableIds.length)
      setGenColumnVectorTotal(tableIds.length)
      setGeneratingTableVectors(true)
      setGeneratingColumnVectors(true)
      let tableVectorsCompleted = 0
      let columnVectorTablesCompleted = 0
      try {
        const vectorRes: any = await storeTableVectorsReq(
          projectIdRef.current,
          databaseIdRef.current,
          tableIds,
          false
        )
        if (!vectorRes.success || !vectorRes.data) {
          throw new Error(vectorRes.msg || t('database.guide.metadata.schemaVectorGenerateFailed'))
        }
        tableVectorsCompleted = Number(vectorRes.data.table_vectors_completed || 0)
        columnVectorTablesCompleted = Number(vectorRes.data.column_vector_tables_completed || 0)
        setGenTableVectorCount(tableVectorsCompleted)
        setGenColumnVectorCount(columnVectorTablesCompleted)
        if (vectorRes.data.status !== 'completed') {
          const failedTables = (vectorRes.data.failures || [])
            .map((failure: any) => failure.table_name)
            .filter(Boolean)
            .join('、')
          failedSteps.push(
            failedTables
              ? t('database.guide.metadata.failedVectorsForTables', { tables: failedTables })
              : t('database.guide.metadata.schemaVectorStepIncomplete')
          )
        }
      } catch (error: any) {
        failedSteps.push(t('database.guide.metadata.schemaVectorStepIncomplete'))
        console.error('批量生成 Schema 向量失败:', error)
        notifications.show({
          color: 'red',
          message: error.message || t('database.guide.metadata.schemaVectorGenerateFailed')
        })
      } finally {
        setGeneratingTableVectors(false)
        setGeneratingColumnVectors(false)
        await loadTables()
      }

      if (failedSteps.length === 0) {
        notifications.show({
          color: 'green',
          message: t('database.guide.metadata.allGenerateComplete', {
            tableVectors: tableVectorsCompleted,
            columnVectors: columnVectorTablesCompleted,
            total: tableIds.length
          })
        })
        try {
          await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
          await loadSyncPendingInfo()
        } catch (error) {
          console.warn('清除待处理表信息失败:', error)
        }
      } else {
        notifications.show({
          color: 'yellow',
          message: t('database.guide.metadata.allGeneratePartial', {
            failed: [...new Set(failedSteps)].join('；')
          })
        })
      }

      // Refresh selected table columns
      if (currentTableRef.current) {
        await handleRefreshFromStructure()
      }
    } catch (e) {
      console.error('一键生成流程失败:', e)
      notifications.show({ color: 'red', message: t('database.guide.metadata.generateProcessError') })
    } finally {
      resetAllGeneratingStates()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getPendingTableIds, loadTables, loadSyncPendingInfo, handleRefreshFromStructure, t])

  // ── One-click generate all descriptions (confirmation entrypoint) ─
  const handleGenerateAll = useCallback(() => {
    if (tablesRef.current.length === 0 || isAnyOperationRunningRef.current) {
      if (tablesRef.current.length > 0) return
      notifications.show({ color: 'yellow', message: t('database.guide.metadata.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('database.guide.metadata.confirmGenerate'),
      children: t('database.guide.metadata.generateAllConfirmMsg'),
      labels: {
        confirm: t('database.guide.metadata.confirmGenerateBtn'),
        cancel: t('common.cancel')
      },
      onConfirm: () => {
        void runGenerateAll()
      }
    })
  }, [runGenerateAll, t])

  // ── Batch generate column and table descriptions ───────────
  const handleBatchGenerateColumnDesc = useCallback(async () => {
    if (tablesRef.current.length === 0 || isAnyOperationRunningRef.current) return

    try {
      setGeneratingColumnDesc(true)
      generatingColumnDescRef.current = true
      setGeneratingTableDesc(true)
      generatingTableDescRef.current = true
      const tableIds = await getPendingTableIds()

      const res: any = await generateColumnsDescriptionsReq(
        projectIdRef.current,
        databaseIdRef.current,
        tableIds,
        2,
        false
      )

      if (res.success && res.data) {
        const { columns_generated, tables_generated, details } = res.data
        const failedTables = (details || [])
          .filter((r: any) => !r.success || r.error)
          .map((r: any) => r.table_name)
          .join('、')
        if (failedTables) {
          notifications.show({
            color: 'yellow',
            message: t('database.guide.metadata.descGeneratedWithFailures', {
              columns: columns_generated,
              tables: tables_generated,
              failed: failedTables
            })
          })
        } else {
          notifications.show({
            color: 'green',
            message: t('database.guide.metadata.descGenerated', {
              columns: columns_generated,
              tables: tables_generated
            })
          })
        }

        if (res.data.status === 'completed') {
          try {
            await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
            await loadSyncPendingInfo()
          } catch (error) {
            console.warn('清除待处理表信息失败:', error)
          }
        }
      } else {
        throw new Error(res.msg || t('database.guide.metadata.batchGenerateFailed'))
      }
    } catch (error: any) {
      console.error('批量生成列描述和表描述失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('database.guide.metadata.generateError') +
          (error.message || t('database.guide.metadata.unknownError'))
      })
    } finally {
      setGeneratingColumnDesc(false)
      generatingColumnDescRef.current = false
      setGeneratingTableDesc(false)
      generatingTableDescRef.current = false
      await loadTables()
      if (currentTableRef.current) {
        await handleRefreshFromStructure()
      }
    }
  }, [getPendingTableIds, loadTables, loadSyncPendingInfo, handleRefreshFromStructure, t])
  // Keep handleBatchGenerateColumnDesc logic (defined in this component but not directly called in template).
  void handleBatchGenerateColumnDesc

  // ── Generate database description ─────────────────────────
  const handleGenerateDatabaseDescription = useCallback(async () => {
    if (tablesRef.current.length === 0 || isAnyOperationRunningRef.current) {
      if (tablesRef.current.length > 0) return
      notifications.show({ color: 'yellow', message: t('database.guide.metadata.noTableData') })
      return
    }

    try {
      setGeneratingDatabaseDesc(true)
      const res: any = await generateDatabaseDescriptionReq(projectIdRef.current, databaseIdRef.current)
      if (res.success && res.data) {
        setDatabaseWithDescription(true)
        const desc = String(res.data.description || '').trim()
        if (!desc) throw new Error(t('database.guide.metadata.dbDescGenerateFailed'))
        setDatabaseDescription(desc)
        databaseDescriptionRef.current = desc
        notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescGenerateComplete') })
      } else {
        throw new Error(res.msg || t('database.guide.metadata.dbDescGenerateFailed'))
      }
    } catch (error: any) {
      console.error('生成数据库描述失败:', error)
      notifications.show({
        color: 'yellow',
        message: error.message || t('database.guide.metadata.dbDescGenerateFailed')
      })
    } finally {
      setGeneratingDatabaseDesc(false)
      await loadTables()
    }
  }, [loadTables, t])

  // ── Generate vectors (main flow after confirmation) ───────
  const runGenerateAllVectors = useCallback(
    async (tablesToProcess: any[]) => {
      if (isAnyOperationRunningRef.current) return
      try {
        setGenTableVectorCount(0)
        setGenColumnVectorCount(0)
        setGenTableVectorTotal(tablesToProcess.length)
        setGenColumnVectorTotal(tablesToProcess.length)
        setGeneratingTableVectors(true)
        setGeneratingColumnVectors(true)
        const res: any = await storeTableVectorsReq(
          projectIdRef.current,
          databaseIdRef.current,
          tablesToProcess.map((table: any) => table.id),
          false
        )
        if (!res.success || !res.data) {
          throw new Error(res.msg || t('database.guide.metadata.schemaVectorGenerateFailed'))
        }
        const tableCompleted = Number(res.data.table_vectors_completed || 0)
        const columnTableCompleted = Number(res.data.column_vector_tables_completed || 0)
        setGenTableVectorCount(tableCompleted)
        setGenColumnVectorCount(columnTableCompleted)
        if (res.data.status === 'completed') {
          notifications.show({
            color: 'green',
            message: t('database.guide.advanced.allVectorsComplete', {
              tableSuccess: tableCompleted,
              columnSuccess: columnTableCompleted,
              total: tablesToProcess.length
            })
          })
          try {
            await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
            await loadSyncPendingInfo()
          } catch (error) {
            console.warn('清除待处理表信息失败:', error)
          }
        } else {
          const failedTables = (res.data.failures || [])
            .map((failure: any) => failure.table_name)
            .filter(Boolean)
            .join('、')
          notifications.show({
            color: 'yellow',
            message: t('database.guide.metadata.vectorGeneratePartial', {
              failed: failedTables || t('database.guide.metadata.unknownError')
            })
          })
        }
      } catch (error: any) {
        console.error('生成 Schema 向量失败:', error)
        notifications.show({
          color: 'red',
          message: error.message || t('database.guide.metadata.schemaVectorGenerateFailed')
        })
      } finally {
        setGeneratingTableVectors(false)
        setGeneratingColumnVectors(false)
        await loadTables()
      }
    },
    [loadTables, loadSyncPendingInfo, t]
  )

  // ── Generate vectors (confirmation entrypoint) ─────────────
  const handleGenerateAllVectors = useCallback(async () => {
    if (tablesRef.current.length === 0 || isAnyOperationRunningRef.current) return
    const tableIds = await getPendingTableIds()
    const tablesToProcess = tablesRef.current.filter((tb: any) => tableIds.includes(tb.id))

    modals.openConfirmModal({
      title: t('database.guide.advanced.confirmGenerate'),
      children: t('database.guide.advanced.confirmGenerateAllVectors', { count: tablesToProcess.length }),
      labels: {
        confirm: t('database.guide.advanced.confirmGenerateBtn'),
        cancel: t('common.cancel')
      },
      onConfirm: () => {
        void runGenerateAllVectors(tablesToProcess)
      }
    })
  }, [getPendingTableIds, runGenerateAllVectors, t])

  // ── Previous / Next ───────────────────────────────────────
  const handlePrev = useCallback(() => {
    onPrev?.()
  }, [onPrev])

  const handleNext = useCallback(() => {
    onStepCompleted?.()
  }, [onStepCompleted])

  // ── Reset all generation states ───────────────────────────
  const resetAllGeneratingStates = useCallback(() => {
    setGeneratingAll(false)
    setGeneratingColumnDesc(false)
    generatingColumnDescRef.current = false
    setGeneratingTableDesc(false)
    generatingTableDescRef.current = false
    setGeneratingDatabaseDesc(false)
    setGeneratingTableVectors(false)
    setGeneratingColumnVectors(false)
  }, [])

  // isAnyOperationRunning ref mirror for async handlers.
  const isAnyOperationRunningRef = useRef(isAnyOperationRunning)
  useEffect(() => {
    isAnyOperationRunningRef.current = isAnyOperationRunning
  }, [isAnyOperationRunning])

  // ── Initialize (equivalent to onMounted) ───────────────────
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      resetAllGeneratingStates()
      await loadSyncPendingInfo()
      await loadTables()

      // Delay one refresh to ensure latest data.
      setTimeout(async () => {
        if (!cancelled) await loadTables()
      }, 800)
    }
    void init()

    // Reset state on unmount (equivalent to onBeforeUnmount)
    return () => {
      cancelled = true
      resetAllGeneratingStates()
      if (dbDescBlurTimer.current) clearTimeout(dbDescBlurTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Watch databaseId changes (skip first mount) ────────────
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (databaseId) {
      const onChange = async () => {
        resetAllGeneratingStates()
        setCurrentTable(null)
        currentTableRef.current = null
        await loadSyncPendingInfo()
        await loadTables()
      }
      void onChange()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  // ── Render ────────────────────────────────────────────────
  const tableKeysOrIdsLen = (() => {
    if (!syncPendingInfo) return 0
    return (syncPendingInfo.table_keys || syncPendingInfo.table_ids || []).length
  })()

  return (
    <div className={styles['guide-step-metadata']}>
      {/* Top overview section */}
      <div className={styles['overview-section']}>
        {/* Title row */}
        <div className={styles['overview-header']}>
          <div className={styles['title-block']}>
            {!standalone && <span className={styles['step-badge']}>Step 5</span>}
            <h2 className={styles['step-title']}>{t('database.guide.metadata.title')}</h2>
          </div>
          <div className={styles['header-right']}>
            {!standalone && (
              <div className={styles['skip-tip']}>
                <span className={styles['el-icon']}>
                  <IconInfoCircleFilled size={13} />
                </span>
                <span>{t('database.guide.metadata.skipTip')}</span>
              </div>
            )}
            <button
              className={[
                styles['generate-all-btn'],
                generatingAll ? styles.loading : '',
                isAllCompleted && !generatingAll ? styles.done : ''
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={tables.length === 0 || isAnyOperationRunning}
              onClick={handleGenerateAll}
              aria-busy={generatingAll}
            >
              <span className={styles['gen-btn-icon']}>
                {!generatingAll ? <IconWand size={18} /> : <span className={styles['spin-ring']}></span>}
              </span>
              <span className={styles['gen-btn-text']}>
                {generatingAll
                  ? t('database.guide.metadata.generatingAll')
                  : isAllCompleted
                  ? t('database.guide.metadata.regenerateAll')
                  : t('database.guide.metadata.generateAll')}
              </span>
            </button>
          </div>
        </div>

        {/* Content row: database description + progress cards + generate buttons */}
        <div className={styles['overview-body']}>
          {/* Database description */}
          <div className={[styles['db-desc-card'], dbDescFocused ? styles.focused : ''].filter(Boolean).join(' ')}>
            <div className={styles['card-label']}>
              <span className={styles['label-dot']}></span>
              {t('database.guide.metadata.dbDescription')}
            </div>
            <Textarea
              className={styles['desc-textarea']}
              value={databaseDescription}
              onChange={(e) => {
                setDatabaseDescription(e.currentTarget.value)
                databaseDescriptionRef.current = e.currentTarget.value
              }}
              autosize
              minRows={2}
              maxRows={4}
              disabled={isAnyOperationRunning}
              placeholder={t('database.guide.metadata.dbDescPlaceholder')}
              onFocus={() => setDbDescFocused(true)}
              onBlur={handleDbDescBlur}
            />
            <div className={styles['db-desc-bottom']}>
              <button
                className={[styles['ai-chip-btn'], generatingDatabaseDesc ? styles.loading : '']
                  .filter(Boolean)
                  .join(' ')}
                disabled={tables.length === 0 || isAnyOperationRunning}
              onClick={handleGenerateDatabaseDescription}
                aria-busy={generatingDatabaseDesc}
              >
                <span className={styles['ai-chip-icon']}>
                  {!generatingDatabaseDesc ? <IconWand size={13} /> : <span className={styles['spin-dot']}></span>}
                </span>
                <span>
                  {generatingDatabaseDesc
                    ? t('database.guide.metadata.generatingShort')
                    : t('database.guide.metadata.aiGenerate')}
                </span>
              </button>
              {(dbDescFocused || savingDbDesc) && (
                <button
                  className={styles['save-chip-btn']}
                  disabled={savingDbDesc || isAnyOperationRunning}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    handleSaveDatabaseDescription()
                  }}
                >
                  {savingDbDesc && <span className={styles['spin-dot-sm']}></span>}
                  <span>
                    {savingDbDesc ? t('database.guide.metadata.saving') : t('database.action.save')}
                  </span>
                </button>
              )}
            </div>
          </div>

        {/* Progress statistics */}
          <div className={styles['progress-cards']}>
            <div
              className={[
                styles['prog-card'],
                styles['prog-card-wide'],
                isColumnDescCompleted && isTableDescCompleted ? styles.done : '',
                generatingColumnDesc || generatingTableDesc ? styles.running : ''
              ]
                .filter(Boolean)
                .join(' ')}
              aria-live="polite"
              aria-busy={generatingColumnDesc || generatingTableDesc}
            >
              <div className={styles['prog-card-top']}>
                <span className={styles['prog-label']}>{t('database.guide.metadata.columnTableDesc')}</span>
                {(generatingColumnDesc || generatingTableDesc) && (
                  <span className={styles['prog-status-hint']}>
                    <span className={styles['spin-dot-xs']}></span>
                    <span>{t('database.guide.metadata.generatingShort')}</span>
                  </span>
                )}
              </div>
              <div className={styles['prog-dual-bars']}>
                <div className={styles['prog-bar-row']}>
                  <span className={styles['prog-bar-label']}>{t('database.guide.metadata.column')}</span>
                  <div
                    className={styles['prog-bar-track']}
                    role="progressbar"
                    aria-label={t('database.guide.metadata.columnDescriptionProgress')}
                    aria-valuemin={0}
                    aria-valuemax={pendingColumnsCount}
                    aria-valuenow={columnsWithDescription}
                  >
                    <div
                      className={styles['prog-bar-fill']}
                      style={{
                        width:
                          pendingColumnsCount > 0
                            ? (columnsWithDescription / pendingColumnsCount) * 100 + '%'
                            : '0%'
                      }}
                    ></div>
                  </div>
                  <span className={styles['prog-bar-num']}>
                    {columnsWithDescription}/{pendingColumnsCount}
                  </span>
                </div>
                <div className={styles['prog-bar-row']}>
                  <span className={styles['prog-bar-label']}>{t('database.guide.metadata.table')}</span>
                  <div
                    className={styles['prog-bar-track']}
                    role="progressbar"
                    aria-label={t('database.guide.metadata.tableDescriptionProgress')}
                    aria-valuemin={0}
                    aria-valuemax={pendingTablesCount}
                    aria-valuenow={tablesWithDescription}
                  >
                    <div
                      className={styles['prog-bar-fill']}
                      style={{
                        width:
                          pendingTablesCount > 0
                            ? (tablesWithDescription / pendingTablesCount) * 100 + '%'
                            : '0%'
                      }}
                    ></div>
                  </div>
                  <span className={styles['prog-bar-num']}>
                    {tablesWithDescription}/{pendingTablesCount}
                  </span>
                </div>
              </div>
            </div>

            <div
              className={[
                styles['prog-card'],
                isDatabaseDescCompleted ? styles.done : '',
                generatingDatabaseDesc ? styles.running : ''
              ]
                .filter(Boolean)
                .join(' ')}
              aria-live="polite"
              aria-busy={generatingDatabaseDesc}
            >
              <div className={styles['prog-card-top']}>
                <span className={styles['prog-label']}>{t('database.guide.metadata.dbDesc')}</span>
                {generatingDatabaseDesc && (
                  <span className={styles['prog-status-hint']}>
                    <span className={styles['spin-dot-xs']}></span>
                    <span>{t('database.guide.metadata.generatingShort')}</span>
                  </span>
                )}
              </div>
              <div
                className={styles['prog-bar-track']}
                role="progressbar"
                aria-label={t('database.guide.metadata.databaseDescriptionProgress')}
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={isDatabaseDescCompleted ? 1 : 0}
              >
                <div
                  className={styles['prog-bar-fill']}
                  style={{ width: isDatabaseDescCompleted ? '100%' : '0%' }}
                ></div>
              </div>
              <div className={styles['prog-count']}>
                {isDatabaseDescCompleted
                  ? t('database.guide.metadata.completed')
                  : t('database.guide.metadata.notGenerated')}
              </div>
            </div>

            {/* Vector progress card */}
            <div
              className={[
                styles['prog-card'],
                styles['prog-card-wide'],
                allVectorsCompleted ? styles.done : '',
                generatingVectors ? styles.running : ''
              ]
                .filter(Boolean)
                .join(' ')}
              aria-live="polite"
              aria-busy={generatingVectors}
            >
              <div className={styles['prog-card-top']}>
                <span className={styles['prog-label']}>{t('database.guide.advanced.schemaVectors')}</span>
                <button
                  className={[
                    styles['ai-chip-btn'],
                    styles['ai-chip-btn-sm'],
                    generatingVectors ? styles.loading : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={tables.length === 0 || isAnyOperationRunning}
                  onClick={handleGenerateAllVectors}
                  aria-busy={generatingVectors}
                >
                  <span className={styles['ai-chip-icon']}>
                    {!generatingVectors ? <IconBox size={11} /> : <span className={styles['spin-dot-xs']}></span>}
                  </span>
                  <span>
                    {generatingVectors
                      ? t('database.guide.advanced.generating')
                      : t('database.guide.advanced.generate')}
                  </span>
                </button>
              </div>
              {vectorPendingTablesCount > 0 && (
                <div className={styles['prog-dual-bars']}>
                  <div className={styles['prog-bar-row']}>
                    <span className={styles['prog-bar-label']}>
                      {t('database.guide.advanced.tableVectorShort')}
                    </span>
                    <div
                      className={styles['prog-bar-track']}
                      role="progressbar"
                      aria-label={t('database.guide.advanced.tableVectorProgress')}
                      aria-valuemin={0}
                      aria-valuemax={vectorPendingTablesCount}
                      aria-valuenow={tablesWithVectors}
                    >
                      <div
                        className={styles['prog-bar-fill']}
                        style={{ width: tableVectorProgressPercentage + '%' }}
                      ></div>
                    </div>
                    <span className={styles['prog-bar-num']}>
                      {tablesWithVectors}/{vectorPendingTablesCount}
                    </span>
                  </div>
                  <div className={styles['prog-bar-row']}>
                    <span className={styles['prog-bar-label']}>
                      {t('database.guide.advanced.columnVectorShort')}
                    </span>
                    <div
                      className={styles['prog-bar-track']}
                      role="progressbar"
                      aria-label={t('database.guide.advanced.columnVectorProgress')}
                      aria-valuemin={0}
                      aria-valuemax={vectorPendingTablesCount}
                      aria-valuenow={tablesWithColumnVectors}
                    >
                      <div
                        className={styles['prog-bar-fill']}
                        style={{ width: columnVectorProgressPercentage + '%' }}
                      ></div>
                    </div>
                    <span className={styles['prog-bar-num']}>
                      {tablesWithColumnVectors}/{vectorPendingTablesCount}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Redis synced table info */}
        {syncPendingInfo && (
          <div className={styles['sync-notice']}>
            <span className={styles['el-icon']}>
              <IconInfoCircleFilled size={12} />
            </span>
            <span>
              {syncPendingInfo.is_full_sync
                ? t('database.guide.metadata.fullSyncMode')
                : t('database.guide.metadata.tableSyncMode')}
              {tableKeysOrIdsLen > 0 && (
                <> · {t('database.guide.metadata.pendingTables', { count: tableKeysOrIdsLen })}</>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Main content: table list / ER relationship diagram */}
      <div className={styles['table-structure-section']}>
        {standalone && graphContent && (
          <div className={styles['body-view-switch']}>
            <div className={styles['view-switcher']}>
              <button
                className={`${styles['switcher-btn']} ${bodyViewMode === 'table' ? styles.active : ''}`}
                onClick={() => setBodyViewMode('table')}
              >
                <ElSvgIcon name="Grid" size={14} />
                <span>{t('project.database.tableView')}</span>
              </button>
              <button
                className={`${styles['switcher-btn']} ${bodyViewMode === 'er' ? styles.active : ''}`}
                onClick={() => setBodyViewMode('er')}
              >
                <ElSvgIcon name="Share" size={14} />
                <span>{t('project.database.erView')}</span>
              </button>
              <div
                className={`${styles['switcher-indicator']} ${
                  bodyViewMode === 'er' ? styles['at-er'] : ''
                }`}
              ></div>
            </div>
          </div>
        )}

        {bodyViewMode === 'table' && (
          <div className={styles['table-structure-wrapper']}>
            <TableStructureView
              databaseId={databaseId}
              tables={tables}
              totalTables={tables.length}
              currentTable={currentTable}
              isFromGuide={true}
              onTableChange={handleTableChange}
              onRefresh={handleRefreshFromStructure}
              onOpenEditDialog={handleOpenEditDialog}
              onLoadColumns={handleLoadColumns}
            />
          </div>
        )}

        {graphContent && bodyViewMode === 'er' && (
          <div className={styles['er-graph-wrapper']}>{graphContent}</div>
        )}
      </div>

      {/* Footer navigation (visible in wizard mode) */}
      {!standalone && (
        <div className={styles['step-footer']}>
          {!isFirstStep && (
            <button className={[styles['nav-btn'], styles['nav-btn-ghost']].join(' ')} onClick={handlePrev}>
              <span className={styles['el-icon']}>
                <IconArrowLeft size={14} />
              </span>
              {t('database.action.prev')}
            </button>
          )}
          <div className={styles['footer-spacer']}></div>
          <button
            className={[
              styles['nav-btn'],
              styles['nav-btn-primary'],
              isAnyOperationRunning ? styles.disabled : ''
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={isAnyOperationRunning}
            onClick={handleNext}
          >
            {t('database.guide.metadata.nextAdvanced')}
            <span className={styles['el-icon']}>
              <IconArrowRight size={14} />
            </span>
          </button>
        </div>
      )}

      {/* Edit table dialog */}
      <TableEditDialog
        opened={editDialogVisible}
        onClose={() => setEditDialogVisible(false)}
        table={editingTable}
        databaseId={databaseId}
        onSaved={handleAfterTableEditSaved}
      />
    </div>
  )
}
