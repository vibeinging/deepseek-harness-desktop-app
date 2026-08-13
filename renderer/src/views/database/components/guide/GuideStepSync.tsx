import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Select, Switch, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  syncDatabaseSchemaReq,
  syncDatabaseTablesReq,
  getSyncConfigReq,
  updateSyncConfigReq,
  triggerMetadataSyncReq,
  listSyncAuditsReq,
  getCachedTablesReq,
  getSourceTablesReq,
  batchSyncTableExampleValuesReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './GuideStepSync.module.scss'

interface GuideStepSyncProps {
  projectId: string
  database?: any
  databaseId?: string | null
  standalone?: boolean
  variant?: 'guide' | 'settings'
  // defineEmits(['step-completed', 'prev', 'sync-completed']) -> callback props
  onStepCompleted?: () => void
  onPrev?: () => void
  onSyncCompleted?: (result: any) => void
}

interface SyncResult {
  schemas: any[]
  tableCount: number
  columnCount: number
  changes: {
    new: number
    updated: number
    unchanged: number
  }
}

type SchedulePreset = 'default' | 'hourly' | 'daily' | 'weekly' | 'custom'

interface SyncAudit {
  id: string
  trigger_source?: 'manual' | 'cron'
  status?: 'ok' | 'error' | 'partial'
  tables_synced?: number
  columns_synced?: number
  duration_ms?: number
  error_msg?: string
  created_at?: string
}

// Build className strings (equivalent to Vue's :class array/object syntax)
function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

const weekdayKeys = ['weekSun', 'weekMon', 'weekTue', 'weekWed', 'weekThu', 'weekFri', 'weekSat']

function padHour(hour: number) {
  return String(Math.max(0, Math.min(23, hour))).padStart(2, '0')
}

function parseCronToPreset(cron: string | null | undefined): { preset: SchedulePreset; hour?: number; weekday?: number } {
  if (!cron) return { preset: 'default' }
  if (cron === '0 * * * *') return { preset: 'hourly' }
  let match = cron.match(/^0 (\d{1,2}) \* \* \*$/)
  if (match) return { preset: 'daily', hour: Number(match[1]) }
  match = cron.match(/^0 (\d{1,2}) \* \* (\d)$/)
  if (match) return { preset: 'weekly', hour: Number(match[1]), weekday: Number(match[2]) }
  return { preset: 'custom' }
}

function buildScheduleCron(preset: SchedulePreset, hour: number, weekday: number, customCron: string) {
  if (preset === 'default') return null
  if (preset === 'hourly') return '0 * * * *'
  if (preset === 'daily') return `0 ${hour} * * *`
  if (preset === 'weekly') return `0 ${hour} * * ${weekday}`
  return customCron.trim() || null
}

export default function GuideStepSync(props: GuideStepSyncProps) {
  const {
    projectId: propProjectId,
    database = null,
    databaseId = null,
    standalone = false,
    variant = 'guide',
    onStepCompleted,
    onPrev,
    onSyncCompleted
  } = props
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)
  const effectiveProjectId = currentProjectId || propProjectId
  const isSettingsVariant = variant === 'settings'

  // Sync scope selection
  const [syncScope, setSyncScope] = useState<'all' | 'schema'>('all')
  const [selectedSchemas, setSelectedSchemas] = useState<string[]>([])
  const [selectedTables, setSelectedTables] = useState<string[]>([])

  // Search keyword (tables only)
  const [tableSearchKeyword, setTableSearchKeyword] = useState('')

  // Source data
  const [sourceSchemas, setSourceSchemas] = useState<any[]>([])
  const [sourceTables, setSourceTables] = useState<any[]>([])
  const [loadingSchemas, setLoadingSchemas] = useState(false)
  const [loadingTables, setLoadingTables] = useState(false)

  // Process state
  const [syncing, setSyncing] = useState(false)
  const [syncCompleted, setSyncCompleted] = useState(false)
  const [syncStep, setSyncStep] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [syncingExamples, setSyncingExamples] = useState(false)
  const [, setExamplesSyncCompleted] = useState(false)

  // Sync result
  const [syncResult, setSyncResult] = useState<SyncResult>({
    schemas: [],
    tableCount: 0,
    columnCount: 0,
    changes: {
      new: 0,
      updated: 0,
      unchanged: 0
    }
  })

  // Check whether synced tables already exist
  const [hasSyncedTables, setHasSyncedTables] = useState(false)

  // Settings page: sync policy and audit records
  const [configLoading, setConfigLoading] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [autoSyncOn, setAutoSyncOn] = useState(false)
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('default')
  const [scheduleHour, setScheduleHour] = useState(3)
  const [scheduleWeekday, setScheduleWeekday] = useState(1)
  const [customCron, setCustomCron] = useState('')
  const [savedPolicySnapshot, setSavedPolicySnapshot] = useState('')
  const [serverPolicy, setServerPolicy] = useState({
    enabled: false,
    schedule_cron: null as string | null,
    sync_mode: 'registered_only'
  })
  const [audits, setAudits] = useState<SyncAudit[]>([])
  const [auditFilter, setAuditFilter] = useState<'all' | 'error'>('all')
  const [auditsLoading, setAuditsLoading] = useState(false)

  // Ref mirrors: in async flows we need to read latest reactive values immediately after writes.
  // Keep refs aligned with reactive state, matching Vue's ref.value semantics.
  const syncScopeRef = useRef(syncScope)
  const selectedSchemasRef = useRef(selectedSchemas)
  const selectedTablesRef = useRef(selectedTables)
  const sourceSchemasRef = useRef(sourceSchemas)
  const sourceTablesRef = useRef(sourceTables)
  const tableSearchKeywordRef = useRef(tableSearchKeyword)
  const syncingRef = useRef(syncing)
  const syncStepRef = useRef(syncStep)
  const syncCompletedRef = useRef(syncCompleted)
  const loadingSchemasRef = useRef(loadingSchemas)
  const loadingTablesRef = useRef(loadingTables)

  // Shared setters: update React state and refs together for immediate reads.
  const updateSyncScope = (v: 'all' | 'schema') => {
    syncScopeRef.current = v
    setSyncScope(v)
  }
  const updateSelectedSchemas = (v: string[]) => {
    selectedSchemasRef.current = v
    setSelectedSchemas(v)
  }
  const updateSelectedTables = (v: string[]) => {
    selectedTablesRef.current = v
    setSelectedTables(v)
  }
  const updateSourceSchemas = (v: any[]) => {
    sourceSchemasRef.current = v
    setSourceSchemas(v)
  }
  const updateSourceTables = (v: any[]) => {
    sourceTablesRef.current = v
    setSourceTables(v)
  }
  const updateSyncing = (v: boolean) => {
    syncingRef.current = v
    setSyncing(v)
  }
  const updateSyncStep = (v: number) => {
    syncStepRef.current = v
    setSyncStep(v)
  }
  const updateSyncCompleted = (v: boolean) => {
    syncCompletedRef.current = v
    setSyncCompleted(v)
  }
  const updateLoadingSchemas = (v: boolean) => {
    loadingSchemasRef.current = v
    setLoadingSchemas(v)
  }
  const updateLoadingTables = (v: boolean) => {
    loadingTablesRef.current = v
    setLoadingTables(v)
  }

  // Sync ref when search keyword changes
  const updateTableSearchKeyword = (v: string) => {
    tableSearchKeywordRef.current = v
    setTableSearchKeyword(v)
  }

  // Derived values

  // Whether multiple schemas are available (based on loaded data)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const hasMultipleSchemas = useMemo(() => sourceSchemas.length > 1, [sourceSchemas])

  // Filtered table list (computed)
  const computeFilteredTables = (
    tablesSrc: any[],
    schemas: string[],
    keyword: string
  ) => {
    let tables = tablesSrc

    // If schema is selected, only show tables in selected schemas.
    if (schemas.length > 0) {
      tables = tables.filter((tb) => schemas.includes(tb.schema_name || 'default'))
    }

    // Search filter
    if (keyword) {
      const kw = keyword.toLowerCase()
      tables = tables.filter((tb) => (tb.table_name || tb.name || '').toLowerCase().includes(kw))
    }

    return tables
  }

  const filteredTables = useMemo(
    () => computeFilteredTables(sourceTables, selectedSchemas, tableSearchKeyword),
    [sourceTables, selectedSchemas, tableSearchKeyword]
  )

  // Read filteredTables via refs for immediate async access.
  const getFilteredTables = () =>
    computeFilteredTables(sourceTablesRef.current, selectedSchemasRef.current, tableSearchKeywordRef.current)

  // Whether sync can start (computed)
  const canStartSync = useMemo(() => {
    if (syncScope === 'all') {
      return true
    }
    if (syncScope === 'schema') {
      // With schema data, at least one schema and one table must be selected.
      if (sourceSchemas.length > 0) {
        return selectedSchemas.length > 0 && selectedTables.length > 0
      } else {
        // Without schema data, at least one table must be selected.
        return selectedTables.length > 0
      }
    }
    return false
  }, [syncScope, sourceSchemas, selectedSchemas, selectedTables])

  // Synchronous getter for canStartSync in async flows.
  const getCanStartSync = () => {
    if (syncScopeRef.current === 'all') return true
    if (syncScopeRef.current === 'schema') {
      if (sourceSchemasRef.current.length > 0) {
        return selectedSchemasRef.current.length > 0 && selectedTablesRef.current.length > 0
      } else {
        return selectedTablesRef.current.length > 0
      }
    }
    return false
  }

  // Check whether the database already has synced tables.
  const checkSyncedTables = async () => {
    if (!databaseId) {
      setHasSyncedTables(false)
      return
    }

    try {
      const res: any = await getCachedTablesReq(effectiveProjectId, databaseId)
      if (res.success && res.data) {
        const tableList = res.data.items || res.data || []
        setHasSyncedTables(tableList.length > 0)
      } else {
        setHasSyncedTables(false)
      }
    } catch (error) {
      console.error('检查已同步表失败:', error)
      setHasSyncedTables(false)
    }
  }

  // Choose sync scope
  const selectScope = async (scope: 'all' | 'schema') => {
    updateSyncScope(scope)
    if (scope === 'all') {
      updateSelectedSchemas([])
      updateSelectedTables([])
      updateSourceSchemas([])
      updateSourceTables([])
    } else if (scope === 'schema') {
      updateSelectedTables([])
      updateSelectedSchemas([])
      // Try loading schema list first regardless of whether multiple schemas are supported.
      // For schema-capable databases we load schemas; for others we still try once in case data exists.
      await loadSchemas()
      // After schema load, when schema data exists and a default is selected, load its tables.
      if (sourceSchemasRef.current.length > 0) {
        // Ensure at least one schema is selected when schema data is available.
        if (selectedSchemasRef.current.length === 0 && sourceSchemasRef.current.length > 0) {
          updateSelectedSchemas([sourceSchemasRef.current[0].name])
        }
        if (selectedSchemasRef.current.length > 0) {
          await loadTables()
          // Auto-select all tables under selected schemas.
          const selectedSchemaNames = selectedSchemasRef.current
          const schemaTables = getFilteredTables().filter((table) => {
            const tableSchema = table.schema_name || 'default'
            return selectedSchemaNames.includes(tableSchema)
          })
          updateSelectedTables(
            schemaTables.map(
              (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
            )
          )
        }
      } else {
        // If no schema data exists, load all tables directly.
        updateSelectedSchemas([])
        await loadTables()
        // Auto-select all tables.
        updateSelectedTables(
          getFilteredTables().map(
            (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
          )
        )
      }
    }
  }

  // Toggle schema selection
  const toggleSchema = async (schemaName: string) => {
    const index = selectedSchemasRef.current.indexOf(schemaName)
    const wasSelected = index > -1

    if (wasSelected) {
      // Unselect schema
      const next = [...selectedSchemasRef.current]
      next.splice(index, 1)
      updateSelectedSchemas(next)
      // Remove all tables from this schema from current table selection.
      updateSelectedTables(
        selectedTablesRef.current.filter((tableId) => {
          const table = sourceTablesRef.current.find(
            (tb) => (tb.id || `${tb.schema_name || 'default'}.${tb.table_name || tb.name}`) === tableId
          )
          if (table) {
            const tableSchema = table.schema_name || 'default'
            return tableSchema !== schemaName
          }
          return true
        })
      )
    } else {
      // Select a schema
      updateSelectedSchemas([...selectedSchemasRef.current, schemaName])
    }

    // Refresh table list after schema selection changes
    if (syncScopeRef.current === 'schema') {
      // Reload table list
      await loadTables()

      // If a schema is selected, auto-select all tables under it.
      if (!wasSelected && selectedSchemasRef.current.includes(schemaName)) {
        const schemaTables = getFilteredTables().filter((table) => {
          const tableSchema = table.schema_name || 'default'
          return tableSchema === schemaName
        })

        const nextSelected = [...selectedTablesRef.current]
        schemaTables.forEach((table) => {
          const tableId = table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
          if (!nextSelected.includes(tableId)) {
            nextSelected.push(tableId)
          }
        })
        updateSelectedTables(nextSelected)
      }
    }
  }

  // Select or clear all schemas
  const toggleAllSchemas = async () => {
    const wasAllSelected = selectedSchemasRef.current.length === sourceSchemasRef.current.length

    if (wasAllSelected) {
      // Clear all schema selections
      updateSelectedSchemas([])
      // Clear all table selections
      updateSelectedTables([])
    } else {
      // Select all schemas
      updateSelectedSchemas(sourceSchemasRef.current.map((s) => s.name))
    }

    // Refresh table list
    await loadTables()

    // Auto-select all tables when all schemas are selected.
    if (!wasAllSelected && selectedSchemasRef.current.length === sourceSchemasRef.current.length) {
      updateSelectedTables(
        getFilteredTables().map(
          (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
        )
      )
    }
  }

  // Toggle table selection
  const toggleTable = (tableId: string) => {
    const index = selectedTablesRef.current.indexOf(tableId)
    if (index > -1) {
      const next = [...selectedTablesRef.current]
      next.splice(index, 1)
      updateSelectedTables(next)
    } else {
      updateSelectedTables([...selectedTablesRef.current, tableId])
    }
  }

  // Select or clear all tables
  const toggleAllTables = () => {
    if (selectedTablesRef.current.length === getFilteredTables().length) {
      updateSelectedTables([])
    } else {
      updateSelectedTables(
        getFilteredTables().map(
          (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
        )
      )
    }
  }

  const getSelectedTableNames = (): any[] =>
    selectedTablesRef.current
      .map((id) => {
        const table = sourceTablesRef.current.find(
          (tb) => (tb.id || `${tb.schema_name || 'default'}.${tb.table_name || tb.name}`) === id
        )
        if (!table) return null
        return {
          schema_name: table.schema_name || 'default',
          table_name: table.table_name || table.name
        }
      })
      .filter(Boolean)

  // Load schema list
  const loadSchemas = async (): Promise<void> => {
    if (!databaseId || loadingSchemasRef.current) {
      return Promise.resolve()
    }

    updateLoadingSchemas(true)
    try {
      const res: any = await getSourceTablesReq(effectiveProjectId, databaseId)
      if (res.success && res.data) {
        const tables = res.data.items || res.data || []
        const schemaMap = new Map<string, any>()
        tables.forEach((table: any) => {
          const schemaName = table.schema_name || 'default'
          if (!schemaMap.has(schemaName)) {
            schemaMap.set(schemaName, {
              name: schemaName,
              tableCount: 0
            })
          }
          schemaMap.get(schemaName).tableCount++
        })
        const schemas = Array.from(schemaMap.values()).sort((a, b) => a.name.localeCompare(b.name))

        // Show all schemas when there are multiple unique schemas.
        if (schemas.length > 1) {
          updateSourceSchemas(schemas)
          // In schema selection mode, default to the first schema.
          if (syncScopeRef.current === 'schema' && selectedSchemasRef.current.length === 0) {
            updateSelectedSchemas([sourceSchemasRef.current[0].name])
          }
        } else if (schemas.length === 1) {
          // If only one schema exists (default or custom), still show it.
          updateSourceSchemas(schemas)
          if (syncScopeRef.current === 'schema' && selectedSchemasRef.current.length === 0) {
            updateSelectedSchemas([sourceSchemasRef.current[0].name])
          }
        } else {
          // If no schema is returned, create a default 'default' entry.
          updateSourceSchemas([
            {
              name: 'default',
              tableCount: 0
            }
          ])
          if (syncScopeRef.current === 'schema' && selectedSchemasRef.current.length === 0) {
            updateSelectedSchemas(['default'])
          }
        }
      } else {
        updateSourceSchemas([])
      }
    } catch (error) {
      console.error('加载 Schema 列表失败:', error)
      notifications.show({ color: 'yellow', message: t('database.guide.sync.loadSchemaFailed') })
      updateSourceSchemas([])
    } finally {
      updateLoadingSchemas(false)
    }
  }

  // Load table list
  const loadTables = async () => {
    if (!databaseId || loadingTablesRef.current) return

      // In schema mode, do not load tables when schema data exists but nothing is selected.
    if (
      syncScopeRef.current === 'schema' &&
      sourceSchemasRef.current.length > 0 &&
      selectedSchemasRef.current.length === 0
    ) {
      updateSourceTables([])
      return
    }

    try {
      updateLoadingTables(true)

      // When schemas are selected, load tables for those schemas only.
      const params: any = {}
      if (selectedSchemasRef.current.length > 0) {
        // Pass schema_name when only one schema is selected.
        if (selectedSchemasRef.current.length === 1) {
          params.schema_name = selectedSchemasRef.current[0]
        }
      }
        // If no schema selected, omit schema_name and load all tables.

      const res: any = await getSourceTablesReq(effectiveProjectId, databaseId, params)
      if (res.success && res.data) {
        const tables = res.data.items || res.data || []

        let nextTables: any[]
      // Filter tables by selected schemas.
        if (selectedSchemasRef.current.length > 0) {
          nextTables = tables.filter((tb: any) =>
            selectedSchemasRef.current.includes(tb.schema_name || 'default')
          )
        } else {
          // If no schema is selected, show all tables.
          nextTables = tables
        }

        // Ensure each table has a unique ID.
        nextTables = nextTables.map((table: any) => ({
          ...table,
          id: table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`,
          name: table.table_name || table.name
        }))
        updateSourceTables(nextTables)
      } else {
        updateSourceTables([])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'yellow', message: t('database.guide.sync.loadTablesFailed') })
      updateSourceTables([])
    } finally {
      updateLoadingTables(false)
    }
  }

  // Start syncing
  const handleStartSync = async () => {
    if (!databaseId) {
      notifications.show({ color: 'yellow', message: t('database.guide.sync.missingDbId') })
      return
    }

    updateSyncing(true)
    updateSyncCompleted(false)
    updateSyncStep(1)
    setProgressText(t('database.guide.sync.connectingDb'))

    let progressInterval: ReturnType<typeof setInterval> | null = null
    const startProgressSimulation = (estimatedTotal = 20) => {
      let count = 0
      progressInterval = setInterval(() => {
        if (count < estimatedTotal && syncingRef.current && syncStepRef.current === 2) {
          count += Math.floor(Math.random() * 3) + 1
        }
      }, 300)
    }

    try {
      // Simulate step progression
      setTimeout(() => {
        if (syncingRef.current) {
          updateSyncStep(2)
          setProgressText(t('database.guide.sync.fetchingStructure'))
          startProgressSimulation(20)
        }
      }, 500)

      // Prepare sync params and call the matching API.
      let res: any
      if (syncScopeRef.current === 'schema' && selectedTablesRef.current.length > 0) {
        // In schema mode, use table-level sync API when specific tables are selected.
        const tableNames = selectedTablesRef.current
          .map((id) => {
            const table = sourceTablesRef.current.find(
              (tb) => (tb.id || `${tb.schema_name || 'default'}.${tb.table_name || tb.name}`) === id
            )
            if (table) {
              return {
                schema_name: table.schema_name || 'default',
                table_name: table.table_name || table.name
              }
            }
            return null
          })
          .filter(Boolean)

        if (tableNames.length === 0) {
          throw new Error(t('database.guide.sync.selectAtLeastOneTable'))
        }

        res = await syncDatabaseTablesReq(effectiveProjectId, databaseId, { tableNames })
      } else {
      // Sync whole DB or schema mode (no specific table selected) via sync-schema API.
        let syncParams: any = null
        if (syncScopeRef.current === 'schema' && selectedSchemasRef.current.length > 0) {
          syncParams = { schemas: selectedSchemasRef.current }
        }

        res = await syncDatabaseSchemaReq(effectiveProjectId, databaseId, syncParams)
      }

      if (res.success) {
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }

        updateSyncStep(3)
        setProgressText(t('database.guide.sync.savingInfo'))

        await new Promise((resolve) => setTimeout(resolve, 300))

        // Fetch synced table count statistics.
        const tablesRes: any = await getCachedTablesReq(effectiveProjectId, databaseId)

        // Load all tables for counting.
        let allTables: any[] = []
        if (tablesRes.success && tablesRes.data) {
          allTables = tablesRes.data.items || tablesRes.data || []
        }

        // Count only tables actually included in current sync type.
        let syncedTables: any[] = []
        if (syncScopeRef.current === 'schema' && selectedTablesRef.current.length > 0) {
          // Table-level sync: count selected tables only.
          const syncedTableKeys = selectedTablesRef.current
            .map((id) => {
              const table = sourceTablesRef.current.find(
                (tb) => (tb.id || `${tb.schema_name || 'default'}.${tb.table_name || tb.name}`) === id
              )
              if (table) {
                return `${table.schema_name || 'default'}.${table.table_name || table.name}`
              }
              return null
            })
            .filter(Boolean)

          syncedTables = allTables.filter((table) => {
            const tableKey = `${table.schema_name || 'default'}.${table.table_name}`
            return syncedTableKeys.includes(tableKey)
          })
        } else if (syncScopeRef.current === 'schema' && selectedSchemasRef.current.length > 0) {
        // Schema-level sync: count tables in selected schemas.
          syncedTables = allTables.filter((table) => {
            const tableSchema = table.schema_name || 'default'
            return selectedSchemasRef.current.includes(tableSchema)
          })
        } else {
        // Full DB sync: count all tables.
          syncedTables = allTables
        }

        // Record actual synced table details.
        const schemaSet = new Set<string>()
        let totalColumns = 0
        syncedTables.forEach((table) => {
          const schema = table.schema_name || 'default'
          schemaSet.add(schema)
          totalColumns += table.column_count || 0
        })

        // If schema is missing, use default 'default'.
        if (schemaSet.size === 0) {
          schemaSet.add('default')
        }

        // Compute unchanged tables count.
        const addedTables = res.data?.added_tables ?? 0
        const updatedTables = res.data?.updated_tables ?? 0
        const totalTables = syncedTables.length
        const unchangedTables = Math.max(0, totalTables - addedTables - updatedTables)

        const nextResult: SyncResult = {
          schemas: Array.from(schemaSet),
          tableCount: totalTables,
          columnCount: totalColumns,
          changes: {
            new: addedTables,
            updated: updatedTables,
            unchanged: unchangedTables
          }
        }
        setSyncResult(nextResult)

        updateSyncCompleted(true)
        updateSyncing(false)
        notifications.show({
          color: 'green',
          message: t('database.guide.sync.syncSuccess', { count: nextResult.tableCount })
        })

        // Update sync status for processed tables.
        setHasSyncedTables(nextResult.tableCount > 0)

        // Auto-sync example values after completion for tables in this run, non-blocking.
        syncExampleValuesAfterSync(syncedTables)

        onSyncCompleted?.(nextResult)
      } else {
        throw new Error(res.msg || t('database.guide.sync.syncFailed'))
      }
    } catch (error: any) {
      if (progressInterval) {
        clearInterval(progressInterval)
        progressInterval = null
      }
      console.error('同步数据库结构失败:', error)
      notifications.show({
        color: 'red',
        message: error.message || t('database.guide.sync.syncStructureFailed')
      })
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval)
        progressInterval = null
      }
      // Set syncing false only when sync fails.
      // If sync succeeds, syncing is set to false automatically after syncCompleted.
      if (!syncCompletedRef.current) {
        updateSyncing(false)
        updateSyncStep(0)
        setProgressText('')
      } else {
        // Ensure syncing is false on success so completion UI is shown.
        updateSyncing(false)
      }
    }
  }

  // Auto-sync example values after successful sync, aligned to current sync scope.
  const syncExampleValuesAfterSync = async (syncedTablesFromStep: any[] | null = null) => {
    try {
      let tableList: any[] = []
      if (syncedTablesFromStep && Array.isArray(syncedTablesFromStep) && syncedTablesFromStep.length > 0) {
        // Use exactly the tables involved in this sync scope.
        tableList = syncedTablesFromStep
      } else {
        // Compatibility: if no table list is passed, use all cached tables.
        const res: any = await getCachedTablesReq(effectiveProjectId, databaseId)
        if (!res.success || !res.data) {
          setExamplesSyncCompleted(true)
          return
        }
        tableList = res.data.items || res.data || []
      }

      if (tableList.length === 0) {
        setExamplesSyncCompleted(true)
        return
      }

      // Start example values sync
      setSyncingExamples(true)
      setExamplesSyncCompleted(false)

      try {
        // Sync example values only for tables in the current sync scope.
        const tableIds = tableList.map((table) => table.id)
        const exampleRes: any = await batchSyncTableExampleValuesReq(
          effectiveProjectId,
          databaseId,
          tableIds,
        2 // limit: fetch 2 sample values per column
        )

        if (exampleRes.success && exampleRes.data) {
          const { success_count, fail_count, total } = exampleRes.data
          if (success_count > 0) {
            if (fail_count > 0) {
              notifications.show({
                color: 'green',
                message: t('database.guide.sync.exampleSyncSuccess', { success: success_count, total })
              })
            } else {
              notifications.show({
                color: 'green',
                message: t('database.guide.sync.exampleSyncSuccess', { success: success_count, total })
              })
            }
          }
          setExamplesSyncCompleted(true)
        } else {
        // Continue even if this step fails.
          notifications.show({ color: 'yellow', message: t('database.guide.sync.exampleSyncFailed') })
          setExamplesSyncCompleted(true)
        }
      } catch (error) {
        console.error('批量同步示例数据失败:', error)
        notifications.show({ color: 'yellow', message: t('database.guide.sync.exampleSyncFailed') })
        // Continue even on failure; do not block overall flow.
        setExamplesSyncCompleted(true)
      } finally {
        setSyncingExamples(false)
      }
    } catch (error) {
      console.error('同步示例数据失败:', error)
        // Continue regardless of this failure; keep the flow moving.
      setSyncingExamples(false)
      setExamplesSyncCompleted(true)
    }
  }

  const handleSettingsManualSync = async () => {
    if (!effectiveProjectId || !databaseId) {
      notifications.show({ color: 'yellow', message: t('database.guide.sync.missingDbId') })
      return
    }

    updateSyncing(true)
    updateSyncCompleted(false)
    updateSyncStep(1)
    setProgressText(t('database.guide.sync.connectingDb'))

    try {
      window.setTimeout(() => {
        if (syncingRef.current) {
          updateSyncStep(2)
          setProgressText(t('database.guide.sync.fetchingStructure'))
        }
      }, 300)

      const tableNames = syncScopeRef.current === 'schema' && selectedTablesRef.current.length > 0
        ? getSelectedTableNames()
        : null
      const res: any = await triggerMetadataSyncReq(effectiveProjectId, databaseId, {
        trigger_source: 'manual',
        sync_mode: syncScopeRef.current === 'all' ? 'all' : 'registered_only',
        table_names: tableNames
      })

      if (!res.success) {
        throw new Error(res.msg || t('database.metaSync.manual.failed'))
      }

      updateSyncStep(3)
      setProgressText(t('database.guide.sync.savingInfo'))
      const data = res.data || {}
      const nextResult: SyncResult = {
        schemas: [],
        tableCount: data.tables_synced || 0,
        columnCount: data.columns_synced || 0,
        changes: {
          new: data.added_tables || 0,
          updated: data.updated_tables || 0,
          unchanged: Math.max(0, (data.tables_synced || 0) - (data.added_tables || 0) - (data.updated_tables || 0))
        }
      }
      setSyncResult(nextResult)
      updateSyncCompleted(true)
      setHasSyncedTables((data.tables_synced || 0) > 0)
      notifications.show({ color: 'green', message: t('database.guide.sync.syncSuccess', { count: data.tables_synced || 0 }) })
      await loadAudits()
      await checkSyncedTables()
      syncExampleValuesAfterSync(null)
      onSyncCompleted?.(nextResult)
    } catch (error: any) {
      console.error('元数据同步失败:', error)
      notifications.show({ color: 'red', message: error.message || t('database.metaSync.manual.failed') })
      updateSyncCompleted(false)
      updateSyncStep(0)
      setProgressText('')
    } finally {
      updateSyncing(false)
    }
  }

  // Re-sync: execute directly without returning to selection view.
  const handleResync = async () => {
    // Reset example-value sync state
    setSyncingExamples(false)
    setExamplesSyncCompleted(false)
    // If previous mode was full DB sync, run full sync again.
    if (syncScopeRef.current === 'all') {
      await handleStartSync()
      return
    }

    // In schema selection mode, make sure selections are available first.
    if (syncScopeRef.current === 'schema') {
      // If not selected, load data and default-select everything.
      if (sourceSchemasRef.current.length === 0 || selectedSchemasRef.current.length === 0) {
        await loadSchemas()
        if (sourceSchemasRef.current.length > 0) {
        // Select all schemas by default.
          updateSelectedSchemas(sourceSchemasRef.current.map((s) => s.name))
          await loadTables()
          // Select all tables by default.
          updateSelectedTables(
            getFilteredTables().map(
              (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
            )
          )
        } else {
        // Without schema data, load all tables and select all.
          await loadTables()
          updateSelectedTables(
            getFilteredTables().map(
              (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
            )
          )
        }
      } else if (selectedTablesRef.current.length === 0) {
      // Schema chosen but no tables selected: load and select all tables.
        await loadTables()
        updateSelectedTables(
          getFilteredTables().map(
            (table) => table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
          )
        )
      }

    // Start sync directly after ensuring selections exist.
      if (getCanStartSync()) {
        await handleStartSync()
      }
    }
  }

  // Back step
  const handlePrev = () => {
    onPrev?.()
  }

  // Next step
  const handleNext = () => {
    onStepCompleted?.()
  }

  // Search handling (table-only)
  const handleTableSearch = () => {
    // Search logic is handled in computed filteredTables.
  }

  const policyPayload = useMemo(
    () => ({
      enabled: autoSyncOn,
      skip_cron: false,
      schedule_cron: buildScheduleCron(schedulePreset, scheduleHour, scheduleWeekday, customCron),
      sync_mode: syncScope === 'all' ? 'all' : 'registered_only'
    }),
    [autoSyncOn, customCron, scheduleHour, schedulePreset, scheduleWeekday, syncScope]
  )
  const policySnapshot = useMemo(() => JSON.stringify(policyPayload), [policyPayload])
  const policyDirty = savedPolicySnapshot !== '' && policySnapshot !== savedPolicySnapshot

  const schedulePreviewText = useMemo(() => {
    if (!autoSyncOn) return t('database.metaSync.config.schedulePreviewOff')
    if (schedulePreset === 'default') return t('database.metaSync.config.schedulePreviewDefault')
    if (schedulePreset === 'hourly') return t('database.metaSync.config.schedulePreviewHourly')
    const hh = padHour(scheduleHour)
    if (schedulePreset === 'daily') return t('database.metaSync.config.schedulePreviewDaily', { hh })
    if (schedulePreset === 'weekly') {
      const weekday = t(`database.metaSync.config.${weekdayKeys[scheduleWeekday]}`)
      return t('database.metaSync.config.schedulePreviewWeekly', { wk: weekday, hh })
    }
    return customCron.trim()
      ? t('database.metaSync.config.schedulePreviewCustom', { cron: customCron.trim() })
      : t('database.metaSync.config.schedulePreviewCustomEmpty')
  }, [autoSyncOn, customCron, scheduleHour, schedulePreset, scheduleWeekday, t])

  const describeCron = (cron: string | null | undefined) => {
    const parsed = parseCronToPreset(cron)
    if (parsed.preset === 'default') return t('database.metaSync.status.nextDefault')
    if (parsed.preset === 'hourly') return t('database.metaSync.status.nextHourly')
    if (parsed.preset === 'daily') return t('database.metaSync.status.nextDaily', { hh: padHour(parsed.hour || 0) })
    if (parsed.preset === 'weekly') {
      const weekday = t(`database.metaSync.config.${weekdayKeys[parsed.weekday || 0]}`)
      return t('database.metaSync.status.nextWeekly', { wk: weekday, hh: padHour(parsed.hour || 0) })
    }
    return `cron: ${cron}`
  }

  const relativeTime = (iso?: string) => {
    if (!iso) return '-'
    const diff = (Date.now() - new Date(iso).getTime()) / 1000
    if (!Number.isFinite(diff)) return '-'
    if (diff < 60) return t('database.metaSync.time.justNow')
    if (diff < 3600) return t('database.metaSync.time.minutesAgo', { n: Math.floor(diff / 60) })
    if (diff < 86400) return t('database.metaSync.time.hoursAgo', { n: Math.floor(diff / 3600) })
    if (diff < 86400 * 30) return t('database.metaSync.time.daysAgo', { n: Math.floor(diff / 86400) })
    return new Date(iso).toLocaleDateString()
  }

  const loadSyncConfig = async () => {
    if (!isSettingsVariant || !effectiveProjectId || !databaseId) return
    setConfigLoading(true)
    try {
      const res: any = await getSyncConfigReq(effectiveProjectId, databaseId)
      const data = res.data || {}
      const cron = data.schedule_cron ?? null
      const parsed = parseCronToPreset(cron)
      const mode = data.sync_mode === 'all' ? 'all' : 'registered_only'
      setAutoSyncOn(!!data.enabled)
      setSchedulePreset(parsed.preset)
      setScheduleHour(parsed.hour ?? 3)
      setScheduleWeekday(parsed.weekday ?? 1)
      setCustomCron(cron || '')
      setServerPolicy({
        enabled: !!data.enabled,
        schedule_cron: cron,
        sync_mode: mode
      })
      const loadedPayload = {
        enabled: !!data.enabled,
        skip_cron: false,
        schedule_cron: cron,
        sync_mode: mode
      }
      setSavedPolicySnapshot(JSON.stringify(loadedPayload))
      if (mode === 'all') {
        updateSyncScope('all')
        updateSelectedSchemas([])
        updateSelectedTables([])
        updateSourceSchemas([])
        updateSourceTables([])
      } else {
        await selectScope('schema')
      }
    } catch (error) {
      console.error('加载同步配置失败:', error)
      notifications.show({ color: 'red', message: t('database.metaSync.config.loadFailed') })
    } finally {
      setConfigLoading(false)
    }
  }

  const handleSaveSyncConfig = async () => {
    if (!effectiveProjectId || !databaseId) return
    setConfigSaving(true)
    try {
      const res: any = await updateSyncConfigReq(effectiveProjectId, databaseId, policyPayload)
      const data = res.data || policyPayload
      const cron = data.schedule_cron ?? policyPayload.schedule_cron
      const mode = data.sync_mode === 'all' ? 'all' : 'registered_only'
      setServerPolicy({
        enabled: !!data.enabled,
        schedule_cron: cron,
        sync_mode: mode
      })
      setSavedPolicySnapshot(JSON.stringify({
        enabled: !!data.enabled,
        skip_cron: false,
        schedule_cron: cron,
        sync_mode: mode
      }))
      notifications.show({ color: 'green', message: t('database.metaSync.config.saved') })
    } catch (error) {
      console.error('保存同步配置失败:', error)
      notifications.show({ color: 'red', message: t('database.metaSync.config.saveFailed') })
    } finally {
      setConfigSaving(false)
    }
  }

  const loadAudits = async () => {
    if (!isSettingsVariant || !effectiveProjectId || !databaseId) return
    setAuditsLoading(true)
    try {
      const params: any = { limit: 10, offset: 0 }
      if (auditFilter === 'error') params.status = 'error'
      const res: any = await listSyncAuditsReq(effectiveProjectId, databaseId, params)
      setAudits(res.data?.items || [])
    } catch (error) {
      console.error('加载同步记录失败:', error)
      setAudits([])
    } finally {
      setAuditsLoading(false)
    }
  }

  // Initialize on mount: keep selection page visible and do not auto-check existing sync structure.
  // Watch databaseId changes (equivalent to watch(() => props.databaseId)).
  // Keep both paths consistent: reset state and check synced tables in one useEffect.
  const mountedRef = useRef(false)
  useEffect(() => {
    // Reset state to keep selection page visible.
    updateSyncCompleted(false)
    updateSyncing(false)
    setSyncingExamples(false)
    setExamplesSyncCompleted(false)
    updateSyncScope('all')
    updateSelectedSchemas([])
    updateSelectedTables([])
    updateSourceSchemas([])
    updateSourceTables([])
    // Extra watch branch reset for syncResult (not needed on mount, but safe for initial empty state).
    if (mountedRef.current) {
      setSyncResult({
        schemas: [],
        tableCount: 0,
        columnCount: 0,
        changes: {
          new: 0,
          updated: 0,
          unchanged: 0
        }
      })
    }
    mountedRef.current = true
    // Check whether synced tables exist.
    checkSyncedTables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  useEffect(() => {
    if (!isSettingsVariant) return
    loadSyncConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, effectiveProjectId, isSettingsVariant])

  useEffect(() => {
    if (!isSettingsVariant) return
    loadAudits()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditFilter, databaseId, effectiveProjectId, isSettingsVariant])

  const lastAudit = audits[0]
  const healthStatus = configLoading || auditsLoading
    ? 'loading'
    : !serverPolicy.enabled
      ? 'disabled'
      : lastAudit?.status === 'error'
        ? 'error'
        : lastAudit?.status === 'partial'
          ? 'warning'
          : lastAudit?.status === 'ok'
            ? 'healthy'
            : 'pending'
  const healthLabel = healthStatus === 'loading'
    ? t('database.metaSync.status.loading')
    : healthStatus === 'disabled'
      ? t('database.metaSync.status.disabled')
      : healthStatus === 'error'
        ? t('database.metaSync.status.errorState')
        : healthStatus === 'warning'
          ? t('database.metaSync.status.warning')
          : healthStatus === 'healthy'
            ? t('database.metaSync.status.healthy')
            : t('database.metaSync.status.pending')
  const lastRunText = lastAudit?.created_at ? relativeTime(lastAudit.created_at) : t('database.metaSync.status.never')
  const nextRunText = serverPolicy.enabled
    ? describeCron(serverPolicy.schedule_cron)
    : t('database.metaSync.status.autoOff')

  return (
    <div className={cx(styles.guideStepSync, isSettingsVariant && styles.settingsMode)}>
      {isSettingsVariant ? (
        <div className={styles.settingsStatusBar}>
          <div className={styles.statusLeft}>
            <div
              className={cx(
                styles.statusIndicator,
                syncing && styles.running,
                !syncing && healthStatus === 'healthy' && styles.ready,
                !syncing && healthStatus === 'error' && styles.error,
                !syncing && healthStatus === 'warning' && styles.warning,
                !syncing && healthStatus === 'disabled' && styles.disabled
              )}
            >
              {syncing ? <ElSvgIcon name="Loading" /> : <ElSvgIcon name="Refresh" />}
            </div>
            <div className={styles.statusText}>
              <div className={styles.statusTitle}>{t('project.database.metaSync')}</div>
              <div className={styles.statusMeta}>
                <span>
                  {t('database.metaSync.status.health')}
                  <strong>{healthLabel}</strong>
                </span>
                <span>
                  {t('database.metaSync.status.lastRun')}
                  <strong>{lastRunText}</strong>
                </span>
                <span>
                  {t('database.metaSync.status.nextRun')}
                  <strong>{nextRunText}</strong>
                </span>
              </div>
            </div>
          </div>
          <div className={styles.statusActions}>
            <Button
              onClick={handleSettingsManualSync}
              loading={syncing}
              leftSection={<ElSvgIcon name="Refresh" />}
            >
              {t('database.metaSync.manual.run')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.stepHeader}>
          <h2 className={styles.stepTitle}>{t('database.guide.sync.title')}</h2>
          <p className={styles.stepDesc}>
            {t('database.guide.sync.desc')}
            <br />
            <span className={styles.descTips}>{t('database.guide.sync.newTablesTip')}</span>
            <br />
            <span className={styles.descTips}>{t('database.guide.sync.updateTablesTip')}</span>
          </p>
        </div>
      )}

      <div className={cx(styles.stepContent, isSettingsVariant && styles.settingsContentGrid)}>
        {/* Sync scope selection */}
        <div className={styles.scopePanel}>
        <div className={styles.contentCard}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>{t('database.guide.sync.selectScope')}</div>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.syncScopeSelector}>
              <div
                className={cx(styles.scopeOption, syncScope === 'all' && styles.selected)}
                onClick={() => selectScope('all')}
              >
                <div className={styles.scopeRadio}>
                  <div className={cx(styles.scopeRadioInner, syncScope === 'all' && styles.active)}></div>
                </div>
                <div className={styles.scopeIcon}>📦</div>
                <div className={styles.scopeText}>
                  <div className={styles.scopeTitle}>{t('database.guide.sync.syncAll')}</div>
                  <div className={styles.scopeDesc}>{t('database.guide.sync.syncAllDesc')}</div>
                </div>
              </div>
              <div
                className={cx(styles.scopeOption, syncScope === 'schema' && styles.selected)}
                onClick={() => selectScope('schema')}
              >
                <div className={styles.scopeRadio}>
                  <div className={cx(styles.scopeRadioInner, syncScope === 'schema' && styles.active)}></div>
                </div>
                <div className={styles.scopeIcon}>📁</div>
                <div className={styles.scopeText}>
                  <div className={styles.scopeTitle}>{t('database.guide.sync.syncBySchema')}</div>
                  <div className={styles.scopeDesc}>{t('database.guide.sync.syncBySchemaDesc')}</div>
                </div>
              </div>
            </div>

            {/* Sync progress area (shown while syncing or done, above tree selector) */}
            {(syncing || syncCompleted) && (
              <div className={cx(styles.contentCard, styles.syncProgressCard, styles.syncProgressTop)}>
                <div className={styles.syncProgressContent}>
                  {/* Syncing state */}
                  {syncing && (
                    <div className={styles.syncLoading}>
                      <div className={styles.loadingSpinner}>
                        <span className={styles.isLoading} style={{ display: 'inline-flex' }}>
                          <ElSvgIcon name="Loading" size={60} />
                        </span>
                      </div>
                      <div className={styles.loadingTitle}>{t('database.guide.sync.syncing')}</div>
                      <div className={styles.loadingStatus}>{progressText}</div>

                      {/* Sync step indicator */}
                      <div className={styles.syncSteps}>
                        <div
                          className={cx(
                            styles.syncStep,
                            syncStep >= 1 && styles.active,
                            syncStep > 1 && styles.completed
                          )}
                        >
                          {syncStep > 1 ? <ElSvgIcon name="Check" /> : <span>○</span>}
                          <span>{t('database.guide.sync.connectDb')}</span>
                        </div>
                        <div
                          className={cx(
                            styles.syncStep,
                            syncStep >= 2 && styles.active,
                            syncStep > 2 && styles.completed
                          )}
                        >
                          {syncStep > 2 ? <ElSvgIcon name="Check" /> : <span>○</span>}
                          <span>{t('database.guide.sync.fetchStructure')}</span>
                        </div>
                        <div
                          className={cx(
                            styles.syncStep,
                            syncStep >= 3 && styles.active,
                            syncStep > 3 && styles.completed
                          )}
                        >
                          {syncStep > 3 ? <ElSvgIcon name="Check" /> : <span>○</span>}
                          <span>{t('database.guide.sync.saveInfo')}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Sync completed state */}
                  {syncCompleted && (
                    <div className={styles.syncComplete}>
                      {/* Line 1: title + statistics */}
                      <div className={styles.resultRow1}>
                        <div className={styles.completeHeaderInline}>
                          <span className={styles.completeIcon} style={{ display: 'inline-flex' }}>
                            <ElSvgIcon name="CircleCheck" size={20} />
                          </span>
                          <span className={styles.completeTitle}>{t('database.guide.sync.syncComplete')}</span>
                        </div>
                        <div className={styles.resultStatsInline}>
                          <div className={styles.statItemInline}>
                            <span className={styles.statLabelInline}>Schema</span>
                            <span className={styles.statValueInline}>
                              {syncResult.schemas && syncResult.schemas.length > 0 ? syncResult.schemas.length : 1}
                            </span>
                            {syncResult.schemas && syncResult.schemas.length > 0 && (
                              <span className={styles.statDetailInline}>{syncResult.schemas[0]}</span>
                            )}
                          </div>
                          <div className={styles.statItemInline}>
                            <span className={styles.statLabelInline}>{t('database.guide.sync.tableLabel')}</span>
                            <span className={styles.statValueInline}>{syncResult.tableCount || 0}</span>
                          </div>
                          <div className={styles.statItemInline}>
                            <span className={styles.statLabelInline}>{t('database.guide.sync.columnLabel')}</span>
                            <span className={styles.statValueInline}>{syncResult.columnCount || 0}</span>
                          </div>
                        </div>
                      </div>

                      {/* Line 2: details + hint */}
                      <div className={styles.resultRow2}>
                        {syncResult.changes && (
                          <div className={styles.syncDetailsInline}>
                            <span className={styles.detailLabelInline}>{t('database.guide.sync.newTables')}</span>
                            <span className={cx(styles.detailValueInline, styles.new)}>
                              {syncResult.changes.new || 0}
                            </span>
                            <span className={styles.detailSeparator}>|</span>
                            <span className={styles.detailLabelInline}>
                              {t('database.guide.sync.updatedTables')}
                            </span>
                            <span className={cx(styles.detailValueInline, styles.updated)}>
                              {syncResult.changes.updated || 0}
                            </span>
                            <span className={styles.detailSeparator}>|</span>
                            <span className={styles.detailLabelInline}>
                              {t('database.guide.sync.unchangedTables')}
                            </span>
                            <span className={cx(styles.detailValueInline, styles.unchanged)}>
                              {syncResult.changes.unchanged || 0}
                            </span>
                          </div>
                        )}
                        <div className={styles.tipInline}>
                          <ElSvgIcon name="InfoFilled" />
                          <span className={styles.tipText}>{t('database.guide.sync.nextStepTip')}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Example value sync status (shown below sync completion results) */}
                  {syncCompleted && syncingExamples && (
                    <div className={styles.syncExamplesProgress}>
                      <div className={styles.examplesLoading}>
                        <span className={styles.isLoading} style={{ display: 'inline-flex' }}>
                          <ElSvgIcon name="Loading" size={20} />
                        </span>
                        <span className={styles.examplesText}>{t('database.guide.sync.syncingExamples')}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tree selector (visible in schema mode) */}
            {syncScope === 'schema' && (
              <div className={cx(styles.treeSelector, (syncing || syncCompleted) && styles.compactMode)}>
                {/* Schema column (always shown, at least default) */}
                <div className={styles.treeColumn}>
                  <div className={styles.treeColumnHeader}>
                    <span>Schema</span>
                    <Button variant="subtle" size="compact-xs" onClick={toggleAllSchemas} px={0}>
                      {selectedSchemas.length === sourceSchemas.length
                        ? t('database.guide.sync.deselectAll')
                        : t('database.guide.sync.selectAll')}
                    </Button>
                  </div>
                  <div className={styles.treeColumnBody}>
                    {sourceSchemas.map((schema) => (
                      <div
                        key={schema.name}
                        className={cx(styles.treeItem, selectedSchemas.includes(schema.name) && styles.selected)}
                        onClick={() => toggleSchema(schema.name)}
                      >
                        <div
                          className={cx(
                            styles.treeCheckbox,
                            selectedSchemas.includes(schema.name) && styles.checked
                          )}
                        >
                          {selectedSchemas.includes(schema.name) && <ElSvgIcon name="Check" />}
                        </div>
                        <span className={styles.treeItemText}>{schema.name}</span>
                        <span className={styles.treeItemCount}>
                          {t('database.guide.sync.tableCountLabel', { count: schema.tableCount })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Table column */}
                <div className={styles.treeColumn}>
                  <div className={styles.treeColumnHeader}>
                    <span>{t('database.guide.sync.tableLabel')}</span>
                    <Button variant="subtle" size="compact-xs" onClick={toggleAllTables} px={0}>
                      {selectedTables.length === filteredTables.length
                        ? t('database.guide.sync.deselectAll')
                        : t('database.guide.sync.selectAll')}
                    </Button>
                  </div>
                  <div className={styles.searchBox}>
                    <ElSvgIcon name="Search" />
                    <TextInput
                      className={styles.searchInput}
                      value={tableSearchKeyword}
                      placeholder={t('database.guide.sync.searchTable')}
                      size="xs"
                      onChange={(e) => {
                        updateTableSearchKeyword(e.currentTarget.value)
                        handleTableSearch()
                      }}
                    />
                  </div>
                  <div className={styles.treeColumnBody}>
                    {loadingTables ? (
                      <div className={styles.loadingHint}>
                        <span className={styles.isLoading} style={{ display: 'inline-flex' }}>
                          <ElSvgIcon name="Loading" />
                        </span>
                        <span>{t('database.guide.sync.loading')}</span>
                      </div>
                    ) : filteredTables.length === 0 ? (
                      <div className={styles.emptyHint}>
                        <span>
                          {tableSearchKeyword
                            ? t('database.guide.sync.noMatchingTables')
                            : sourceSchemas.length > 0 && selectedSchemas.length === 0
                              ? t('database.guide.sync.selectSchemaFirst')
                              : t('database.guide.sync.noTableData')}
                        </span>
                      </div>
                    ) : (
                      filteredTables.map((table) => {
                        const tableId =
                          table.id || `${table.schema_name || 'default'}.${table.table_name || table.name}`
                        return (
                          <div
                            key={tableId}
                            className={cx(styles.treeItem, selectedTables.includes(tableId) && styles.selected)}
                            onClick={() => toggleTable(tableId)}
                          >
                            <div
                              className={cx(
                                styles.treeCheckbox,
                                selectedTables.includes(tableId) && styles.checked
                              )}
                            >
                              {selectedTables.includes(tableId) && <ElSvgIcon name="Check" />}
                            </div>
                            <span className={styles.treeItemText}>{table.table_name || table.name}</span>
                            {table.column_count && table.column_count > 0 ? (
                              <span className={styles.treeItemCount}>
                                {t('database.guide.sync.columnCount', { count: table.column_count })}
                              </span>
                            ) : null}
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        </div>

        {isSettingsVariant && (
          <div className={styles.settingsSidePanel}>
            <div className={cx(styles.contentCard, styles.policyCard)}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitle}>
                  <ElSvgIcon name="Setting" size={15} />
                  {t('database.metaSync.config.title')}
                </div>
                {(policyDirty || configSaving) && (
                  <Button
                    size="compact-sm"
                    onClick={handleSaveSyncConfig}
                    loading={configSaving}
                    disabled={configLoading}
                  >
                    {t('common.save')}
                  </Button>
                )}
              </div>
              <div className={styles.cardBody}>
                <div className={styles.policyField}>
                  <div className={styles.fieldLabelRow}>
                    <div>
                      <div className={styles.fieldLabel}>{t('database.metaSync.config.autoSync')}</div>
                      <div className={styles.fieldHint}>{t('database.metaSync.config.autoSyncHint')}</div>
                    </div>
                    <Switch
                      checked={autoSyncOn}
                      onChange={(event) => setAutoSyncOn(event.currentTarget.checked)}
                      disabled={configLoading}
                    />
                  </div>
                </div>

                <div className={cx(styles.policyField, styles.schedulePresetField)}>
                  <div className={styles.fieldLabel}>{t('database.metaSync.config.schedule')}</div>
                  <Select
                    value={schedulePreset}
                    disabled={!autoSyncOn || configLoading}
                    onChange={(value) => setSchedulePreset((value || 'default') as SchedulePreset)}
                    data={[
                      { value: 'default', label: t('database.metaSync.config.scheduleDefault') },
                      { value: 'hourly', label: t('database.metaSync.config.scheduleHourly') },
                      { value: 'daily', label: t('database.metaSync.config.scheduleDaily') },
                      { value: 'weekly', label: t('database.metaSync.config.scheduleWeekly') },
                      { value: 'custom', label: t('database.metaSync.config.scheduleCustom') }
                    ]}
                  />
                </div>

                {schedulePreset === 'daily' && (
                  <div className={styles.scheduleDetail}>
                    <span className={styles.detailLabel}>{t('database.metaSync.config.scheduleAt')}</span>
                    <Select
                      value={String(scheduleHour)}
                      disabled={!autoSyncOn || configLoading}
                      onChange={(value) => setScheduleHour(Number(value || 0))}
                      data={Array.from({ length: 24 }, (_, index) => ({
                        value: String(index),
                        label: `${padHour(index)}:00 UTC`
                      }))}
                    />
                    <span className={styles.hintInline}>{t('database.metaSync.config.scheduleUtcHint')}</span>
                  </div>
                )}

                {schedulePreset === 'weekly' && (
                  <div className={styles.scheduleDetail}>
                    <span className={styles.detailLabel}>{t('database.metaSync.config.scheduleWeeklyAt')}</span>
                    <Select
                      value={String(scheduleWeekday)}
                      disabled={!autoSyncOn || configLoading}
                      onChange={(value) => setScheduleWeekday(Number(value || 1))}
                      data={weekdayKeys.map((key, index) => ({
                        value: String(index),
                        label: t(`database.metaSync.config.${key}`)
                      }))}
                    />
                    <Select
                      value={String(scheduleHour)}
                      disabled={!autoSyncOn || configLoading}
                      onChange={(value) => setScheduleHour(Number(value || 0))}
                      data={Array.from({ length: 24 }, (_, index) => ({
                        value: String(index),
                        label: `${padHour(index)}:00 UTC`
                      }))}
                    />
                  </div>
                )}

                {schedulePreset === 'custom' && (
                  <div className={styles.policyField}>
                    <TextInput
                      value={customCron}
                      disabled={!autoSyncOn || configLoading}
                      placeholder="0 3 * * 3"
                      onChange={(event) => setCustomCron(event.currentTarget.value)}
                    />
                    <div className={styles.fieldHint}>{t('database.metaSync.config.scheduleCustomHint')}</div>
                  </div>
                )}

                <div className={styles.schedulePreview}>
                  <ElSvgIcon name="Clock" size={14} />
                  <span>{schedulePreviewText}</span>
                </div>
              </div>
            </div>

            <div className={cx(styles.contentCard, styles.auditCard)}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitle}>
                  <ElSvgIcon name="Document" size={15} />
                  {t('database.metaSync.audits.title')}
                </div>
                <div className={styles.auditActions}>
                  <button
                    type="button"
                    className={cx(styles.auditFilter, auditFilter === 'all' && styles.active)}
                    onClick={() => setAuditFilter('all')}
                  >
                    {t('database.metaSync.audits.filterAll')}
                  </button>
                  <button
                    type="button"
                    className={cx(styles.auditFilter, auditFilter === 'error' && styles.active)}
                    onClick={() => setAuditFilter('error')}
                  >
                    {t('database.metaSync.audits.filterError')}
                  </button>
                  <Button variant="subtle" size="compact-sm" px={6} onClick={loadAudits} loading={auditsLoading}>
                    <ElSvgIcon name="Refresh" size={14} />
                  </Button>
                </div>
              </div>
              <div className={styles.auditBody}>
                {auditsLoading ? (
                  <div className={styles.auditEmpty}>
                    <span className={styles.isLoading} style={{ display: 'inline-flex' }}>
                      <ElSvgIcon name="Loading" size={20} />
                    </span>
                    <span>{t('database.guide.sync.loading')}</span>
                  </div>
                ) : audits.length === 0 ? (
                  <div className={styles.auditEmpty}>{t('database.metaSync.audits.empty')}</div>
                ) : (
                  <div className={styles.auditTimeline}>
                    {audits.map((row) => (
                      <div key={row.id} className={cx(styles.auditRow, row.status === 'error' && styles.error)}>
                        <div className={styles.auditDot}>
                          {row.status === 'error' ? <ElSvgIcon name="CircleClose" /> : <ElSvgIcon name="CircleCheck" />}
                        </div>
                        <div className={styles.auditMain}>
                          <div className={styles.auditLine}>
                            <strong>
                              {row.status === 'error'
                                ? t('database.metaSync.audits.statusError')
                                : row.status === 'partial'
                                  ? t('database.metaSync.audits.statusPartial')
                                  : t('database.metaSync.audits.statusOk')}
                            </strong>
                            <span>{row.trigger_source === 'cron' ? t('database.metaSync.audits.triggerCron') : t('database.metaSync.audits.triggerManual')}</span>
                            <span>{relativeTime(row.created_at)}</span>
                          </div>
                          <div className={styles.auditMeta}>
                            <span>{row.tables_synced ?? 0} {t('database.metaSync.audits.tables')}</span>
                            <span>{row.columns_synced ?? 0} {t('database.metaSync.audits.columns')}</span>
                            {row.duration_ms != null && <span>{(row.duration_ms / 1000).toFixed(1)}s</span>}
                          </div>
                          {row.error_msg && <div className={styles.auditError}>{row.error_msg}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {!isSettingsVariant && (
        <div className={styles.stepFooter}>
        {!standalone ? (
          <Button variant="default" onClick={handlePrev} leftSection={<ElSvgIcon name="ArrowLeft" />}>
            {t('database.action.prev')}
          </Button>
        ) : (
          <div></div>
        )}
        <div className={styles.footerRight}>
          {/* Not synced: Start sync */}
          {!syncing && !syncCompleted && (
            <Button
              onClick={handleStartSync}
              disabled={!canStartSync}
              rightSection={<ElSvgIcon name="ArrowRight" />}
            >
              {t('database.guide.sync.startSync')}
            </Button>
          )}
          {/* Synced: Re-sync */}
          {syncCompleted && (
            <Button variant="default" onClick={handleResync} leftSection={<ElSvgIcon name="Refresh" />}>
              {t('database.guide.sync.resync')}
            </Button>
          )}
          {/* Next button (visible in wizard mode, hidden during syncing) */}
          {!syncing && !standalone && (
            <Button
              onClick={handleNext}
              disabled={!hasSyncedTables || syncingExamples}
              title={syncingExamples ? t('database.guide.sync.syncingExamplesWait') : ''}
              rightSection={<ElSvgIcon name="ArrowRight" />}
            >
              {t('database.guide.sync.nextMetadata')}
            </Button>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
