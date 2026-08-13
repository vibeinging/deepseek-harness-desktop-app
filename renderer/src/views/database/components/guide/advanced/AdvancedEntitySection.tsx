import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  suggestEntityColumnsReq,
  generateDatasourceEntityEmbeddingsReq,
  getEntityMappingConfigsReq,
  deleteEntityMappingConfigReq,
  updateEntityMappingConfigReq,
  createEntityMappingConfigReq,
  getTableColumnsReq,
  searchDatasourceEntitiesReq,
  batchCreateEntityConfigsReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import EntitySuggestDialog from './EntitySuggestDialog'
import EntityList from '@/views/business/components/EntityManager/components/EntityList'
import EditRuleDialog from '@/views/business/components/EntityManager/components/dialogs/EditRuleDialog'
import AddColumnValueDialog from '@/views/business/components/EntityManager/components/dialogs/AddColumnValueDialog'
import SearchTestDialog from '@/views/business/components/EntityManager/components/dialogs/SearchTestDialog'
import styles from './AdvancedEntitySection.module.scss'

interface AdvancedEntitySectionProps {
  databaseId?: string | null
  disabled?: boolean
  tables?: any[]
  // defineEmits(['config-changed', 'suggesting-changed'])
  onConfigChanged?: (count: number) => void
  onSuggestingChanged?: (suggesting: boolean) => void
}

  // Methods/properties exposed to parent component via defineExpose
export interface AdvancedEntitySectionHandle {
  handleSuggest: () => void
  handleSearchTest: () => void
  openAddDialog: () => Promise<void>
  autoSuggestAndCreate: () => Promise<boolean>
  autoGenerateEmbeddings: () => Promise<boolean>
  loadExistingConfigs: () => Promise<void>
  entityConfigCount: number
  entityEmbeddingsDone: boolean
}

function AdvancedEntitySectionInner(
  props: AdvancedEntitySectionProps,
  ref: React.Ref<AdvancedEntitySectionHandle>
) {
  const { databaseId = null, tables = [], onConfigChanged, onSuggestingChanged } = props
  const { t } = useTranslation()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  // State
  const [suggesting, setSuggesting] = useState(false)
  const [suggestDialogVisible, setSuggestDialogVisible] = useState(false)
  const [, setGeneratingEmbeddings] = useState(false)
  const [existingConfigs, setExistingConfigs] = useState<any[]>([])
  const [entityEmbeddingsDone, setEntityEmbeddingsDone] = useState(false)

  // Edit rule dialog
  const [editRuleDialogVisible, setEditRuleDialogVisible] = useState(false)
  const [editingRuleConfig, setEditingRuleConfig] = useState<any>(null)
  const [savingRule, setSavingRule] = useState(false)

  // Loading states for EntityList
  const [togglingConfigId, setTogglingConfigId] = useState<any>(null)
  const [generatingConfigId, setGeneratingConfigId] = useState<any>(null)
  const [deletingConfigId] = useState<any>(null)

  // Add dialog
  const [addDialogVisible, setAddDialogVisible] = useState(false)
  const [addCreating, setAddCreating] = useState(false)
  const [addAllTables, setAddAllTables] = useState<any[]>([])
  const [addInitialConfigs, setAddInitialConfigs] = useState<any[]>([])

  // Search test
  const [searchTestVisible, setSearchTestVisible] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [hasSearched, setHasSearched] = useState(false)

  // Keep latest values in refs to avoid stale closures from polling/imperative handlers; same as Vue's .value access
  const existingConfigsRef = useRef<any[]>([])
  existingConfigsRef.current = existingConfigs
  const databaseIdRef = useRef(databaseId)
  databaseIdRef.current = databaseId
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId
  const onConfigChangedRef = useRef(onConfigChanged)
  onConfigChangedRef.current = onConfigChanged

  // Notify parent component when suggesting changes (equivalent to watch suggesting -> emit suggesting-changed)
  useEffect(() => {
    onSuggestingChanged?.(suggesting)
  }, [suggesting, onSuggestingChanged])

  // ====== Vector-generation status polling ======
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isGeneratingVectorStatus = (status: any) =>
    ['生成中', 'Generating', 'generating'].includes(status)

  // Load existing configs
  const loadExistingConfigs = useCallback(async () => {
    if (!databaseIdRef.current) return
    try {
      const res = await getEntityMappingConfigsReq(currentProjectIdRef.current, databaseIdRef.current)
      if (res.success && res.data) {
        const list = Array.isArray(res.data) ? res.data : res.data.items || []
        setExistingConfigs(list)
        setEntityEmbeddingsDone(
          list.length > 0 && list.every((c: any) => c.has_embedding !== false)
        )
      }
    } catch (error) {
      console.error('Failed to load entity configs:', error)
    }
  }, [])

  const startPollingIfNeeded = useCallback(() => {
    if (pollingTimerRef.current) return
    if (!existingConfigsRef.current.some((c) => isGeneratingVectorStatus(c.vector_status))) return
    pollingTimerRef.current = setInterval(async () => {
      await loadExistingConfigs()
      if (!existingConfigsRef.current.some((c) => isGeneratingVectorStatus(c.vector_status))) {
        if (pollingTimerRef.current) clearInterval(pollingTimerRef.current)
        pollingTimerRef.current = null
      }
    }, 5000)
  }, [loadExistingConfigs])

  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
  }, [])

  // ── computed ──
  const addDataSources = useMemo(() => {
    if (!databaseId) return []
    return [{ id: databaseId, name: '', type: 'database' }]
  }, [databaseId])
  const addSelectedDataSource = useMemo(() => addDataSources[0] || null, [addDataSources])

  const entityConfigCount = existingConfigs.length

  const mergedEntityMappings = useMemo(() => {
    const groups: Record<string, any> = {}
    for (const config of existingConfigs) {
      const entityType = config.entity_type || 'column_value'
      const tableName =
        config.schema_name && config.schema_name !== 'default'
          ? `${config.schema_name}.${config.table_name}`
          : config.table_name
      const key = `${entityType}-${tableName}`
      if (!groups[key]) {
        groups[key] = {
          table_name: tableName,
          type: entityType,
          key,
          configs: [],
          totalEntities: 0,
          columns: [],
          entity_count: 0,
          vector_status: null,
          is_active: true
        }
      }
      if (entityType === 'column_value') {
        groups[key].configs.push(config)
        groups[key].totalEntities += config.entity_count || 0
      } else {
        groups[key].columns.push({
          column_name: config.column_name,
          description: config.column_description
        })
        groups[key].entity_count += config.entity_count || 0
        groups[key].vector_status = config.vector_status
        groups[key].is_active = config.is_active !== false
        groups[key].id = config.id
      }
    }
    return Object.values(groups)
  }, [existingConfigs])

  // ── handlers ──
  const handleSearchTest = useCallback(() => {
    setSearchTestVisible(true)
  }, [])

  const handleVectorSearch = useCallback(async () => {
    if (!searchKeyword.trim() || !databaseIdRef.current) return
    setSearching(true)
    setHasSearched(true)
    setSearchResults([])
    try {
      const res = await searchDatasourceEntitiesReq(
        currentProjectIdRef.current,
        databaseIdRef.current,
        searchKeyword.trim(),
        10
      )
      if (res.success) {
        setSearchResults(res.data.items || res.data || [])
      }
    } catch (error) {
      console.error('搜索失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.searchFailed') })
    } finally {
      setSearching(false)
    }
  }, [searchKeyword, t])

  // Suggest
  const handleSuggest = useCallback(() => {
    if (!databaseIdRef.current) return
    setSuggestDialogVisible(true)
  }, [])

  const handleSuggestCreated = useCallback(async () => {
    await loadExistingConfigs()
    startPollingIfNeeded()
    onConfigChangedRef.current?.(existingConfigsRef.current.length)
  }, [loadExistingConfigs, startPollingIfNeeded])

  // Edit rule
  const openEditRuleDialog = useCallback((config: any) => {
    setEditingRuleConfig(config)
    setEditRuleDialogVisible(true)
  }, [])

  const handleSaveRule = useCallback(
    async (ruleValue: any) => {
      if (!editingRuleConfig) return
      setSavingRule(true)
      try {
        const res = await updateEntityMappingConfigReq(
          currentProjectIdRef.current,
          databaseIdRef.current,
          editingRuleConfig.id,
          { rule: ruleValue }
        )
        if (res.success) {
          notifications.show({ message: t('database.guide.advanced.editSuccess') })
          setEditRuleDialogVisible(false)
          await loadExistingConfigs()
        }
      } catch (error) {
        console.error('Update rule failed:', error)
        notifications.show({ color: 'red', message: t('database.guide.advanced.editError') })
      } finally {
        setSavingRule(false)
      }
    },
    [editingRuleConfig, loadExistingConfigs, t]
  )

  // Toggle active
  const handleToggleActive = useCallback(
    async (config: any, isActive: boolean) => {
      setTogglingConfigId(config.id)
      try {
        await updateEntityMappingConfigReq(
          currentProjectIdRef.current,
          databaseIdRef.current,
          config.id,
          { is_active: isActive }
        )
      } catch (error) {
        console.error('Toggle active failed:', error)
        config.is_active = !isActive
        notifications.show({ color: 'red', message: t('database.guide.advanced.editError') })
      } finally {
        setTogglingConfigId(null)
      }
    },
    [t]
  )

  // Generate embedding for single config
  const handleGenerateSingleEmbedding = useCallback(
    async (configId: any) => {
      setGeneratingConfigId(configId)
      try {
        const res = await generateDatasourceEntityEmbeddingsReq(
          currentProjectIdRef.current,
          databaseIdRef.current,
          configId
        )
        if (res.success) {
          notifications.show({ message: t('database.guide.advanced.entityVectorComplete') })
          await loadExistingConfigs()
        }
      } catch (error) {
        console.error('Generate embedding failed:', error)
        notifications.show({ color: 'red', message: t('database.guide.advanced.entityVectorError') })
      } finally {
        setGeneratingConfigId(null)
      }
    },
    [loadExistingConfigs, t]
  )

  // Add dialog
  const openAddDialog = useCallback(async () => {
    setAddInitialConfigs([])
    setAddAllTables([...(tables || [])])
    setAddDialogVisible(true)
  }, [tables])

  const handleAddSelectTable = useCallback(async (table: any) => {
    if (!table.columns || table.columns.length === 0) {
      try {
        const res = await getTableColumnsReq(
          currentProjectIdRef.current,
          databaseIdRef.current,
          table.id
        )
        if (res.success && res.data) {
          table.columns = Array.isArray(res.data) ? res.data : res.data.items || []
        }
      } catch (error) {
        console.error('Load columns failed:', error)
      }
    }
  }, [])

  const handleAddSave = useCallback(
    async (configs: any[]) => {
      if (configs.length === 0) return
      setAddCreating(true)
      let successCount = 0
      let failCount = 0
      try {
        for (const config of configs) {
          try {
            await createEntityMappingConfigReq(
              currentProjectIdRef.current,
              databaseIdRef.current,
              config.table_id,
              config.column_name,
              config.metadata_fields?.length > 0 ? config.metadata_fields : null,
              config.rule?.trim() || null
            )
            successCount++
          } catch (err) {
            failCount++
            console.error(`Create entity config failed for ${config.column_name}:`, err)
          }
        }
        if (successCount > 0) {
          notifications.show({ message: t('database.guide.advanced.addSuccess') })
        }
        if (failCount > 0 && successCount === 0) {
          notifications.show({ color: 'red', message: t('database.guide.advanced.addError') })
        }
      } catch (err) {
        console.error('handleAddSave unexpected error:', err)
      } finally {
        setAddDialogVisible(false)
        setAddCreating(false)
        await loadExistingConfigs()
        onConfigChangedRef.current?.(existingConfigsRef.current.length)
      }
    },
    [loadExistingConfigs, t]
  )

  // Delete config
  const handleDeleteConfig = useCallback(
    async (config: any) => {
      modals.openConfirmModal({
        children: t('database.guide.advanced.confirmDeleteEntity'),
        labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          try {
            const res = await deleteEntityMappingConfigReq(
              currentProjectIdRef.current,
              databaseIdRef.current,
              config.id
            )
            if (res.success) {
              notifications.show({ message: t('database.guide.advanced.deleteSuccess') })
              await loadExistingConfigs()
              onConfigChangedRef.current?.(existingConfigsRef.current.length)
            }
      } catch (e) {
            // ignore
          }
        }
      })
    },
    [loadExistingConfigs, t]
  )

  // Public methods for parent
  const autoSuggestAndCreate = useCallback(async (): Promise<boolean> => {
    setSuggesting(true)
    try {
      const res = await suggestEntityColumnsReq(currentProjectIdRef.current, databaseIdRef.current, {
        min_score: 0.4
      })
      if (res.success && res.data) {
        const items = (res.data.items || res.data || []).filter(
          (item: any) => !item.already_exists && item.score >= 0.5
        )
        if (items.length > 0) {
          const columns = items.map((item: any) => ({
            table_id: item.table_id,
            column_name: item.column_name,
            schema_name: item.schema_name || null
          }))
          await batchCreateEntityConfigsReq(
            currentProjectIdRef.current,
            databaseIdRef.current,
            columns,
            null
          )
        }
        await loadExistingConfigs()
        onConfigChangedRef.current?.(existingConfigsRef.current.length)
        return true
      }
    } catch (error) {
      console.error('Auto suggest and create failed:', error)
    } finally {
      setSuggesting(false)
    }
    return false
  }, [loadExistingConfigs])

  const autoGenerateEmbeddings = useCallback(async (): Promise<boolean> => {
    setGeneratingEmbeddings(true)
    try {
      await generateDatasourceEntityEmbeddingsReq(
        currentProjectIdRef.current,
        databaseIdRef.current,
        null
      )
      setEntityEmbeddingsDone(true)
      await loadExistingConfigs()
      return true
    } catch (error) {
      console.error('Auto generate embeddings failed:', error)
    } finally {
      setGeneratingEmbeddings(false)
    }
    return false
  }, [loadExistingConfigs])

  // Expose methods to parent
  useImperativeHandle(
    ref,
    () => ({
      handleSuggest,
      handleSearchTest,
      openAddDialog,
      autoSuggestAndCreate,
      autoGenerateEmbeddings,
      loadExistingConfigs,
      entityConfigCount,
      entityEmbeddingsDone
    }),
    [
      handleSuggest,
      handleSearchTest,
      openAddDialog,
      autoSuggestAndCreate,
      autoGenerateEmbeddings,
      loadExistingConfigs,
      entityConfigCount,
      entityEmbeddingsDone
    ]
  )

  // onMounted
  useEffect(() => {
    ;(async () => {
      await loadExistingConfigs()
      startPollingIfNeeded()
    })()
    // onUnmounted -> stopPolling
    return () => {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Watch databaseId
  const isFirstDbWatch = useRef(true)
  useEffect(() => {
    if (isFirstDbWatch.current) {
      isFirstDbWatch.current = false
      return
    }
    stopPolling()
    if (databaseId) {
      ;(async () => {
        await loadExistingConfigs()
        startPollingIfNeeded()
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  // Watch addDialogVisible: refresh list after dialog closes as a fallback
  const prevAddDialogVisible = useRef(addDialogVisible)
  useEffect(() => {
    const oldVal = prevAddDialogVisible.current
    prevAddDialogVisible.current = addDialogVisible
    if (!addDialogVisible && oldVal) {
      ;(async () => {
        await loadExistingConfigs()
        startPollingIfNeeded()
        onConfigChangedRef.current?.(existingConfigsRef.current.length)
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addDialogVisible])

  return (
    <div className={styles.entitySection}>
      {/* Existing config list */}
      {mergedEntityMappings.length > 0 && (
        <div className={styles.existingPanel}>
          <EntityList
            {...({
              mergedEntityMappings,
              togglingConfig: togglingConfigId,
              generatingTableColumn: generatingConfigId,
              deletingTableColumn: deletingConfigId,
              onEditRule: openEditRuleDialog,
              onToggleConfigActive: handleToggleActive,
              onGenerateEmbeddings: handleGenerateSingleEmbedding,
              onDeleteColumnValue: handleDeleteConfig
            } as any)}
          />
        </div>
      )}

      {/* Empty state: visual explanation of entity config */}
      {existingConfigs.length === 0 && !suggesting && (
        <div className={styles.emptyState}>
          {/* Core concept demo */}
          <div className={styles.conceptDemo}>
            <div className={styles.demoFlow}>
              {/* User input */}
              <div className={`${styles.flowNode} ${styles.flowInput}`}>
                <span className={styles.flowLabel}>
                  {t('database.guide.entity.flowUserQuery')}
                </span>
                <div className={styles.queryBubble}>
                  <span className={styles.queryPrefix}>Q</span>
                  <span className={styles.queryText}>
                    {t('database.guide.entity.flowQueryBefore')}
                    <mark>{t('database.guide.entity.flowEntityWord')}</mark>
                    {t('database.guide.entity.flowQueryAfter')}
                  </span>
                </div>
              </div>

              {/* Flow connector */}
              <div className={styles.flowConnector}>
                <svg width="40" height="2" viewBox="0 0 40 2">
                  <line
                    x1="0"
                    y1="1"
                    x2="32"
                    y2="1"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                  />
                  <polygon points="32,0 40,1 32,2" fill="currentColor" />
                </svg>
              </div>

              {/* AI recognition */}
              <div className={`${styles.flowNode} ${styles.flowRecognize}`}>
                <span className={styles.flowLabel}>
                  {t('database.guide.entity.flowEntityMatch')}
                </span>
                <div className={styles.recognizeBox}>
                  <span className={styles.recognizeEntity}>
                    "{t('database.guide.entity.flowEntityWord')}"
                  </span>
                  <svg className={styles.recognizeArrow} width="16" height="16" viewBox="0 0 16 16">
                    <path
                      d="M3 8h8M8 5l3 3-3 3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <div className={styles.recognizeTarget}>
                    <code className={styles.recognizeColumn}>
                      {t('database.guide.entity.flowColumnName')}
                    </code>
                    <span className={styles.recognizeValue}>
                      {t('database.guide.entity.flowMatchedValue')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Flow connector */}
              <div className={styles.flowConnector}>
                <svg width="40" height="2" viewBox="0 0 40 2">
                  <line
                    x1="0"
                    y1="1"
                    x2="32"
                    y2="1"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                  />
                  <polygon points="32,0 40,1 32,2" fill="currentColor" />
                </svg>
              </div>

              {/* Generate SQL */}
              <div className={`${styles.flowNode} ${styles.flowOutput}`}>
                <span className={styles.flowLabel}>
                  {t('database.guide.entity.flowAutoFilter')}
                </span>
                <div className={styles.sqlBox}>
                  <code>
                    <span className={styles.sqlKw}>WHERE</span>{' '}
                    {t('database.guide.entity.flowColumnName')} ={' '}
                    <span className={styles.sqlVal}>
                      '{t('database.guide.entity.flowMatchedValue')}'
                    </span>
                  </code>
                </div>
              </div>
            </div>
          </div>

          {/* Helper text */}
          <div className={styles.emptyExplain}>
            <p className={styles.explainMain}>{t('database.guide.entity.emptyDesc')}</p>
            <p className={styles.explainHint}>{t('database.guide.entity.emptyHint')}</p>
          </div>
        </div>
      )}

      {/* Suggestion dialog (table selection, analysis, and result confirmation) */}
      <EntitySuggestDialog
        {...({
          modelValue: suggestDialogVisible,
          'onUpdate:modelValue': (v: boolean) => setSuggestDialogVisible(v),
          databaseId,
          tables,
          onCreated: handleSuggestCreated
        } as any)}
      />

      {/* Edit rule dialog */}
      <EditRuleDialog
        visible={editRuleDialogVisible}
        onUpdateVisible={(v: boolean) => setEditRuleDialogVisible(v)}
        config={editingRuleConfig}
        saving={savingRule}
        onSave={handleSaveRule}
      />

      {/* Add or edit dialog */}
      <AddColumnValueDialog
        visible={addDialogVisible}
        onUpdateVisible={(v: boolean) => setAddDialogVisible(v)}
        availableDataSources={addDataSources}
        selectedDataSource={addSelectedDataSource}
        loadingDataSources={false}
        allTables={addAllTables}
        initialConfigs={addInitialConfigs}
        saving={addCreating}
        onChangeDataSource={() => {}}
        onSelectTable={handleAddSelectTable}
        onSave={handleAddSave}
      />

      {/* Search test dialog */}
      <SearchTestDialog
        visible={searchTestVisible}
        onUpdateVisible={(v: boolean) => setSearchTestVisible(v)}
        keyword={searchKeyword}
        onUpdateKeyword={(v: string) => setSearchKeyword(v)}
        searching={searching}
        agentTesting={false}
        searchResults={searchResults}
        agentResult={null}
        hasSearched={hasSearched}
        onVectorSearch={handleVectorSearch}
        onClearResults={() => {
          setSearchResults([])
          setHasSearched(false)
        }}
        onClearAgentResult={() => {}}
      />
    </div>
  )
}

const AdvancedEntitySection = forwardRef<AdvancedEntitySectionHandle, AdvancedEntitySectionProps>(
  AdvancedEntitySectionInner
)
AdvancedEntitySection.displayName = 'AdvancedEntitySection'

export default AdvancedEntitySection
