// Standard entities view
// Source: views/business/components/EntityManager/index.vue
// Notes:
// - el-pagination => custom pagination row (total text + page-size Select + Mantine Pagination + jumper)
// - Replace ElMessageBox.prompt (exact text confirmation + one-click fill button) with a controlled ConfirmDeleteModal, preserving original i18n keys and validation logic
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Group, LoadingOverlay, NumberInput, Pagination, Select, Text, TextInput, Modal, Button, Stack } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'

import { useResponsive } from '@/hooks/use-responsive'

// API
import {
  createEntityConfigReq,
  getEntityConfigsReq,
  deleteEntityConfigReq,
  updateEntityConfigReq,
  searchEntitiesReq,
  generateEntityEmbeddingsReq,
  createColumnNameEntitiesReq,
  testEntityAgentReq,
  batchRevertAutoPromotedEntitiesReq,
} from '@/api/business-semantic'

// Composables
import { useDataSource } from './composables/useDataSource'

// Components
import EntityToolbar from './components/EntityToolbar'
import EntityList from './components/EntityList'
import EmptyState from './components/EmptyState'
import AddColumnValueDialog from './components/dialogs/AddColumnValueDialog'
import ColumnNameDialog from './components/dialogs/ColumnNameDialog'
import SearchTestDialog from './components/dialogs/SearchTestDialog'
import EditRuleDialog from './components/dialogs/EditRuleDialog'

import styles from './index.module.scss'

export interface EntityManagerProps {
  projectId: string
  businessId: string
}

// Internal state for controlled ElMessageBox.prompt replacement modal
interface DeletePromptState {
  open: boolean
  title: string // Modal title
  hint: string // confirmInputHint text
  expected: string // Exact text required for confirmation (e.g., table.column or tableName)
  placeholder: string // Input placeholder
  onConfirm: () => void // Delete callback after validation passes
}

export default function EntityManager(props: EntityManagerProps) {
  const { projectId, businessId } = props
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // Use composables
  const {
    availableDataSources,
    selectedDataSource,
    loadingDataSources,
    allTables,
    loadAvailableDataSources,
    loadTables,
    loadTableColumns,
    handleDataSourceChange: changeDataSource,
  } = useDataSource(projectId)

  // State
  const [entityMappings, setEntityMappings] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [savingColumnNameEntities, setSavingColumnNameEntities] = useState(false)

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [loadingMappings, setLoadingMappings] = useState(false)

  // Dialog visibility
  const [addEntityDialogVisible, setAddEntityDialogVisible] = useState(false)
  const [columnNameDialogVisible, setColumnNameDialogVisible] = useState(false)
  const [searchDialogVisible, setSearchDialogVisible] = useState(false)
  const [editRuleDialogVisible, setEditRuleDialogVisible] = useState(false)

  // Search state
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [agentTesting, setAgentTesting] = useState(false)
  const [agentResult, setAgentResult] = useState<any>(null)

  // Edit rule state
  const [editingRuleConfig, setEditingRuleConfig] = useState<any>(null)
  const [savingRule, setSavingRule] = useState(false)

  // Loading states
  const [togglingConfig, setTogglingConfig] = useState<any>(null)
  const [generatingTableColumn, setGeneratingTableColumn] = useState<any>(null)
  const [generatingColumnNameTable, setGeneratingColumnNameTable] = useState<any>(null)
  const [deletingTableColumn, setDeletingTableColumn] = useState<any>(null)
  const [deletingColumnNameTable, setDeletingColumnNameTable] = useState<any>(null)

  // Auto-generated entity filter (D.3)
  const [showAutoPromotedOnly, setShowAutoPromotedOnly] = useState(false)

  const paginationLayout = useMemo(
    () => (isMobile ? 'total, prev, pager, next' : 'total, sizes, prev, pager, next, jumper'),
    [isMobile]
  )

  // Computed: column_value configs grouped by table
  const groupedColumnValueMappings = useMemo(() => {
    const grouped: Record<string, any> = {}
    entityMappings
      .filter((config: any) => config.entity_type === 'column_value')
      .forEach((config: any) => {
        const tableName = config.table_name
        if (!grouped[tableName]) {
          grouped[tableName] = {
            table_name: tableName,
            configs: [],
            totalEntities: 0,
          }
        }
        grouped[tableName].configs.push(config)
        grouped[tableName].totalEntities += config.entity_count || 0
      })
    return Object.values(grouped)
  }, [entityMappings])

  const groupedColumnNameMappings = useMemo(() => {
    return entityMappings
      .filter((config: any) => config.entity_type === 'column_name')
      .map((config: any) => ({
        id: config.id,
        table_name: config.table_name,
        columns: config.columns || [], // Use returned columns field (contains column_name and description)
        vector_status: config.vector_status,
        vector_error: config.vector_error,
        entity_count: config.entity_count || 0,
        is_active: config.is_active !== false,
      }))
  }, [entityMappings])

  const mergedEntityMappings = useMemo(() => {
    const result: any[] = []
    groupedColumnValueMappings.forEach((table: any) => {
      result.push({
        ...table,
        type: 'column_value',
        key: `cv-${table.table_name}`,
      })
    })
    groupedColumnNameMappings.forEach((table: any) => {
      result.push({
        ...table,
        type: 'column_name',
        key: `cn-${table.table_name}`,
      })
    })
    return result
  }, [groupedColumnValueMappings, groupedColumnNameMappings])

  // Whether any config has auto_promoted=true
  const hasAutoPromoted = useMemo(
    () =>
      entityMappings.some((config: any) => {
        if (config.auto_promoted === true) return true
        // column_name auto-promotion flag may be stored in columns array
        if (Array.isArray(config.columns) && config.columns.some((c: any) => c.auto_promoted)) return true
        return false
      }),
    [entityMappings]
  )

  // Display list after applying filter
  const displayedEntityMappings = useMemo(() => {
    if (!showAutoPromotedOnly) return mergedEntityMappings
    return mergedEntityMappings
      .map((table: any) => {
        if (table.type === 'column_value') {
          const filtered = (table.configs || []).filter((c: any) => c.auto_promoted)
          if (!filtered.length) return null
          // Recalculate totalEntities to match filtered configs
          const totalEntities = filtered.reduce((sum: number, c: any) => sum + (c.entity_count || 0), 0)
          return { ...table, configs: filtered, totalEntities }
        }
        if (table.type === 'column_name') {
          const filteredCols = (table.columns || []).filter((c: any) => c.auto_promoted)
          if (!filteredCols.length) return null
          return { ...table, columns: filteredCols }
        }
        return null
      })
      .filter(Boolean)
  }, [showAutoPromotedOnly, mergedEntityMappings])

  function handleToggleAutoPromotedFilter(v: any) {
    setShowAutoPromotedOnly(!!v)
  }

  // ====== In-progress polling ======
  const pollingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // Keep latest entityMappings in a ref for polling callbacks (avoid stale closure values)
  const entityMappingsRef = useRef<any[]>(entityMappings)
  entityMappingsRef.current = entityMappings

  // Methods
  const loadEntityMappings = useCallback(
    async (page?: number, size?: number) => {
      const p = page ?? currentPage
      const s = size ?? pageSize
      try {
        setLoadingMappings(true)
        const res = await getEntityConfigsReq(projectId, p, s)
        if (res.success) {
          setEntityMappings(res.data.items || [])
          setTotal(res.data.total || 0)
          setCurrentPage(p)
          setPageSize(s)
        }
      } catch (error) {
        console.error('加载标准名词失败:', error)
      } finally {
        setLoadingMappings(false)
      }
    },
    [projectId, businessId, currentPage, pageSize]
  )

  const startPollingIfNeeded = useCallback(() => {
    if (pollingTimer.current) return
    if (!entityMappingsRef.current.some((c: any) => c.vector_status === '生成中')) return
    pollingTimer.current = setInterval(async () => {
      await loadEntityMappings()
      if (!entityMappingsRef.current.some((c: any) => c.vector_status === '生成中')) {
        if (pollingTimer.current) {
          clearInterval(pollingTimer.current)
          pollingTimer.current = null
        }
      }
    }, 5000)
  }, [loadEntityMappings])

  const stopPolling = useCallback(() => {
    if (pollingTimer.current) {
      clearInterval(pollingTimer.current)
      pollingTimer.current = null
    }
  }, [])

  // onMounted + onUnmounted
  useEffect(() => {
    ;(async () => {
      await loadEntityMappings()
      startPollingIfNeeded()
    })()
    return () => {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Batch revert auto-generated entities
  async function handleBatchRevertAutoPromoted() {
    if (!hasAutoPromoted) {
      notifications.show({ color: 'blue', message: t('business.entity.batchRevertEmpty', '当前没有自动生成的实体配置') })
      return
    }
    try {
      const res = await batchRevertAutoPromotedEntitiesReq(projectId)
      if (res.success) {
        const count = res.data?.reverted_count ?? res.data?.count ?? 0
        notifications.show({ color: 'green', message: t('business.entity.batchRevertSuccess', { count }) })
        await loadEntityMappings()
      } else {
        notifications.show({
          color: 'yellow',
          message: res.msg || t('business.entity.batchRevertPendingBackend', '后端 API 开发中,暂不可用'),
        })
      }
    } catch (error: any) {
      // Backend API missing (404) or permission/network exception: do not block user, only show notice
      const status = error?.response?.status
      if (status === 404 || status === 501) {
        notifications.show({
          color: 'yellow',
          message: t('business.entity.batchRevertPendingBackend', '后端 API 开发中,暂不可用'),
        })
      } else {
        notifications.show({
          color: 'red',
          message: error?.response?.data?.message || error?.message || 'Batch revert failed',
        })
      }
    }
  }

  // Pagination events
  const handlePageChange = (page: number) => {
    loadEntityMappings(page, pageSize)
  }

  const handleSizeChange = (size: number) => {
    loadEntityMappings(1, size)
  }

  const handleDataSourceChange = async (source: any) => {
    await changeDataSource(source)
  }

  const handleSelectTable = async (table: any) => {
    if (!table.columns || table.columns.length === 0) {
      table.columns = await loadTableColumns(table.id)
    }
  }

  // Open dialogs
  const openAddEntityDialog = async () => {
    setAddEntityDialogVisible(true)
    await loadAvailableDataSources()
    if (selectedDataSource) {
      await loadTables()
    }
  }

  const openColumnNameDialog = async () => {
    setColumnNameDialogVisible(true)
    await loadAvailableDataSources()
    if (selectedDataSource) {
      await loadTables()
    }
  }

  const openSearchDialog = () => {
    setSearchDialogVisible(true)
    setSearchKeyword('')
    setSearchResults([])
    setHasSearched(false)
    setAgentResult(null)
  }

  const openEditRuleDialog = (config: any) => {
    setEditingRuleConfig(config)
    setEditRuleDialogVisible(true)
  }

  // Save methods
  const saveColumnValueEntities = async (configs: any[]) => {
    if (configs.length === 0) return

    setSaving(true)
    try {
      for (const config of configs) {
        await createEntityConfigReq(projectId, {
          source_id: config.source_id,
          source_type: config.source_type,
          table_id: config.table_id,
          column_name: config.column_name,
          metadata_fields: config.metadata_fields?.length > 0 ? config.metadata_fields : null,
          rule: config.rule?.trim() || null,
        })
      }
      notifications.show({
        color: 'green',
        message: t('business.entity.createColumnValueSuccess', { count: configs.length }),
      })
      setAddEntityDialogVisible(false)
      await loadEntityMappings()
    } catch (error) {
      console.error('创建数据名词失败:', error)
    } finally {
      setSaving(false)
    }
  }

  const saveColumnNameEntities = async (configs: any[]) => {
    if (configs.length === 0) return

    setSavingColumnNameEntities(true)
    try {
      // Resolve data source type
      const sourceType = selectedDataSource?.type || 'database'

      // Group by table, keeping column names and descriptions
      const tableGroups: Record<string, any[]> = {}
      for (const config of configs) {
        if (!tableGroups[config.table_id]) {
          tableGroups[config.table_id] = []
        }
        tableGroups[config.table_id].push({
          column_name: config.column_name,
          description: config.entity_name !== config.column_name ? config.entity_name : null,
        })
      }

      let totalCount = 0
      for (const [tableId, columns] of Object.entries(tableGroups)) {
        const res = await createColumnNameEntitiesReq(projectId, tableId, sourceType, columns)
        if (res.success) {
          totalCount += res.data.count || columns.length
        } else {
          notifications.show({
            color: 'red',
            message: res.msg || t('business.entity.createColumnNamePartialFail'),
          })
        }
      }

      notifications.show({
        color: 'green',
        message: t('business.entity.createColumnNameSuccess', { count: totalCount }),
      })
      setColumnNameDialogVisible(false)
      await loadEntityMappings()
    } catch (error) {
      console.error('创建字段名词失败:', error)
    } finally {
      setSavingColumnNameEntities(false)
    }
  }

  const saveRule = async (ruleValue: any) => {
    if (savingRule || !editingRuleConfig) return

    setSavingRule(true)
    try {
      const res = await updateEntityConfigReq(projectId, editingRuleConfig.id, {
        rule: ruleValue,
      })
      if (res.success) {
        notifications.show({ color: 'green', message: t('business.entity.ruleUpdated') })
        setEditRuleDialogVisible(false)
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.ruleUpdateFailed') })
      }
    } catch (error: any) {
      console.error('更新规则描述失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.ruleUpdateFailed') + ': ' + error.message })
    } finally {
      setSavingRule(false)
    }
  }

  // Toggle active state
  const toggleConfigActive = async (config: any, isActive: boolean) => {
    setTogglingConfig(config.id)
    try {
      const res = await updateEntityConfigReq(projectId, config.id, {
        is_active: isActive,
      })
      if (res.success) {
        notifications.show({
          color: 'green',
          message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
        })
        // Keep local sync state consistent (legacy source updated config.is_active directly; React updates via entityMappings)
        setEntityMappings((prev) =>
          prev.map((c: any) => (c.id === config.id ? { ...c, is_active: isActive } : c))
        )
      } else {
        // Rollback
        setEntityMappings((prev) =>
          prev.map((c: any) => (c.id === config.id ? { ...c, is_active: !isActive } : c))
        )
        notifications.show({ color: 'red', message: res.msg || t('business.entity.updateStatusFailed') })
      }
    } catch (error: any) {
      setEntityMappings((prev) =>
        prev.map((c: any) => (c.id === config.id ? { ...c, is_active: !isActive } : c))
      )
      console.error('更新激活状态失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.updateStatusFailed') + ': ' + error.message })
    } finally {
      setTogglingConfig(null)
    }
  }

  const toggleColumnNameConfigActive = async (table: any, isActive: boolean) => {
    setTogglingConfig(table.id)
    try {
      const res = await updateEntityConfigReq(projectId, table.id, {
        is_active: isActive,
      })
      if (res.success) {
        setEntityMappings((prev) =>
          prev.map((c: any) => (c.id === table.id ? { ...c, is_active: isActive } : c))
        )
        notifications.show({
          color: 'green',
          message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
        })
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.updateStatusFailed') })
        await loadEntityMappings()
      }
    } catch (error: any) {
      console.error('更新激活状态失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.updateStatusFailed') + ': ' + error.message })
      await loadEntityMappings()
    } finally {
      setTogglingConfig(null)
    }
  }

  // Generate embeddings
  const generateTableColumnEmbeddings = async (configId: any) => {
    try {
      setGeneratingTableColumn(configId)
      const res = await generateEntityEmbeddingsReq(projectId, configId)
      if (res.success) {
        notifications.show({
          color: 'green',
          message: res.data.message || t('business.entity.generateVectorSuccess'),
        })
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.generateVectorFailed') })
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.generateVectorFailed') + ': ' + error.message })
    } finally {
      setGeneratingTableColumn(null)
    }
  }

  const generateColumnNameEmbeddings = async (configId: any) => {
    try {
      setGeneratingColumnNameTable(configId)
      const res = await generateEntityEmbeddingsReq(projectId, configId)
      if (res.success) {
        notifications.show({
          color: 'green',
          message: res.data.message || t('business.entity.generateColumnNameVectorSuccess'),
        })
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.generateVectorFailed') })
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.generateVectorFailed') + ': ' + error.message })
    } finally {
      setGeneratingColumnNameTable(null)
    }
  }

  // ====== Delete confirmation dialog (replacement for ElMessageBox.prompt) ======
  const [deletePrompt, setDeletePrompt] = useState<DeletePromptState>({
    open: false,
    title: '',
    hint: '',
    expected: '',
    placeholder: '',
    onConfirm: () => {},
  })
  const [deleteInput, setDeleteInput] = useState('')
  const [deleteError, setDeleteError] = useState('')

  const closeDeletePrompt = () => {
    setDeletePrompt((s) => ({ ...s, open: false }))
    setDeleteInput('')
    setDeleteError('')
  }

  const confirmDeletePrompt = () => {
    // Exact-text validation (matches ElMessageBox inputPattern: ^expected$)
    if (deleteInput !== deletePrompt.expected) {
      setDeleteError(t('business.entity.inputExactConfirmText', { text: deletePrompt.expected }))
      return
    }
    const cb = deletePrompt.onConfirm
    closeDeletePrompt()
    cb()
  }

  const confirmDeleteTableColumnEntities = (config: any) => {
    const { id, table_name: tableName, column_name: columnName } = config
    const expectedConfirmation = `${tableName}.${columnName}`
    setDeleteInput('')
    setDeleteError('')
    setDeletePrompt({
      open: true,
      title: t('business.entity.confirmDeleteColumnValue'),
      hint: t('business.entity.confirmInputHint'),
      expected: expectedConfirmation,
      placeholder: t('business.entity.inputConfirmText'),
      onConfirm: async () => {
        const key = `${tableName}-${columnName}`
        setDeletingTableColumn(key)
        try {
          const response = await deleteEntityConfigReq(projectId, id)
          if (response.success) {
            notifications.show({
              color: 'green',
              message: t('business.entity.deleteColumnValueSuccess', { table: tableName, column: columnName }),
            })
            await loadEntityMappings()
          } else {
            notifications.show({ color: 'red', message: response.msg || t('business.entity.deleteConfigFailed') })
          }
        } finally {
          setDeletingTableColumn(null)
        }
      },
    })
  }

  const confirmDeleteColumnNameTable = (table: any) => {
    const { id, table_name: tableName } = table
    setDeleteInput('')
    setDeleteError('')
    setDeletePrompt({
      open: true,
      title: t('business.entity.confirmDeleteColumnName'),
      hint: t('business.entity.confirmInputHint'),
      expected: tableName,
      placeholder: t('business.entity.inputTableNameConfirm'),
      onConfirm: async () => {
        setDeletingColumnNameTable(tableName)
        try {
          const response = await deleteEntityConfigReq(projectId, id)
          if (response.success) {
            notifications.show({
              color: 'green',
              message: t('business.entity.deleteColumnNameSuccess', { table: tableName }),
            })
            await loadEntityMappings()
          } else {
            notifications.show({ color: 'red', message: response.msg || t('business.entity.deleteFailed') })
          }
        } catch (error: any) {
          console.error('删除字段名词失败:', error)
          notifications.show({
            color: 'red',
            message: t('business.entity.deleteColumnNameError') + ': ' + error.message,
          })
        } finally {
          setDeletingColumnNameTable(null)
        }
      },
    })
  }

  // Search methods
  const handleVectorSearch = async () => {
    if (!searchKeyword.trim()) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseInputSearchKeyword') })
      return
    }

    setSearchResults([])
    setAgentResult(null)
    setSearching(true)
    setHasSearched(true)

    try {
      const res = await searchEntitiesReq(projectId, searchKeyword.trim(), 10)
      if (res.success) {
        const items = res.data.items || res.data || []
        setSearchResults(items)
        if (items.length > 0) {
          notifications.show({
            color: 'green',
            message: t('business.entity.foundSimilarEntities', { count: items.length }),
          })
        } else {
          notifications.show({ color: 'blue', message: t('business.entity.noSimilarEntities') })
        }
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.searchFailed') })
        setSearchResults([])
      }
    } catch (error) {
      console.error('搜索失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.searchFailed') })
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleAgentTest = async () => {
    if (!searchKeyword.trim()) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseInputTestQuestion') })
      return
    }

    setSearchResults([])
    setAgentResult(null)
    setHasSearched(false)
    setAgentTesting(true)

    try {
      const res = await testEntityAgentReq(projectId, searchKeyword.trim())
      if (res.success) {
        setAgentResult({
          original_question: searchKeyword.trim(),
          rewritten_question: res.data.user_message || searchKeyword.trim(),
          entities: res.data.entities || [],
        })
        if (res.data.entities && res.data.entities.length > 0) {
          notifications.show({
            color: 'green',
            message: t('business.entity.agentReplacedEntities', { count: res.data.entities.length }),
          })
        } else {
          notifications.show({ color: 'blue', message: t('business.entity.noEntitiesRecognized') })
        }
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.agentTestFailed') })
      }
    } catch (error: any) {
      console.error('Agent 测试失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('business.entity.agentTestFailed') + ': ' + (error.message || t('business.entity.unknownError')),
      })
    } finally {
      setAgentTesting(false)
    }
  }

  const clearSearchResults = () => {
    setSearchResults([])
    setHasSearched(false)
  }

  const clearAgentResult = () => {
    setAgentResult(null)
  }

  // Parse pagination layout from el-pagination layout field to decide visible elements
  const showSizes = paginationLayout.includes('sizes')
  const showJumper = paginationLayout.includes('jumper')
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className={styles.tabContainer}>
      <div className={`${styles.contentCard} ${styles.entityManagerContent}`}>
        {/* Top action area (hidden in true empty state, which has its own add CTA; shown when loading or when entries exist) */}
        {(loadingMappings || entityMappings.length > 0) && (
        <EntityToolbar
          hasEntities={entityMappings.length > 0}
          hasAutoPromoted={hasAutoPromoted}
          showAutoPromotedOnly={showAutoPromotedOnly}
          onAddColumnValue={openAddEntityDialog}
          onAddColumnName={openColumnNameDialog}
          onSearchTest={openSearchDialog}
          onToggleAutoPromotedFilter={handleToggleAutoPromotedFilter}
          onBatchRevertAutoPromoted={handleBatchRevertAutoPromoted}
        />
        )}

        {/* Configured standard entity list */}
        <div className={styles.configuredEntitiesSection}>
          {displayedEntityMappings.length > 0 ? (
              // v-loading="loadingMappings" -> LoadingOverlay (requires relative positioned container)
            <Box pos="relative">
              <LoadingOverlay visible={loadingMappings} zIndex={10} />
              <EntityList
                mergedEntityMappings={displayedEntityMappings}
                togglingConfig={togglingConfig}
                generatingTableColumn={generatingTableColumn}
                generatingColumnNameTable={generatingColumnNameTable}
                deletingTableColumn={deletingTableColumn}
                deletingColumnNameTable={deletingColumnNameTable}
                onEditRule={openEditRuleDialog}
                onToggleConfigActive={toggleConfigActive}
                onToggleColumnNameActive={toggleColumnNameConfigActive}
                onGenerateEmbeddings={generateTableColumnEmbeddings}
                onGenerateColumnNameEmbeddings={generateColumnNameEmbeddings}
                onDeleteColumnValue={confirmDeleteTableColumnEntities}
                onDeleteColumnNameTable={confirmDeleteColumnNameTable}
              />
            </Box>
          ) : !loadingMappings ? (
            <EmptyState onAddColumnValue={openAddEntityDialog} onAddColumnName={openColumnNameDialog} />
          ) : null}
        </div>

        {/* Pagination (fixed at bottom) */}
        {total > 0 && (
          <div className={styles.paginationWrapper}>
            <Group gap="md" wrap="wrap" align="center" justify="center">
              {/* Total text */}
              <Text size="sm" c="dimmed">
                {t('common.total', '共')} {total}
              </Text>

              {/* Page-size selector */}
              {showSizes && (
                <Select
                  size="xs"
                  w={110}
                  data={[10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n}/page` }))}
                  value={String(pageSize)}
                  onChange={(v) => v && handleSizeChange(Number(v))}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: true }}
                />
              )}

              {/* prev / pager / next */}
              <Pagination
                size={isMobile ? 'sm' : 'md'}
                total={totalPages}
                value={currentPage}
                onChange={handlePageChange}
                withControls
              />

              {/* jumper */}
              {showJumper && (
                <Group gap={4} align="center">
                  <Text size="sm" c="dimmed">
                    {t('common.goto', '前往')}
                  </Text>
                  <NumberInput
                    size="xs"
                    w={64}
                    min={1}
                    max={totalPages}
                    hideControls
                    value={currentPage}
                    onChange={(v) => {
                      const page = Number(v)
                      if (page >= 1 && page <= totalPages) handlePageChange(page)
                    }}
                  />
                </Group>
              )}
            </Group>
          </div>
        )}
      </div>

      {/* Add column-value entity dialog */}
      <AddColumnValueDialog
        visible={addEntityDialogVisible}
        onUpdateVisible={setAddEntityDialogVisible}
        availableDataSources={availableDataSources}
        selectedDataSource={selectedDataSource}
        loadingDataSources={loadingDataSources}
        allTables={allTables}
        saving={saving}
        onChangeDataSource={handleDataSourceChange}
        onSelectTable={handleSelectTable}
        onSave={saveColumnValueEntities}
      />

      {/* Add column-name entity dialog */}
      <ColumnNameDialog
        visible={columnNameDialogVisible}
        onUpdateVisible={setColumnNameDialogVisible}
        availableDataSources={availableDataSources}
        selectedDataSource={selectedDataSource}
        loadingDataSources={loadingDataSources}
        allTables={allTables}
        saving={savingColumnNameEntities}
        onChangeDataSource={handleDataSourceChange}
        onSelectTable={handleSelectTable}
        onSave={saveColumnNameEntities}
      />

      {/* Search test dialog */}
      <SearchTestDialog
        visible={searchDialogVisible}
        onUpdateVisible={setSearchDialogVisible}
        keyword={searchKeyword}
        onUpdateKeyword={setSearchKeyword}
        searching={searching}
        agentTesting={agentTesting}
        searchResults={searchResults}
        agentResult={agentResult}
        hasSearched={hasSearched}
        onVectorSearch={handleVectorSearch}
        onAgentTest={handleAgentTest}
        onClearResults={clearSearchResults}
        onClearAgentResult={clearAgentResult}
      />

      {/* Edit rule dialog */}
      <EditRuleDialog
        visible={editRuleDialogVisible}
        onUpdateVisible={setEditRuleDialogVisible}
        config={editingRuleConfig}
        saving={savingRule}
        onSave={saveRule}
      />

      {/* Delete confirmation dialog (replace ElMessageBox.prompt: exact text input + one-click fill) */}
      <Modal
        opened={deletePrompt.open}
        onClose={closeDeletePrompt}
        title={deletePrompt.title}
        centered
        zIndex={3000}
      >
        <Stack gap="sm">
          <Group gap={6} align="center" wrap="wrap">
            <Text size="sm">
              {deletePrompt.hint}
              <strong>{deletePrompt.expected}</strong>
            </Text>
            {/* One-click fill button (corresponds to fillBtn in original HTML) */}
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => {
                setDeleteInput(deletePrompt.expected)
                setDeleteError('')
              }}
            >
              {t('business.entity.fillBtn')}
            </Button>
          </Group>
          <TextInput
            placeholder={deletePrompt.placeholder}
            value={deleteInput}
            error={deleteError || undefined}
            onChange={(e) => {
              setDeleteInput(e.currentTarget.value)
              if (deleteError) setDeleteError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmDeletePrompt()
            }}
            data-autofocus
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={closeDeletePrompt}>
              {t('business.entity.cancel')}
            </Button>
            <Button color="red" onClick={confirmDeletePrompt}>
              {t('business.entity.confirmDelete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  )
}
