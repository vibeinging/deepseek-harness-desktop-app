import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Modal,
  Pagination,
  Select,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import * as XLSX from 'xlsx'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useResponsive } from '@/hooks/use-responsive'
import {
  getMetricsReq,
  createMetricReq,
  updateMetricReq,
  updateMetricStatusReq,
  deleteMetricReq,
  deleteMetricsReq,
  generateMetricEmbeddingsReq,
  getMetricEmbeddingPendingCountReq,
  bulkImportMetricsReq,
  searchMetricsReq
} from '@/api/business-semantic'
import { getBusinessDataSourcesReq } from '@/api/business'
import { getCachedTablesReq, getTableColumnsReq as getDatabaseTableColumnsReq } from '@/api/database'
import MetricEmptyState from './MetricEmptyState'
import TableColumnSelector from './TableColumnSelector'
import CodeKnowledgeConditionBuilder from './CodeKnowledgeConditionBuilder'
import styles from './MetricManager.module.scss'

export interface MetricManagerProps {
  projectId: string
  businessId: string
}

// Metric form structure
interface MetricForm {
  name: string
  description: string
  aliases: string // Stored as a comma-separated string on frontend; converted to an array on submit
  execution_plans_json: string
  source_id: string
  source_type: string
  related_tables: string[]
  related_columns: Record<string, any>
  code_knowledge: any // Stored as an object managed directly by EnumValueSelector
}

const EMPTY_EXECUTION_PLANS = [
  {
    plan_type: 'sql',
    source_id: null,
    source_type: null,
    spec: { sql_template: 'SELECT 0 AS value' },
    evidence_policy: { require_evidence: true },
    priority: 100,
    is_active: true
  }
]

const EMPTY_FORM: MetricForm = {
  name: '',
  description: '',
  aliases: '',
  execution_plans_json: JSON.stringify(EMPTY_EXECUTION_PLANS, null, 2),
  source_id: '',
  source_type: '',
  related_tables: [],
  related_columns: {},
  code_knowledge: null
}

// Generate in batches only for metrics not yet vectorized. pendingCount can be passed from import flow to avoid misusing the business total metric count.
const EMBEDDING_NGINX_HINT_THRESHOLD = 500

// Clean SQL template output
const cleanSqlTemplate = (sqlTemplate?: string) => {
  if (!sqlTemplate) return ''
  return sqlTemplate
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const editableExecutionPlans = (metric: any, copy = false) =>
  (Array.isArray(metric?.execution_plans) ? metric.execution_plans : []).map((plan: any) => ({
    ...(!copy && plan.id ? { id: plan.id } : {}),
    plan_type: plan.plan_type,
    source_id: plan.source_id || null,
    source_type: plan.source_type || null,
    spec: plan.spec || {},
    evidence_policy: plan.evidence_policy || {},
    priority: Number.isFinite(Number(plan.priority)) ? Number(plan.priority) : 100,
    is_active: plan.is_active !== false
  }))

const summarizeExecutionPlans = (metric: any) => {
  const plans = Array.isArray(metric?.execution_plans) ? metric.execution_plans : []
  if (!plans.length) return '未配置执行计划'
  return plans.map((plan: any) => {
    if (plan.plan_type === 'sql') return `SQL: ${cleanSqlTemplate(plan.spec?.sql_template)}`
    if (plan.plan_type === 'formula') return `公式: ${plan.spec?.expression || '未填写表达式'}`
    return String(plan.plan_type || '未知计划')
  }).join('；')
}

export default function MetricManager({ projectId, businessId }: MetricManagerProps) {
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // Data
  const [metrics, setMetrics] = useState<any[]>([])
  const [, setLoading] = useState(false)
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generatingMetricId, setGeneratingMetricId] = useState<any>(null) // ID of metric currently generating embeddings
  const [togglingMetricId, setTogglingMetricId] = useState<any>(null) // ID of metric currently toggling active state
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false)
  const [selectedMetricIds, setSelectedMetricIds] = useState<Set<any>>(new Set())
  const [selectAllAcrossPages, setSelectAllAcrossPages] = useState(false)

  // Data source
  const [dataSources, setDataSources] = useState<any[]>([])
  const [selectedSourceType, setSelectedSourceType] = useState('database') // Currently selected source type

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalMetrics, setTotalMetrics] = useState(0) // Total count returned by backend

  // Dialogs
  const [metricDialogVisible, setMetricDialogVisible] = useState(false)
  const [bulkImportDialogVisible, setBulkImportDialogVisible] = useState(false)
  const [showSearchDialog, setShowSearchDialog] = useState(false)
  const [codeKnowledgeHelpDialogVisible, setCodeKnowledgeHelpDialogVisible] = useState(false)
  const [editingMetric, setEditingMetric] = useState<any>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [bulkImportSourceId, setBulkImportSourceId] = useState('') // Selected data source ID in bulk import
  const [bulkImportOverwrite, setBulkImportOverwrite] = useState(false) // Overwrite existing metrics in bulk import
  const fileInputRef = useRef<HTMLInputElement>(null) // Upload component ref

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // Selected configs (for final submit, managed by TableColumnSelector)
  const [selectedTableColumnsConfig, setSelectedTableColumnsConfig] = useState<Record<string, any>>({}) // { table_name: [column_name1, column_name2] }

  // Current selected source ID (for TableColumnSelector)
  const [connectionId, setConnectionId] = useState<any>(null)
  const [selectedDatabaseConnectionId, setSelectedDatabaseConnectionId] = useState<any>(null) // database_connection_id for structured sources

  // Column enum mapping data: { table_name: { column_name: { enum_mappings, description } } }
  const [columnEnumMappings, setColumnEnumMappings] = useState<Record<string, any>>({})

  // Form
  const [metricForm, setMetricForm] = useState<MetricForm>({ ...EMPTY_FORM })
  // Form validation errors (equivalent to el-form rules)
  const [formErrors, setFormErrors] = useState<{ name?: string; execution_plans_json?: string }>({})

  // Debounce timer
  const loadColumnMappingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref for latest value access inside closures (instead of direct .value reads)
  const connectionIdRef = useRef<any>(null)
  const selectedConfigRef = useRef<Record<string, any>>({})
  connectionIdRef.current = connectionId
  selectedConfigRef.current = selectedTableColumnsConfig

  const setFormField = (patch: Partial<MetricForm>) => {
    setMetricForm((prev) => ({ ...prev, ...patch }))
  }

  // Pagination layout (simplified for mobile)
  const metricPaginationLayout = isMobile ? 'total, prev, pager, next' : 'total, sizes, prev, pager, next, jumper'

  // Computed states
  const selectedCount = useMemo(
    () => (selectAllAcrossPages ? totalMetrics : selectedMetricIds.size),
    [selectAllAcrossPages, totalMetrics, selectedMetricIds]
  )
  const isAllPageSelected = useMemo(
    () =>
      metrics.length > 0 &&
      metrics.every((m) => selectAllAcrossPages || selectedMetricIds.has(m.id)),
    [metrics, selectAllAcrossPages, selectedMetricIds]
  )
  const isAllSelected = useMemo(() => {
    if (selectAllAcrossPages) return true
    if (metrics.length === 0) return false
    return metrics.every((m) => selectedMetricIds.has(m.id))
  }, [metrics, selectAllAcrossPages, selectedMetricIds])
  const isIndeterminate = useMemo(() => {
    if (selectAllAcrossPages || metrics.length === 0) return false
    const pageSelectedCount = metrics.filter((m) => selectedMetricIds.has(m.id)).length
    return pageSelectedCount > 0 && pageSelectedCount < metrics.length
  }, [metrics, selectAllAcrossPages, selectedMetricIds])
  const hasCrossPageSelection = useMemo(() => {
    if (selectAllAcrossPages || metrics.length === 0) return false
    const pageIds = new Set(metrics.map((m) => m.id))
    const selectedOnPage = [...selectedMetricIds].filter((id) => pageIds.has(id)).length
    return selectedMetricIds.size > selectedOnPage
  }, [metrics, selectAllAcrossPages, selectedMetricIds])

  // Total pages (for Mantine Pagination)
  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalMetrics / pageSize)), [totalMetrics, pageSize])

  // Methods
  const loadMetrics = async (page = currentPage, size = pageSize, resetPage = false) => {
    const targetPage = resetPage ? 1 : page
    if (resetPage) setCurrentPage(1)
    try {
      setLoading(true)
      const response = await getMetricsReq(projectId, targetPage, size)
      if (response && response.success) {
        setMetrics(response.data?.items || [])
        setTotalMetrics(response.data?.total || 0)
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('business.metric.loadFailed') + ': ' + error.message })
    } finally {
      setLoading(false)
    }
  }

  // Load business-related data sources
  const loadDataSources = async () => {
    try {
      const response = await getBusinessDataSourcesReq(projectId)
      if (response && response.success) {
        // API response format: { database_connections: [], unstructured_data_sources: [], structured_data_sources: [] }
        const data = response.data || {}
        const dbConnections = data.database_connections || []
        const structuredSources = data.structured_data_sources || []

        // Merge database connections and structured data sources
        const sources: any[] = []

        // Database connections (table/column selection supported)
        dbConnections.forEach((ds: any) => {
          sources.push({
            id: `db_${ds.id}`,
            name: ds.name || ds.connection_name || ds.display_name || t('business.dataSources.database'),
            source_id: ds.id,
            source_type: ds.source_type, // Use source_type from backend
            db_type: ds.db_type, // Keep db_type for downstream logic
            type: 'database'
          })
        })

        // Structured data source
        structuredSources.forEach((ds: any) => {
          sources.push({
            id: `struct_${ds.id}`,
            name: ds.name || ds.display_name || t('business.dataSources.structured'),
            source_id: ds.id,
            source_type: ds.source_type, // Use source_type from backend
            database_connection_id: ds.database_connection_id, // Retrieved from source-level field
            type: 'structured'
          })
        })

        setDataSources(sources)
      }
    } catch (error) {
      console.error('加载数据源失败:', error)
    }
  }

  // Handle page change
  const handlePageChange = (page: number) => {
    setCurrentPage(page)
    loadMetrics(page, pageSize)
    document.querySelector('.metrics-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  // Handle page size change
  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setCurrentPage(1)
    loadMetrics(1, size)
  }

  // Data source selection change
  const handleDataSourceChange = (sourceId: any) => {
    // Find matching source by selected sourceId
    const selectedSource = dataSources.find((ds) => ds.source_id === sourceId)

    if (selectedSource) {
      setConnectionId(sourceId)
      setSelectedSourceType(selectedSource.type)
      setSelectedDatabaseConnectionId(selectedSource.database_connection_id || null)
      setFormField({ source_type: selectedSource.source_type, source_id: sourceId || '' }) // Use source_type from backend directly
    } else {
      setConnectionId(null)
      setSelectedSourceType('database')
      setSelectedDatabaseConnectionId(null)
      setFormField({ source_type: '', source_id: sourceId || '' })
    }

    // Clear selected table-column config
    setSelectedTableColumnsConfig({})
    setColumnEnumMappings({})
  }

  // Load column enum mapping data
  const loadColumnEnumMappings = async () => {
    const curConnectionId = connectionIdRef.current
    const curConfig = selectedConfigRef.current
    if (!curConnectionId || !curConfig) {
      setColumnEnumMappings({})
      return
    }

    try {
      const tables = Object.keys(curConfig)
      const mappings: Record<string, any> = {}

      // Load all tables
      const tablesRes = await getCachedTablesReq(projectId, curConnectionId)
      if (!tablesRes?.success) {
        return
      }

      const allTables = tablesRes.data?.items || []
      const tableMap = new Map<string, any>(allTables.map((tb: any) => [tb.table_name, tb.id]))

      // Iterate every table and every column to get enum mappings
      for (const tableName of tables) {
        let tableId = tableMap.get(tableName)

        // Try matching by stripping schema prefix
        if (!tableId && tableName.includes('.')) {
          const shortName = tableName.split('.').pop() as string
          tableId = tableMap.get(shortName)
        }

        if (!tableId) {
          continue
        }

        const columns = curConfig[tableName] || []
        mappings[tableName] = {}

        // Load all columns for the current table
        const columnsRes = await getDatabaseTableColumnsReq(projectId, curConnectionId, tableId)

        if (columnsRes?.success) {
          const allColumns = columnsRes.data?.items || []

          for (const column of columns) {
            const columnInfo = allColumns.find((c: any) => c.column_name === column)
            if (columnInfo) {
              mappings[tableName][column] = {
                description: columnInfo.description,
                enum_mappings: columnInfo.enum_mappings
              }
            }
          }
        }
      }

      setColumnEnumMappings(mappings)
    } catch (error) {
      console.error('加载列枚举映射失败:', error)
    }
  }

  const resetMetricForm = () => {
    setMetricForm({ ...EMPTY_FORM })
    // Clear selection state
    setConnectionId(null)
    setSelectedTableColumnsConfig({})
    setColumnEnumMappings({})
    setFormErrors({})
  }

  const openAddMetricDialog = () => {
    setEditingMetric(null)
    resetMetricForm()
    setMetricDialogVisible(true)
  }

  // Restore data source / table-column selections from metric (editMetric / copyMetric shared)
  const restoreSourceState = (plan: any, sourceType: string) => {
    if (plan?.source_id) {
    // Find source by source_id
      const selectedSource = dataSources.find((ds) => ds.source_id === plan.source_id)
      if (selectedSource) {
        setConnectionId(plan.source_id)
        setSelectedSourceType(selectedSource.type)
        setSelectedDatabaseConnectionId(selectedSource.database_connection_id || null)
        connectionIdRef.current = plan.source_id
        return selectedSource.source_type // Use source_type from backend
      } else {
        // If the source is not in the list, still set connectionId to keep column selector visible
        setConnectionId(plan.source_id)
        setSelectedSourceType(sourceType === 'database' ? 'database' : 'structured')
        setSelectedDatabaseConnectionId(null)
        connectionIdRef.current = plan.source_id
        return sourceType || ''
      }
    } else {
      setConnectionId(null)
      setSelectedSourceType('database')
      setSelectedDatabaseConnectionId(null)
      connectionIdRef.current = null
      return sourceType || ''
    }
  }

  const editMetric = (metric: any) => {
    setEditingMetric(metric)
    const plans = editableExecutionPlans(metric)
    const sourcePlan = plans.find((plan: any) => plan.plan_type === 'sql') || plans[0] || null
    const sourceType = restoreSourceState(sourcePlan, sourcePlan?.source_type || '')
    setMetricForm({
      name: metric.name,
      description: metric.description || '',
      aliases: Array.isArray(metric.aliases) ? metric.aliases.join(', ') : '',
      execution_plans_json: JSON.stringify(plans, null, 2),
      source_id: sourcePlan?.source_id || '',
      source_type: sourceType,
      related_tables: metric.related_tables || [],
      related_columns: metric.related_columns || {},
      code_knowledge: metric.code_knowledge || null // Store object directly
    })
    setFormErrors({})

    // Restore selected state
    const config = { ...(metric.related_columns || {}) }
    setSelectedTableColumnsConfig(config)
    selectedConfigRef.current = config

    // Load column enum mappings
    loadColumnEnumMappings()

    setMetricDialogVisible(true)
  }

  const copyMetric = (metric: any) => {
    setEditingMetric(null)
    const plans = editableExecutionPlans(metric, true)
    const sourcePlan = plans.find((plan: any) => plan.plan_type === 'sql') || plans[0] || null
    const sourceType = restoreSourceState(sourcePlan, sourcePlan?.source_type || '')
    setMetricForm({
      name: metric.name + ` (${t('business.metric.copyLabel')})`,
      description: metric.description || '',
      aliases: Array.isArray(metric.aliases) ? metric.aliases.join(', ') : '',
      execution_plans_json: JSON.stringify(plans, null, 2),
      source_id: sourcePlan?.source_id || '',
      source_type: sourceType,
      related_tables: metric.related_tables || [],
      related_columns: JSON.parse(JSON.stringify(metric.related_columns || {})),
      code_knowledge: metric.code_knowledge ? JSON.parse(JSON.stringify(metric.code_knowledge)) : null
    })
    setFormErrors({})

    // Restore selected state
    const config = JSON.parse(JSON.stringify(metric.related_columns || {}))
    setSelectedTableColumnsConfig(config)
    selectedConfigRef.current = config

    // Load column enum mappings
    loadColumnEnumMappings()

    setMetricDialogVisible(true)
  }

  const submitMetricForm = async () => {
    // Sync table-column config into form
    const relatedTables = Object.keys(selectedTableColumnsConfig)
    const relatedColumns = { ...selectedTableColumnsConfig }

    // Validate form (equivalent to el-form rules)
    const errors: { name?: string; execution_plans_json?: string } = {}
    if (!metricForm.name?.trim()) errors.name = t('business.metric.metricNameRequired')
    let executionPlans: any[] = []
    try {
      const parsed = JSON.parse(metricForm.execution_plans_json)
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('执行计划必须是非空数组')
      parsed.forEach((plan: any) => {
        if (!['sql', 'formula'].includes(plan?.plan_type)) {
          throw new Error('plan_type 只能是 sql 或 formula')
        }
        if (!plan.spec || typeof plan.spec !== 'object' || Array.isArray(plan.spec)) {
          throw new Error('每个执行计划都必须包含 spec 对象')
        }
      })
      const sourcePlanIndex = parsed.findIndex((plan: any) => plan.plan_type === 'sql')
      if (sourcePlanIndex >= 0) {
        parsed[sourcePlanIndex] = {
          ...parsed[sourcePlanIndex],
          source_id: metricForm.source_id || null,
          source_type: metricForm.source_type || null
        }
      }
      executionPlans = parsed
    } catch (error: any) {
      errors.execution_plans_json = error?.message || '执行计划 JSON 格式不正确'
    }
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    try {
      setSubmitting(true)

      // Prepare payload and process alias conversion
      const submitData = {
        name: metricForm.name,
        description: metricForm.description,
        execution_plans: executionPlans,
        related_tables: relatedTables,
        related_columns: relatedColumns,
        // aliases: comma-separated string -> array (filter empty values)
        // Support Chinese and English commas, normalize to English comma before split
        // Remove all spaces, including full-width spaces
        aliases: metricForm.aliases
          ? metricForm.aliases
            .replace(/，/g, ',') // Chinese comma -> English comma
            .replace(/\s+/g, '') // Remove all whitespace
              .split(',')
              .filter((s) => s)
          : [],
        // code_knowledge: use object directly (managed by EnumValueSelector)
        code_knowledge: metricForm.code_knowledge
      }

      const isNew = !editingMetric
      let response: any

      // Call create/update API based on add vs edit
      if (isNew) {
        response = await createMetricReq(projectId, submitData)
      } else {
        response = await updateMetricReq(projectId, editingMetric.id, submitData)
      }

      if (response.success) {
        notifications.show({
          color: 'green',
          message: isNew ? t('business.metric.createSuccess') : t('business.metric.updateSuccess')
        })
        setMetricDialogVisible(false)
        await loadMetrics()

        // If updating and embedding refresh is needed, ask user
        if (!isNew && response.data?.vector_needs_update) {
          modals.openConfirmModal({
            title: t('business.metric.updateVector'),
            children: t('business.metric.vectorNeedsUpdateMsg'),
            labels: {
              confirm: t('business.metric.updateVector'),
              cancel: t('business.metric.notNow')
            },
            onConfirm: async () => {
              // User confirmed, trigger single vector generation
              await generateSingleEmbedding(editingMetric)
            }
          })
        }
      }
    } catch (error: any) {
      if (error.name !== 'Error') {
        notifications.show({
          color: 'red',
          message: t('business.metric.operationFailed') + ': ' + error.message
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleRowClick = (row: any) => {
    if (bulkDeleteMode) return
    editMetric(row)
  }

  const isSelected = (metricId: any) => {
    return selectAllAcrossPages || selectedMetricIds.has(metricId)
  }

  const setSelected = (metricId: any, selected: boolean) => {
    if (selectAllAcrossPages) {
      setSelectAllAcrossPages(false)
      if (!selected) {
        setSelectedMetricIds(new Set(metrics.map((m) => m.id).filter((id) => id !== metricId)))
      } else {
        setSelectedMetricIds(new Set(metrics.map((m) => m.id)))
      }
      return
    }
    const next = new Set(selectedMetricIds)
    if (selected) next.add(metricId)
    else next.delete(metricId)
    setSelectedMetricIds(next)
  }

  const enterBulkDeleteMode = () => {
    setBulkDeleteMode(true)
    setSelectAllAcrossPages(false)
    setSelectedMetricIds(new Set())
  }

  const exitBulkDeleteMode = () => {
    setBulkDeleteMode(false)
    setSelectAllAcrossPages(false)
    setSelectedMetricIds(new Set())
  }

  const clearAllSelection = () => {
    setSelectAllAcrossPages(false)
    setSelectedMetricIds(new Set())
  }

  const selectAllMetricsAcrossPages = () => {
    setSelectAllAcrossPages(true)
    setSelectedMetricIds(new Set(metrics.map((m) => m.id)))
  }

  const toggleSelectAll = () => {
    if (selectAllAcrossPages) {
      clearAllSelection()
      return
    }
    const pageIds = metrics.map((m) => m.id)
    const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedMetricIds.has(id))
    const next = new Set(selectedMetricIds)
    if (allPageSelected) {
      pageIds.forEach((id) => next.delete(id))
    } else {
      pageIds.forEach((id) => next.add(id))
    }
    setSelectedMetricIds(next)
  }

  const confirmBulkDelete = () => {
    if (selectedCount === 0) {
      notifications.show({ color: 'yellow', message: t('business.metric.selectMetricsFirst') })
      return
    }

    const count = selectedCount
    const confirmMsg = selectAllAcrossPages
      ? t('business.metric.confirmBulkDeleteAllMsg', { count })
      : t('business.metric.confirmBulkDeleteMsg', { count })

    modals.openConfirmModal({
      title: t('business.metric.confirmBulkDeleteTitle'),
      children: confirmMsg,
      labels: {
        confirm: t('business.metric.confirm'),
        cancel: t('business.metric.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const response = selectAllAcrossPages
            ? await deleteMetricsReq(projectId, { deleteAll: true })
            : await deleteMetricsReq(projectId, {
                metricIds: Array.from(selectedMetricIds)
              })
          if (response.success) {
            const deletedCount = response.data?.deleted_count ?? count
            notifications.show({
              color: 'green',
              message: response.message || t('business.metric.bulkDeleteSuccess', { count: deletedCount })
            })
            exitBulkDeleteMode()
            await loadMetrics(currentPage, pageSize, true)
          }
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('business.metric.bulkDeleteFailed') + ': ' + error.message
          })
        }
      }
    })
  }

  const confirmDeleteMetric = (metric: any) => {
    modals.openConfirmModal({
      title: t('business.metric.confirmDeleteTitle'),
      children: t('business.metric.confirmDeleteMsg', { name: metric.name }),
      labels: {
        confirm: t('business.metric.confirm'),
        cancel: t('business.metric.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const response = await deleteMetricReq(projectId, metric.id)
          if (response.success) {
            notifications.show({ color: 'green', message: t('business.metric.deleteSuccess') })
            // Reload after deletion; return to previous page if this page had one item
            const isLastItemOnPage = metrics.length === 1
            const nextPage = isLastItemOnPage && currentPage > 1 ? currentPage - 1 : currentPage
            if (nextPage !== currentPage) setCurrentPage(nextPage)
            await loadMetrics(nextPage, pageSize)
          }
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('business.metric.deleteFailed') + ': ' + error.message
          })
        }
      }
    })
  }

  // Toggle metric active state
  const toggleMetricActive = async (metric: any, isActive: boolean) => {
    try {
      setTogglingMetricId(metric.id)
      // Ensure isActive is boolean
      const activeValue = Boolean(isActive)
      console.log('更新指标状态:', metric.id, 'is_active:', activeValue)
      // Use dedicated status update API, sending only is_active
      const response = await updateMetricStatusReq(projectId, metric.id, activeValue)
      if (response.success) {
        // Update local state
        setMetrics((prev) => prev.map((m) => (m.id === metric.id ? { ...m, is_active: activeValue } : m)))
        notifications.show({
          color: 'green',
          message: activeValue ? t('business.metric.enabled') : t('business.metric.disabled')
        })
      }
    } catch (error: any) {
      console.error('更新指标状态失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.metric.operationFailed') + ': ' + error.message
      })
    } finally {
      setTogglingMetricId(null)
    }
  }

  // Generate embedding for single metric
  const generateSingleEmbedding = async (metric: any) => {
    try {
      setGeneratingMetricId(metric.id)
      const response = await generateMetricEmbeddingsReq(projectId, metric.id)
      if (response.success) {
        notifications.show({
          color: 'green',
          message: t('business.metric.singleVectorGenSuccess', { name: metric.name })
        })
        await loadMetrics()
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.metric.singleVectorGenFailed') + ': ' + error.message
      })
    } finally {
      setGeneratingMetricId(null)
    }
  }

  const generateAllEmbeddings = async (options: { fromImport?: boolean; pendingCount?: number } = {}) => {
    try {
      const countRes = await getMetricEmbeddingPendingCountReq(projectId)
      const pendingInBusiness = countRes?.data?.pending ?? 0
      if (!pendingInBusiness || pendingInBusiness <= 0) {
        notifications.show({ color: 'yellow', message: t('business.metric.noPendingEmbedding') })
        return
      }

      // After import, "Generate now" shows count from current import; "Generate all" uses total pending in business
      const pendingForMessage =
        options.fromImport && options.pendingCount != null ? options.pendingCount : pendingInBusiness

      setGeneratingAll(true)
      setGeneratingMetricId(null)

      let waitMsg = t('business.metric.batchEmbeddingWait', { pending: pendingForMessage })
      if (options.fromImport) {
        waitMsg = t('business.metric.importEmbeddingWait', { pending: pendingForMessage })
        if (pendingInBusiness > pendingForMessage) {
          waitMsg +=
            ' ' +
            t('business.metric.importEmbeddingAlsoPendingInBusiness', {
              total: pendingInBusiness
            })
        }
      } else if (pendingInBusiness >= EMBEDDING_NGINX_HINT_THRESHOLD) {
        waitMsg += ' ' + t('business.metric.batchEmbeddingNginxHint')
      }
      notifications.show({ color: 'blue', message: waitMsg })

      const response = await generateMetricEmbeddingsReq(projectId)

      if (response?.success) {
        const d = response.data || {}
        const processedCount = typeof d.processed === 'number' ? d.processed : 0
        const countLine = t('business.metric.embeddingProcessedCount', { count: processedCount })

        if (d.completed === false) {
          const body = [response.message, countLine].filter(Boolean).join('\n')
          notifications.show({
            color: 'yellow',
            message: body,
            autoClose: 10000
          })
          await loadMetrics()
          return
        }

        if (processedCount > 0) {
          const body = [response.message, countLine].filter(Boolean).join('\n')
          notifications.show({ color: 'green', message: body })
        } else {
          notifications.show({
            color: 'green',
            message: response.message || t('business.metric.allVectorGenSuccess', { count: 0 })
          })
        }
        await loadMetrics()
      }
    } catch (error: any) {
      console.error('批量生成向量失败:', error)
      const respData = error?.data
      const processedCount = typeof respData?.processed === 'number' ? respData.processed : null
      const base = t('business.metric.batchVectorGenFailed') + ': ' + (error.message || '')
      if (processedCount !== null) {
        notifications.show({
          color: 'red',
          message: [base, t('business.metric.embeddingProcessedCount', { count: processedCount })].join('\n')
        })
      } else {
        notifications.show({ color: 'red', message: base })
      }
    } finally {
      setGeneratingAll(false)
      setGeneratingMetricId(null)
    }
  }

  const openBulkImportDialog = () => {
    setSelectedFile(null)
    setBulkImportSourceId('')
    // Reset upload component
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setBulkImportDialogVisible(true)
    // Ensure data source list is loaded
    if (dataSources.length === 0) {
      loadDataSources()
    }
  }

  // Download import template
  const downloadTemplate = () => {
    try {
      // Build sample rows
      const templateData = [
        {
          指标名称: '个人住房贷款余额',
          指标向量化内容: '',
          执行计划JSON: JSON.stringify([{
            plan_type: 'sql',
            spec: { sql_template: "SELECT SUM(balance) AS value FROM loans WHERE type = '住房贷款'" },
            evidence_policy: { require_evidence: true }
          }]),
          描述: '个人住房贷款的总余额',
          关联表: 'loans',
          关联列: 'loans.balance,loans.type'
        },
        {
          指标名称: '企业贷款总额',
          指标向量化内容: '',
          执行计划JSON: JSON.stringify([{
            plan_type: 'sql', spec: { sql_template: 'SELECT SUM(amount) AS value FROM enterprise_loans' }
          }]),
          描述: '企业贷款的总金额',
          关联表: 'enterprise_loans',
          关联列: 'enterprise_loans.amount'
        },
        {
          指标名称: '存款余额',
          指标向量化内容: '',
          执行计划JSON: JSON.stringify([{
            plan_type: 'sql', spec: { sql_template: 'SELECT SUM(balance) AS value FROM deposits' }
          }]),
          描述: '所有存款账户的总余额',
          关联表: 'deposits',
          关联列: 'deposits.balance'
        }
      ]

      // Create workbook
      const workbook = XLSX.utils.book_new()

      // Create worksheet
      const worksheet = XLSX.utils.json_to_sheet(templateData)

      // Set column widths
      worksheet['!cols'] = [
        { wch: 25 }, // Metric name
        { wch: 50 }, // Metric embedding content (precomputed embedding, optional)
        { wch: 90 }, // Execution plans JSON
        { wch: 30 }, // Description
        { wch: 20 }, // Related table
        { wch: 30 } // Related columns
      ]

      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(workbook, worksheet, '指标导入模板')

      // Save file
      XLSX.writeFile(workbook, '指标导入模板.xlsx')

      notifications.show({ color: 'green', message: t('business.metric.templateDownloadSuccess') })
    } catch (error: any) {
      console.error('下载模板失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('business.metric.downloadTemplateFailed') +
          ': ' +
          (error.message || t('business.metric.unknownError'))
      })
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null
    setSelectedFile(file)
  }

  const submitBulkImport = async () => {
    if (!selectedFile) {
      notifications.show({ color: 'yellow', message: t('business.metric.selectFileFirst') })
      return
    }

    // Validate uploaded file object
    const fileObj: any = selectedFile
    if (!(fileObj instanceof File) && !(fileObj instanceof Blob)) {
      notifications.show({ color: 'red', message: t('business.metric.invalidFileFormat') })
      return
    }

    try {
      setImporting(true)

      // Resolve source_id and source_type based on selected source
      let sourceId = ''
      let sourceType = ''

      if (bulkImportSourceId) {
        const selectedSource = dataSources.find((ds) => ds.source_id === bulkImportSourceId)
        if (selectedSource) {
          sourceId = selectedSource.source_id
          sourceType = selectedSource.source_type
        }
      }

      const response = await bulkImportMetricsReq(projectId, sourceId,
        sourceType,
        selectedFile,
        bulkImportOverwrite
      )

      if (response.success) {
        const result = response.data
        const showImportErrorDialog = () => {
          const escapeHtml = (s: any) =>
            String(s ?? '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
          const listItems = result.errors
            .map((e: any) => {
              const hasRow = e.row != null && e.row !== ''
              const hasName = e.metric_name != null && e.metric_name !== ''
              let label = ''
              if (hasRow && hasName) {
                label =
                  escapeHtml(t('business.metric.importErrorRowLabel', { row: e.row })) +
                  `「${escapeHtml(e.metric_name)}」`
              } else if (hasName) {
                label = `「${escapeHtml(e.metric_name)}」`
              } else if (hasRow) {
                label = escapeHtml(t('business.metric.importErrorRowLabel', { row: e.row }))
              }
              return `<li style="margin:6px 0;line-height:1.5"><span style="font-weight:600">${label}</span>：${escapeHtml(e.error)}</li>`
            })
            .join('')
          const errorHtml = `<ul style="margin:8px 0 0;padding-left:20px;max-height:min(60vh,420px);overflow:auto;text-align:left">${listItems}</ul>`
          modals.open({
            title: t('business.metric.partialImportFailed'),
            children: <div dangerouslySetInnerHTML={{ __html: errorHtml }} />
          })
        }

        const validationFailed =
          result.error_count > 0 &&
          result.created === 0 &&
          result.updated === 0 &&
          result.skipped === 0
        if (validationFailed) {
          notifications.show({ color: 'yellow', message: result.message })
          showImportErrorDialog()
          return
        }

        notifications.show({ color: 'green', message: result.message })
        setBulkImportDialogVisible(false)
        // State reset is handled in onClose when dialog closes
        await loadMetrics()

        // Only prompt vector generation when newly added metrics still have pending embeddings
        if (result.success_count > 0 && result.needs_embedding_prompt !== false) {
          modals.openConfirmModal({
            title: t('business.metric.generateVector'),
            children: t('business.metric.importSuccessGenVector', {
              total: result.created ?? result.success_count ?? 0,
              pending: result.pending_embedding_count ?? result.success_count ?? 0
            }),
            labels: {
              confirm: t('business.metric.generateNow'),
              cancel: t('business.metric.generateLater')
            },
            onConfirm: async () => {
              // User chooses immediate generation, call generate all embeddings
              await generateAllEmbeddings({
                fromImport: true,
                pendingCount: result.pending_embedding_count
              })
            }
          })
        }
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('business.metric.importFailed') + ': ' + error.message })
    } finally {
      setImporting(false)
    }
  }

  // Search metrics
  const handleTestSearch = async () => {
    if (!searchQuery.trim()) {
      notifications.show({ color: 'yellow', message: t('business.metric.pleaseInputSearch') })
      return
    }

    try {
      setSearching(true)
      setHasSearched(true)
      const response = await searchMetricsReq(projectId, searchQuery, 10)
      if (response.success) {
        const items = response.data?.items || []
        setSearchResults(items)
        if (items.length === 0) {
          notifications.show({ color: 'blue', message: t('business.metric.noSimilarMetrics') })
        }
      }
    } catch (error: any) {
      console.error('搜索失败:', error)
      notifications.show({ color: 'red', message: t('business.metric.searchFailed') + ': ' + error.message })
    } finally {
      setSearching(false)
    }
  }

  // Watch selectedTableColumnsConfig changes and load enum mappings (debounced)
  useEffect(() => {
    if (loadColumnMappingsTimer.current) {
      clearTimeout(loadColumnMappingsTimer.current)
    }
    loadColumnMappingsTimer.current = setTimeout(() => {
      loadColumnEnumMappings()
    }, 500)
    return () => {
      if (loadColumnMappingsTimer.current) clearTimeout(loadColumnMappingsTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableColumnsConfig])

  // Lifecycle: onMounted + watch(businessId)
  useEffect(() => {
    loadMetrics(1, pageSize, true)
    loadDataSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  // Reset search state when dialog closes
  useEffect(() => {
    if (!showSearchDialog) {
      setSearchQuery('')
      setSearchResults([])
      setHasSearched(false)
    }
  }, [showSearchDialog])

  // Reset bulk import dialog state when closed
  useEffect(() => {
    if (!bulkImportDialogVisible) {
      setSelectedFile(null)
      setBulkImportSourceId('')
      setBulkImportOverwrite(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }, [bulkImportDialogVisible])

  // Data source options
  const dataSourceOptions = useMemo(
    () => dataSources.map((ds) => ({ value: String(ds.source_id), label: ds.name })),
    [dataSources]
  )

  // Custom render: prefix icon for data source option
  const renderDataSourceOption = ({ option }: any) => {
    const ds = dataSources.find((d) => String(d.source_id) === option.value)
    return (
      <div className={styles.rowSC} style={{ gap: 8 }}>
        {ds?.type === 'database' ? <ElSvgIcon name="Connection" size={16} /> : <ElSvgIcon name="Grid" size={16} />}
        <span>{option.label}</span>
      </div>
    )
  }

  return (
    <div className={styles.tabContainer}>
      {/* Unified content card */}
      <div className={styles.contentCard}>
        {/* Top action area */}
        {metrics.length > 0 && (
          <div className={styles.operationsHeader}>
            <div className={styles.headerIntro}>
              <span>{t('business.metric.headerIntro')}</span>
            </div>
            <div className={styles.headerActions}>
              <Button
                variant="outline"
                color="red"
                disabled={bulkDeleteMode ? selectedCount === 0 : false}
                leftSection={<ElSvgIcon name="Delete" size={16} />}
                onClick={() => (bulkDeleteMode ? confirmBulkDelete() : enterBulkDeleteMode())}
              >
                {bulkDeleteMode
                  ? t('business.metric.bulkDelete') + (selectedCount > 0 ? `(${selectedCount})` : '')
                  : t('business.metric.deleteAll')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Search" size={16} />}
                onClick={() => setShowSearchDialog(true)}
              >
                {t('business.metric.searchMetric')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Plus" size={16} />}
                onClick={openAddMetricDialog}
              >
                {t('business.metric.createMetric')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Upload" size={16} />}
                onClick={openBulkImportDialog}
              >
                {t('business.metric.bulkImport')}
              </Button>
              <Button
                variant="default"
                loading={generatingAll}
                disabled={metrics.length === 0}
                leftSection={<ElSvgIcon name="Connection" size={16} />}
                onClick={() => generateAllEmbeddings()}
              >
                {t('business.metric.generateAllVectors')}
              </Button>
            </div>
          </div>
        )}

        {/* Metric list */}
        <div className={`${styles.metricsSection} metrics-section`}>
          {metrics.length === 0 ? (
            <MetricEmptyState onAddMetric={openAddMetricDialog} onBulkImport={openBulkImportDialog} />
          ) : (
            <div className={styles.metricsList}>
              {bulkDeleteMode && isAllPageSelected && !selectAllAcrossPages && totalMetrics > metrics.length && (
                <div className={styles.bulkSelectBanner}>
                  <span>{t('business.metric.selectAllPagesHint', { pageCount: metrics.length })}</span>
                  <Button variant="subtle" size="compact-sm" onClick={selectAllMetricsAcrossPages}>
                    {t('business.metric.selectAllMetricsAction', { total: totalMetrics })}
                  </Button>
                </div>
              )}
              {bulkDeleteMode && selectAllAcrossPages ? (
                <div className={styles.bulkSelectBanner}>
                  <span>{t('business.metric.selectAllMetricsDone', { total: totalMetrics })}</span>
                  <Button variant="subtle" size="compact-sm" onClick={clearAllSelection}>
                    {t('business.metric.clearSelectAllMetrics')}
                  </Button>
                </div>
              ) : (
                bulkDeleteMode &&
                hasCrossPageSelection && (
                  <div className={styles.bulkSelectBanner}>
                    <span>{t('business.metric.crossPageSelectedHint', { count: selectedCount })}</span>
                  </div>
                )
              )}

              <Table className={styles.metricsTable} verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    {bulkDeleteMode && (
                      <Table.Th style={{ width: 120, textAlign: 'center' }}>
                        <div className={styles.bulkSelectHeader} onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isAllSelected}
                            indeterminate={isIndeterminate}
                            onChange={toggleSelectAll}
                          />
                          <span className={styles.bulkSelectCancel} onClick={exitBulkDeleteMode}>
                            {t('business.metric.cancelDelete')}
                          </span>
                        </div>
                      </Table.Th>
                    )}
                    <Table.Th style={{ width: 70, textAlign: 'center' }}>{t('business.metric.enable')}</Table.Th>
                    <Table.Th style={{ minWidth: 180 }}>{t('business.metric.metricName')}</Table.Th>
                    <Table.Th style={{ minWidth: 250 }}>{t('business.metric.calcMethod')}</Table.Th>
                    <Table.Th style={{ width: 120, textAlign: 'center' }}>
                      {t('business.metric.vectorization')}
                    </Table.Th>
                    <Table.Th style={{ width: 150, textAlign: 'right' }}>{t('business.metric.actions')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {metrics.map((row) => (
                    <Table.Tr key={row.id} onClick={() => handleRowClick(row)}>
                      {bulkDeleteMode && (
                        <Table.Td style={{ textAlign: 'center' }}>
                          <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                            <Checkbox
                              checked={isSelected(row.id)}
                              onChange={(e) => setSelected(row.id, e.currentTarget.checked)}
                            />
                          </span>
                        </Table.Td>
                      )}
                      <Table.Td style={{ textAlign: 'center' }}>
                        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                          <Switch
                            size="sm"
                            checked={!!row.is_active}
                            disabled={togglingMetricId === row.id}
                            onChange={(e) => toggleMetricActive(row, e.currentTarget.checked)}
                          />
                        </span>
                      </Table.Td>
                      <Table.Td>
                        <div className={styles.nameCell}>
                          <span className={styles.nameText}>{row.name}</span>
                          {row.description && <span className={styles.nameDesc}>{row.description}</span>}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <span className={styles.sqlText}>{summarizeExecutionPlans(row)}</span>
                      </Table.Td>
                      <Table.Td>
                        <div className={styles.embeddingCell} onClick={(e) => e.stopPropagation()}>
                          <Badge color={row.has_embedding ? 'green' : 'yellow'} size="sm">
                            {row.has_embedding
                              ? t('business.metric.vectorized')
                              : t('business.metric.notVectorized')}
                          </Badge>
                          {generatingMetricId !== row.id ? (
                            <span
                              className={styles.refreshIcon}
                              title={
                                row.has_embedding
                                  ? t('business.metric.reVectorize')
                                  : t('business.metric.vectorize')
                              }
                              onClick={() => generateSingleEmbedding(row)}
                            >
                              <ElSvgIcon name="Refresh" size={14} />
                            </span>
                          ) : (
                            <span className={`${styles.refreshIcon} ${styles.loading}`}>
                              <ElSvgIcon name="Loading" size={14} />
                            </span>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <div className={styles.actionLinks} onClick={(e) => e.stopPropagation()}>
                          <span className={`${styles.actionLink} ${styles.primary}`} onClick={() => copyMetric(row)}>
                            {t('business.metric.copy')}
                          </span>
                          <span className={`${styles.actionLink} ${styles.primary}`} onClick={() => editMetric(row)}>
                            {t('business.metric.edit')}
                          </span>
                          <span
                            className={`${styles.actionLink} ${styles.danger}`}
                            onClick={() => confirmDeleteMetric(row)}
                          >
                            {t('business.metric.delete')}
                          </span>
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>

              {/* Pagination */}
              {totalMetrics > 0 && (
                <div className={styles.paginationWrapper}>
                  {/* TODO(migration): Mantine doesn't provide built-in sizes/jumper/total for el-pagination; keep page number and page size selector */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Text size="sm" c="dimmed">
                      {totalMetrics}
                    </Text>
                    {!isMobile && metricPaginationLayout.includes('sizes') && (
                      <Select
                        size="xs"
                        w={110}
                        value={String(pageSize)}
                        data={[12, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} / page` }))}
                        onChange={(val) => val && handlePageSizeChange(Number(val))}
                      />
                    )}
                    <Pagination
                      total={totalPages}
                      value={currentPage}
                      onChange={handlePageChange}
                      size={isMobile ? 'sm' : 'md'}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit metric dialog */}
      <Modal
        opened={metricDialogVisible}
        onClose={() => {
          setMetricDialogVisible(false)
          resetMetricForm()
        }}
        title={editingMetric ? t('business.metric.editMetric') : t('business.metric.createMetric')}
        size="90%"
        centered={false}
      >
        <div className={styles.metricFormRef}>
          <TextInput
            label={t('business.metric.metricName')}
            required
            value={metricForm.name}
            placeholder={t('business.metric.metricNamePlaceholder')}
            error={formErrors.name}
            onChange={(e) => setFormField({ name: e.currentTarget.value })}
            mb="md"
          />
          <TextInput
            label={t('business.metric.metricAlias')}
            value={metricForm.aliases}
            placeholder={t('business.metric.aliasPlaceholder')}
            description={t('business.metric.aliasTip')}
            onChange={(e) => setFormField({ aliases: e.currentTarget.value })}
            mb="md"
          />
          <Textarea
            label={t('business.metric.description')}
            value={metricForm.description}
            autosize
            minRows={2}
            placeholder={t('business.metric.descriptionPlaceholder')}
            onChange={(e) => setFormField({ description: e.currentTarget.value })}
            mb="md"
          />
          <Textarea
            label={t('business.metric.calcMethod')}
            required
            value={metricForm.execution_plans_json}
            autosize
            minRows={10}
            placeholder='[{"plan_type":"sql","spec":{"sql_template":"SELECT ... AS value"}}]'
            description="直接填写执行计划数组；SQL 和公式都保存在这里。"
            error={formErrors.execution_plans_json}
            onChange={(e) => setFormField({ execution_plans_json: e.currentTarget.value })}
            mb="md"
          />

          {/* Related tables and columns */}
          <div className={styles.fullWidthFormItem} style={{ marginBottom: 16 }}>
            <Text size="sm" fw={500} mb={6}>
              {t('business.metric.relatedTablesColumns')}
            </Text>
            <div className={styles.schemaSection}>
              <div className={styles.schemaSelectorHeader}>
                <Select
                  value={metricForm.source_id ? String(metricForm.source_id) : null}
                  placeholder={t('business.metric.selectDataSource')}
                  clearable
                  data={dataSourceOptions}
                  renderOption={renderDataSourceOption}
                  onChange={(val) => handleDataSourceChange(val ? val : null)}
                  style={{ width: 300 }}
                />
              </div>
              {connectionId ? (
                <TableColumnSelector
                  modelValue={selectedTableColumnsConfig}
                  databaseId={connectionId}
                  sourceType={selectedSourceType}
                  databaseConnectionId={selectedDatabaseConnectionId}
                  {...{
                    'onUpdate:modelValue': (val: any) => {
                      setSelectedTableColumnsConfig(val)
                      selectedConfigRef.current = val
                    }
                  }}
                />
              ) : (
                <div className={styles.noDatasourceHint}>
                  <Center>
                    <Text c="dimmed" size="sm">
                      {t('business.metric.selectDataSourceHint')}
                    </Text>
                  </Center>
                </div>
              )}
            </div>
          </div>

          {/* Code-value config (unified data structure) */}
          <div className={styles.fullWidthFormItem} style={{ marginBottom: 16 }}>
            <Text size="sm" fw={500} mb={6}>
              {t('business.metric.codeKnowledgeLabel')}
            </Text>
            <CodeKnowledgeConditionBuilder
              codeKnowledge={metricForm.code_knowledge}
              relatedColumns={selectedTableColumnsConfig}
              columnEnumMappings={columnEnumMappings}
              businessId={businessId}
              projectId={projectId}
              {...{
                'onUpdate:codeKnowledge': (val: any) => setFormField({ code_knowledge: val })
              }}
            />
            <Text c="dimmed" size="xs" mt={8} style={{ display: 'block' }}>
              {t('business.metric.codeKnowledgeTip')}
            </Text>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => setMetricDialogVisible(false)}>
            {t('business.metric.cancel')}
          </Button>
          <Button onClick={submitMetricForm} loading={submitting}>
            {editingMetric ? t('business.metric.save') : t('business.metric.create')}
          </Button>
        </div>
      </Modal>

      {/* Bulk import dialog */}
      <Modal
        opened={bulkImportDialogVisible}
        onClose={() => setBulkImportDialogVisible(false)}
        title={t('business.metric.bulkImportMetric')}
        size="50%"
      >
        <div className={styles.bulkImportContent}>
          <Alert color="blue" title={t('business.metric.excelFormatTitle')} mb={16}>
            <div>
              <strong>{t('business.metric.requiredColumns')}</strong>
            </div>
            <ul>
              <li>
                <strong>{t('business.metric.metricName')}</strong>: {t('business.metric.metricNameDesc')}
              </li>
              <li>
                <strong>执行计划JSON</strong>: SQL 或公式计划组成的 JSON 数组
              </li>
            </ul>
            <div>
              <strong>{t('business.metric.optionalColumns')}</strong>
            </div>
            <ul>
              <li>
                <strong>{t('business.metric.vectorizationContentColumn')}</strong>:{' '}
                {t('business.metric.vectorizationContentDesc')}
              </li>
              <li>
                <strong>{t('business.metric.description')}</strong>: {t('business.metric.descColumnDesc')}
              </li>
              <li>
                <strong>{t('business.metric.relatedTables')}</strong>: {t('business.metric.relatedTablesDesc')}
              </li>
              <li>
                <strong>{t('business.metric.relatedColumns')}</strong>: {t('business.metric.relatedColumnsDesc')}
              </li>
            </ul>
            <div style={{ marginTop: 12, color: '#909399', fontSize: 12 }}>
              <strong>{t('business.metric.noteLabel')}</strong>
              {t('business.metric.noteContent')}
            </div>
          </Alert>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
            <Button leftSection={<ElSvgIcon name="Download" size={16} />} onClick={downloadTemplate}>
              {t('business.metric.downloadTemplate')}
            </Button>
            {/* el-upload(:auto-upload=false) -> hidden input and trigger button */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <Button variant="default" onClick={() => fileInputRef.current?.click()}>
              {t('business.metric.selectExcelFile')}
            </Button>
          </div>
          {selectedFile && (
            <div className={styles.selectedFile} style={{ marginBottom: 16 }}>
              <Text>
                {t('business.metric.selectedFile')}: {selectedFile.name}
              </Text>
            </div>
          )}

          {/* Data source selection (always visible) */}
          <div style={{ marginTop: 20 }}>
            <Text size="sm" fw={500} mb={6}>
              {t('business.metric.relatedDataSource')}
            </Text>
            <Select
              value={bulkImportSourceId ? String(bulkImportSourceId) : null}
              placeholder={t('business.metric.selectDataSourceOptional')}
              clearable
              disabled={dataSources.length === 0}
              data={dataSourceOptions}
              renderOption={renderDataSourceOption}
              onChange={(val) => setBulkImportSourceId(val || '')}
              style={{ width: '100%' }}
            />
            <Text c="dimmed" size="xs" mt={8} style={{ display: 'block' }}>
              {t('business.metric.importDataSourceTip')}
            </Text>
            {dataSources.length === 0 && (
              <Text c="orange" size="xs" mt={8} style={{ display: 'block' }}>
                {t('business.metric.noAvailableDataSources')}
              </Text>
            )}
          </div>

          {/* Overwrite option */}
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center' }}>
            <Checkbox
              checked={bulkImportOverwrite}
              onChange={(e) => setBulkImportOverwrite(e.currentTarget.checked)}
              label={t('business.metric.overwriteExisting')}
            />
            <Text c="dimmed" size="xs" ml={8}>
              {t('business.metric.overwriteTip')}
            </Text>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => setBulkImportDialogVisible(false)}>
            {t('business.metric.cancel')}
          </Button>
          <Button onClick={submitBulkImport} loading={importing} disabled={!selectedFile}>
            {t('business.metric.startImport')}
          </Button>
        </div>
      </Modal>

      {/* Search metric dialog */}
      <Modal
        opened={showSearchDialog}
        onClose={() => setShowSearchDialog(false)}
        title={t('business.metric.searchMetric')}
        size="70%"
      >
        <div className={styles.searchDialogContent}>
          <TextInput
            className={styles.searchInput}
            size="lg"
            value={searchQuery}
            placeholder={t('business.metric.searchPlaceholder')}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleTestSearch()
            }}
            rightSection={
              <span
                className={`${styles.searchIconBtn} ${searching ? styles.searching : ''}`}
                onClick={handleTestSearch}
              >
                {!searching ? <ElSvgIcon name="Search" size={22} /> : <ElSvgIcon name="Loading" size={22} />}
              </span>
            }
          />

          {/* Search results */}
          {searchResults.length > 0 ? (
            <div className={styles.searchResultsList}>
              <div className={styles.resultsHeader}>
                <h4>
                  {t('business.metric.recallResults')} ({searchResults.length})
                </h4>
              </div>
              <div className={styles.resultsList}>
                {searchResults.map((result, index) => (
                  <div key={index} className={styles.resultItem} onClick={() => editMetric(result)}>
                    <div className={styles.resultHeader}>
                      <Badge size="sm" color="green">
                        {t('business.metric.similarity')}: {(result.similarity * 100).toFixed(1)}%
                      </Badge>
                    </div>
                    <div className={styles.resultBody}>
                      <div className={styles.resultName}>
                        <span className={styles.label}>{t('business.metric.metricName')}:</span>
                        <span className={styles.content}>{result.name}</span>
                      </div>
                      {result.description && (
                        <div className={styles.resultDescription}>
                          <span className={styles.label}>{t('business.metric.description')}:</span>
                          <span className={styles.content}>{result.description}</span>
                        </div>
                      )}
                      <div className={styles.resultSql}>
                        <span className={styles.label}>{t('business.metric.calcMethod')}:</span>
                        <pre className={styles.content}>{summarizeExecutionPlans(result)}</pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            hasSearched &&
            searchResults.length === 0 && (
              <div className={styles.noResults}>
                <Center>
                  <Text c="dimmed">{t('business.metric.noSimilarMetrics')}</Text>
                </Center>
              </div>
            )
          )}
        </div>
      </Modal>

      {/* Code-value documentation dialog */}
      <Modal
        opened={codeKnowledgeHelpDialogVisible}
        onClose={() => setCodeKnowledgeHelpDialogVisible(false)}
        title={t('business.metric.codeKnowledgeHelpTitle')}
        size="70%"
      >
        <div className={styles.codeKnowledgeHelpContent}>
          <Alert color="blue" title={t('business.metric.codeKnowledgeWhatTitle')} mb={16}>
            <p>{t('business.metric.codeKnowledgeWhatDesc1')}</p>
            <p>{t('business.metric.codeKnowledgeWhatDesc2')}</p>
          </Alert>

          <h3>{t('business.metric.codeKnowledgeJsonExample')}</h3>
          <Textarea
            readOnly
            autosize
            minRows={15}
            value={`{\n  "fields": [\n    {\n      "field_name": "CARD_KIND_CD",\n      "field_display_name": "卡种类",\n      "description": "银行卡种类编码",\n      "code_values": [\n        {\n          "code": "01",\n          "label": "借记卡",\n          "aliases": ["储蓄卡", "银行卡"]\n        },\n        {\n          "code": "02",\n          "label": "贷记卡",\n          "aliases": ["信用卡"]\n        },\n        {\n          "code": "03",\n          "label": "绿卡通",\n          "aliases": []\n        }\n      ]\n    }\n  ],\n  "common_filters": [\n    {\n      "description": "查询绿卡通",\n      "condition": "CARD_KIND_CD = \\"03\\"",\n      "user_keywords": ["绿卡通", "绿卡通卡"]\n    },\n    {\n      "description": "查询借记卡",\n      "condition": "CARD_KIND_CD IN (\\"01\\", \\"03\\")",\n      "user_keywords": ["借记卡", "储蓄卡"]\n    }\n  ]\n}`}
            styles={{ input: { fontFamily: 'monospace' } }}
            mb={16}
          />

          <h3>{t('business.metric.codeKnowledgeFieldDesc')}</h3>
          {/* el-descriptions has no Mantine equivalent; use Table to render field descriptions */}
          <Table withTableBorder withColumnBorders>
            <Table.Tbody>
              {[
                ['fields', t('business.metric.codeKnowledgeFieldsDesc')],
                ['field_name', t('business.metric.codeKnowledgeFieldNameDesc')],
                ['field_display_name', t('business.metric.codeKnowledgeDisplayNameDesc')],
                ['description', t('business.metric.codeKnowledgeDescriptionDesc')],
                ['code_values', t('business.metric.codeKnowledgeCodeValuesDesc')],
                ['code', t('business.metric.codeKnowledgeCodeDesc')],
                ['label', t('business.metric.codeKnowledgeLabelDesc')],
                ['aliases', t('business.metric.codeKnowledgeAliasesDesc')],
                ['common_filters', t('business.metric.codeKnowledgeCommonFiltersDesc')],
                ['description', t('business.metric.codeKnowledgeConditionDescDesc')],
                ['condition', t('business.metric.codeKnowledgeConditionDesc')],
                ['user_keywords', t('business.metric.codeKnowledgeUserKeywordsDesc')]
              ].map(([label, desc], i) => (
                <Table.Tr key={i}>
                  <Table.Th style={{ width: 180, whiteSpace: 'nowrap' }}>{label}</Table.Th>
                  <Table.Td>{desc}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Alert color="yellow" title={t('business.metric.codeKnowledgeTipTitle')} mt={16}>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>{t('business.metric.codeKnowledgeTip1')}</li>
              <li>{t('business.metric.codeKnowledgeTip2')}</li>
              <li>{t('business.metric.codeKnowledgeTip3')}</li>
            </ul>
          </Alert>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button onClick={() => setCodeKnowledgeHelpDialogVisible(false)}>{t('business.metric.gotIt')}</Button>
        </div>
      </Modal>
    </div>
  )
}
