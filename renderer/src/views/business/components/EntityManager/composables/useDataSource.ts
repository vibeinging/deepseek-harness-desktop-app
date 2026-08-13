/**
 * Data Source Composable
 * Data source and table column loading
 */
// TODO(migration): @/api/structured_data_source/document has not been migrated to the React project yet.
// Keep the same import path as the source for now; remove after this API module is migrated.
import { useState, useMemo, useCallback } from 'react'
import { notifications } from '@mantine/notifications'
import { t } from '@/lang'
import { getCachedTablesReq, getTableColumnsReq as getDatabaseTableColumnsReq } from '@/api/database'
import { getDataSourceTablesReq } from '@/api/structured_data_source/document'
import { getBusinessDataSourcesReq } from '@/api/business'

export function useDataSource(projectId: any) {
  const [availableDataSources, setAvailableDataSources] = useState<any[]>([])
  const [selectedDataSource, setSelectedDataSource] = useState<any>(null)
  const [loadingDataSources, setLoadingDataSources] = useState(false)
  const [loadingTables, setLoadingTables] = useState(false)
  const [allTables, setAllTables] = useState<any[]>([])

  // Load business-related data sources
  const loadAvailableDataSources = useCallback(async () => {
    try {
      setLoadingDataSources(true)
      const res = await getBusinessDataSourcesReq(projectId)
      if (res.success) {
        const sources: any[] = []
        // Add database connection
        const dbConnections = res.data?.database_connections || []
        dbConnections.forEach((db: any) => {
          sources.push({
            id: db.id,
            name: db.name,
            type: 'database',
            db_type: db.db_type,
            description: db.description
          })
        })
        // Add structured data source
        const structuredSources = res.data?.structured_data_sources || []
        structuredSources.forEach((ds: any) => {
          sources.push({
            id: ds.id,
            name: ds.name,
            type: 'structured',
            description: ds.description,
            database_connection_id: ds.database_connection_id // Get from data-source level
          })
        })
        setAvailableDataSources(sources)
        // Select the first data source by default
        if (sources.length > 0) {
          setSelectedDataSource(sources[0])
        } else {
          setSelectedDataSource(null)
        }
      }
    } catch (error) {
      console.error('加载数据源失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.loadDataSourceFailed') })
    } finally {
      setLoadingDataSources(false)
    }
  }, [projectId])

  // Load table list (based on data source type)
  const loadTables = useCallback(async () => {
    if (!selectedDataSource) {
      setAllTables([])
      return
    }

    try {
      setLoadingTables(true)
      const source = selectedDataSource
      let res: any

      if (source.type === 'database') {
        res = await getCachedTablesReq(projectId, source.id)
      } else if (source.type === 'structured') {
        res = await getDataSourceTablesReq(projectId, source.id)
      }

      if (res?.success) {
        setAllTables(res.data.items || [])
      } else {
        setAllTables([])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.loadTableListFailed') })
      setAllTables([])
    } finally {
      setLoadingTables(false)
    }
  }, [selectedDataSource, projectId])

  // Load table column info (based on data source type)
  const loadTableColumns = useCallback(
    async (tableId: any) => {
      if (!selectedDataSource) return []

      try {
        const source = selectedDataSource
        let connectionId = source.id

        // For structured sources, get database_connection_id from data-source level
        if (source.type === 'structured') {
          connectionId = source.database_connection_id || source.id
        }

        const res = await getDatabaseTableColumnsReq(projectId, connectionId, tableId)
        if (res?.success) {
          return res.data.items || []
        }
      } catch (error) {
        console.error('加载列信息失败:', error)
      }
      return []
    },
    [selectedDataSource, projectId]
  )

  // Data source changed
  const handleDataSourceChange = useCallback(async (source: any) => {
    setSelectedDataSource(source)
    setAllTables([])
    // Note: after source changes, caller should trigger loadTables (or effect depending on selectedDataSource)
    // Here we load table list directly with the new source first
    try {
      setLoadingTables(true)
      let res: any
      if (source?.type === 'database') {
        res = await getCachedTablesReq(projectId, source.id)
      } else if (source?.type === 'structured') {
        res = await getDataSourceTablesReq(projectId, source.id)
      }
      if (res?.success) {
        setAllTables(res.data.items || [])
      } else {
        setAllTables([])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.loadTableListFailed') })
      setAllTables([])
    } finally {
      setLoadingTables(false)
    }
  }, [projectId])

  // Get table object
  const getTableById = useCallback(
    (tableId: any) => {
      return allTables.find((tb: any) => tb.id === tableId)
    },
    [allTables]
  )

  // Get table name
  const getTableName = useCallback(
    (tableId: any) => {
      const table = getTableById(tableId)
      return table?.table_name || ''
    },
    [getTableById]
  )

  // Computed: current selected table name
  const activeTableName = useMemo(() => {
    return selectedDataSource?.name || ''
  }, [selectedDataSource])

  return {
    availableDataSources,
    selectedDataSource,
    loadingDataSources,
    loadingTables,
    allTables,
    activeTableName,
    loadAvailableDataSources,
    loadTables,
    loadTableColumns,
    handleDataSourceChange,
    getTableById,
    getTableName
  }
}
