import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Modal, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconCoin,
  IconEdit,
  IconLink,
  IconFileDescription,
  IconFolderOpen,
  IconWand,
  IconTrash
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { updateDatabaseReq, generateDatabaseDescriptionReq } from '@/api/database'
import { projectGetters, useProjectStore } from '@/store/project'
import DatabaseConnectionForm, {
  type DatabaseConnectionFormHandle
} from './DatabaseConnectionForm'
import styles from './DatabaseConnectionInfo.module.scss'

// defineProps({ database }) + defineEmits(['delete', 'database-updated'])
interface DatabaseConnectionInfoProps {
  database: Record<string, any>
  onDelete?: (database: any) => void
  onDatabaseUpdated?: (database: any) => void
}

export default function DatabaseConnectionInfo({
  database,
  onDelete,
  onDatabaseUpdated
}: DatabaseConnectionInfoProps) {
  const { t } = useTranslation()

  // projectStore.currentProjectId
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const [descriptionEditMode, setDescriptionEditMode] = useState(false)
  const [generatingDatabaseDesc, setGeneratingDatabaseDesc] = useState(false)
  const [savingDbDesc, setSavingDbDesc] = useState(false)
  const [databaseDescription, setDatabaseDescription] = useState('')

  // watch(() => props.database?.description, ..., { immediate: true })
  // Sync external description only when not in edit mode
  useEffect(() => {
    if (!descriptionEditMode) {
      setDatabaseDescription(database?.description || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database?.description])

  // Parse schema config
  const schemaConfig = useMemo<any>(() => {
    if (!database.schema_config) return null
    try {
      return JSON.parse(database.schema_config)
    } catch (e) {
      console.warn('解析schema_config失败:', e)
      return null
    }
  }, [database.schema_config])

  // Parse extra config
  const extraConfig = useMemo<any>(() => {
    if (!database.extra_config) return null
    try {
      return JSON.parse(database.extra_config)
    } catch (e) {
      console.warn('解析extra_config失败:', e)
      return null
    }
  }, [database.extra_config])

  // Edit dialog state
  const [editDialogVisible, setEditDialogVisible] = useState(false)
  const editFormRef = useRef<DatabaseConnectionFormHandle>(null)
  // editForm is passed as initialData to DatabaseConnectionForm
  const [editForm, setEditForm] = useState<Record<string, any>>({
    id: -1,
    name: '',
    host: '',
    username: '',
    password: '',
    database: '',
    port: '',
    db_type: '',
    description: '',
    retrieval_mode: 'table',
    table_limit: 5,
    sqlite_attached_dbs: [],
    schema_config: null,
    extra_config: null,
    default_schema: '',
    available_schemas: [],
    supports_multiple_schemas: false
  })

  // Edit database
  const handleEdit = () => {
    // Parse schema_config
    let schemaData: Record<string, any> = {
      default_schema: '',
      available_schemas: [],
      supports_multiple_schemas: false
    }

    if (database.schema_config) {
      try {
        const parsed = JSON.parse(database.schema_config)
        schemaData = {
          default_schema: parsed.default_schema || '',
          available_schemas: parsed.available_schemas || [],
          supports_multiple_schemas: parsed.supports_multiple_schemas || false
        }
      } catch (e) {
        console.warn('解析schema_config失败:', e)
      }
    }

    // Parse extra_config
    let retrievalMode = 'table'
    let tableLimit = 5
    if (database.extra_config) {
      try {
        const parsed = JSON.parse(database.extra_config)
        retrievalMode = parsed.retrieval_mode || 'table'
        tableLimit = parsed.table_limit || 5
      } catch (e) {
        console.warn('解析extra_config失败:', e)
      }
    }

    // Copy database info into the edit form
    setEditForm({
      id: database.id,
      name: database.name,
      host: database.host,
      username: database.username,
      password: '', // Do not echo back password
      database: database.database,
      port: database.port,
      db_type: database.db_type,
      description: database.description || '',
      retrieval_mode: retrievalMode,
      table_limit: tableLimit,
      sqlite_attached_dbs: database.sqlite_attached_dbs || [],
      schema_config: database.schema_config,
      extra_config: database.extra_config,
      ...schemaData
    })

    setEditDialogVisible(true)
  }

  const handleToggleEditDescription = () => {
    if (descriptionEditMode) {
      setDatabaseDescription(database?.description || '')
      setDescriptionEditMode(false)
      return
    }
    setDatabaseDescription(database?.description || '')
    setDescriptionEditMode(true)
  }

  const handleSaveDatabaseDescription = async () => {
    if (!currentProjectId || !database?.id) return
    setSavingDbDesc(true)
    try {
      const res: any = await updateDatabaseReq(currentProjectId, {
        id: database.id,
        description: databaseDescription
      })
      if (res.success) {
        notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescSaved') })
        setDescriptionEditMode(false)
        onDatabaseUpdated?.({
          ...database,
          ...(res.data || {}),
          description: databaseDescription
        })
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.guide.metadata.dbDescSaveFailed')
        })
      }
    } catch (error) {
      console.error('保存数据库描述失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.metadata.dbDescSaveFailed') })
    } finally {
      setSavingDbDesc(false)
    }
  }

  const handleGenerateDatabaseDescription = async () => {
    if (!currentProjectId || !database?.id) return
    setGeneratingDatabaseDesc(true)
    try {
      const res: any = await generateDatabaseDescriptionReq(currentProjectId, database.id)
      if (res.success && res.data) {
        setDatabaseDescription(res.data.description || databaseDescription)
        notifications.show({
          color: 'green',
          message: t('database.guide.metadata.dbDescGenerateComplete')
        })
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('database.guide.metadata.dbDescGenerateFailed')
        })
      }
    } catch (error) {
      console.error('生成数据库描述失败:', error)
      notifications.show({
        color: 'red',
        message: t('database.guide.metadata.dbDescGenerateFailed')
      })
    } finally {
      setGeneratingDatabaseDesc(false)
    }
  }

  // Handle successful edit save
  // Note: onSaved callback from migrated DatabaseConnectionForm passes through databaseId
  const handleEditSaved = (databaseId: string | null) => {
    setEditDialogVisible(false)
    notifications.show({ color: 'green', message: t('database.connInfo.updateSuccess') })

  // Notify parent component that database was updated to trigger refresh
    onDatabaseUpdated?.({
      id: databaseId ?? database.id
    })
  }

  // Delete database
  const handleDelete = () => {
    modals.openConfirmModal({
      title: t('database.connInfo.deleteConfirmTitle'),
      children: t('database.connInfo.deleteConfirmMsg', { name: database.name }),
      labels: {
        confirm: t('database.connInfo.confirmDelete'),
        cancel: t('database.action.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        onDelete?.(database)
      }
    })
  }

  const retrievalModeLabel =
    extraConfig?.retrieval_mode === 'table'
      ? t('database.connInfo.tableRetrieval')
      : extraConfig?.retrieval_mode === 'column'
        ? t('database.connInfo.columnRetrieval')
        : t('database.connInfo.tableRetrieval')

  return (
    <div className={`${styles.settingsRoot} tab-container`}>
          {/* Unified content card */}
      <div className={`${styles.settingsCard} content-card`}>
          {/* Header action area */}
        <div className={styles.operationsHeader}>
          <div className={styles.headerTitle}>
            <IconCoin size={20} color="var(--dsh-accent, #6366f1)" />
            <h3>{database.name}</h3>
            <span className={styles.dbTypeBadge}>{database.db_type}</span>
          </div>
          <div className={styles.headerActions}>
            <Button
              variant="default"
              size="sm"
              leftSection={<IconEdit size={16} />}
              onClick={handleEdit}
            >
              {t('database.connInfo.editConnection')}
            </Button>
            <Button
              variant="light"
              color="red"
              size="sm"
              leftSection={<IconTrash size={16} />}
              onClick={handleDelete}
            >
              {t('database.action.delete')}
            </Button>
          </div>
        </div>

          {/* Content area */}
        <div className={`${styles.settingsScroll} scrollable-content`}>
          {/* Connection and authentication info */}
          <div className={`${styles.infoSection} connection-section`}>
            <div className={styles.sectionHeader}>
              <IconLink size={18} color="var(--dsh-accent, #6366f1)" />
              <span>{t('database.connInfo.connectionAuth')}</span>
            </div>
            <div className={styles.sectionContent}>
              <div className={styles.infoColumns}>
                <div className={styles.infoColumn}>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.connInfo.hostAddress')}</span>
                    <span className={styles.infoValue}>{database.host}</span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.info.port')}</span>
                    <span className={styles.infoValue}>{database.port}</span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.connInfo.databaseName')}</span>
                    <span className={styles.infoValue}>{database.database}</span>
                  </div>

              {/* Retrieval mode */}
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.connInfo.retrievalMode')}</span>
                    <span className={styles.infoValue}>
                      <Badge
                        color={extraConfig?.retrieval_mode === 'column' ? 'green' : 'blue'}
                        size="sm"
                      >
                        {retrievalModeLabel}
                      </Badge>
                    </span>
                  </div>

                  {/* Table retrieval count: shown only in table retrieval mode */}
                  {extraConfig?.retrieval_mode !== 'column' && (
                    <div className={styles.infoItem}>
                      <span className={styles.infoLabel}>
                        {t('database.connInfo.tableRetrievalCount')}
                      </span>
                      <span className={styles.infoValue}>{extraConfig?.table_limit || 5}</span>
                    </div>
                  )}
                </div>
                <div className={styles.infoColumn}>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.info.username')}</span>
                    <span className={styles.infoValue}>{database.username}</span>
                  </div>
                  <div className={styles.infoItem}>
                    <span className={styles.infoLabel}>{t('database.form.password')}</span>
                    <span className={`${styles.infoValue} ${styles.passwordMask}`}>••••••••</span>
                  </div>

                  {/* Schema configuration info (PostgreSQL/Oracle) */}
                  {schemaConfig &&
                    schemaConfig.supports_multiple_schemas &&
                    schemaConfig.default_schema && (
                      <div className={styles.infoItem}>
                        <span className={styles.infoLabel}>
                          {t('database.connInfo.defaultSchema')}
                        </span>
                        <span className={styles.infoValue}>{schemaConfig.default_schema}</span>
                      </div>
                    )}

                  {/* SQLite attached databases (SQLite only) */}
                  {database.db_type === 'SQLite' &&
                    database.sqlite_attached_dbs?.length > 0 && (
                      <div className={styles.attachedDbs}>
                        <div className={styles.attachedHeader}>
                          <IconFolderOpen size={14} color="var(--dsh-accent, #6366f1)" />
                          <span>{t('database.connInfo.attachedDatabases')}</span>
                        </div>
                        {database.sqlite_attached_dbs.map((db: any, index: number) => (
                          <div className={styles.infoItem} key={index}>
                            <span className={styles.infoLabel}>{db.alias}</span>
                            <span className={styles.infoValue}>{db.path}</span>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            </div>
          </div>

          {/* Description section */}
          <div className={`${styles.infoSection} description-section`}>
            <div className={styles.sectionHeader}>
              <IconFileDescription size={18} color="var(--dsh-accent, #6366f1)" />
              <span>{t('database.connInfo.descriptionInfo')}</span>
              <Button
                variant="transparent"
                size="compact-sm"
                className={styles.aiGenerateBtn}
                leftSection={<IconEdit size={14} />}
                onClick={handleToggleEditDescription}
              >
                {descriptionEditMode ? t('database.action.cancel') : t('database.action.edit')}
              </Button>
            </div>
            <div className={styles.sectionContent}>
              {descriptionEditMode ? (
                <div className={styles.descriptionEditor}>
                  <Textarea
                    value={databaseDescription}
                    onChange={(e) => setDatabaseDescription(e.currentTarget.value)}
                    autosize
                    minRows={4}
                    maxRows={8}
                    placeholder={t('database.guide.metadata.dbDescPlaceholder')}
                    disabled={savingDbDesc}
                  />
                  <div className={styles.descriptionActions}>
                    <Button
                      variant="default"
                      size="xs"
                      loading={generatingDatabaseDesc}
                      disabled={savingDbDesc}
                      leftSection={<IconWand size={14} />}
                      onClick={handleGenerateDatabaseDescription}
                    >
                      {t('database.guide.metadata.aiGenerate')}
                    </Button>
                    <Button
                      color="green"
                      size="xs"
                      loading={savingDbDesc}
                      onClick={handleSaveDatabaseDescription}
                    >
                      {t('database.action.save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={styles.descriptionText}>
                  {databaseDescription || t('database.connInfo.noDescription')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

	      {/* Edit database dialog */}
      <Modal
        opened={editDialogVisible}
        onClose={() => setEditDialogVisible(false)}
        title={t('database.connInfo.editDbConnection')}
        size="80%"
        closeOnClickOutside={false}
        yOffset="1vh"
        className={styles.editModal}
      >
        <DatabaseConnectionForm
          ref={editFormRef}
          initialData={editForm}
          onSaved={handleEditSaved}
          onCancel={() => setEditDialogVisible(false)}
        />
      </Modal>
    </div>
  )
}
