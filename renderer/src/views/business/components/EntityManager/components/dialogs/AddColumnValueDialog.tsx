import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Center,
  Group,
  Modal,
  MultiSelect,
  Select,
  Text,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import TableSelector from '../table-selectors/TableSelector'
import ColumnSelector from '../table-selectors/ColumnSelector'
import styles from './AddColumnValueDialog.module.scss'

// No strong types are available for data source/table/column structures, so use any
interface DataSource {
  id?: any
  name?: string
  type?: string
  db_type?: string
  [key: string]: any
}

interface TableColumn {
  column_name: string
  description?: string
  [key: string]: any
}

interface TableItem {
  id?: any
  table_name?: string
  columns?: TableColumn[]
  [key: string]: any
}

interface EntityConfig {
  source_id?: any
  source_type?: string
  table_id?: any
  table_name?: string
  column_name?: string
  description?: string
  metadata_fields?: string[]
  rule?: string
  [key: string]: any
}

export interface AddColumnValueDialogProps {
  visible?: boolean
  availableDataSources?: DataSource[]
  selectedDataSource?: DataSource | null
  loadingDataSources?: boolean
  allTables?: TableItem[]
  initialConfigs?: EntityConfig[]
  saving?: boolean
  // defineEmits → callback props
  onUpdateVisible?: (val: boolean) => void
  onChangeDataSource?: (source?: DataSource) => void
  onSelectTable?: (table: TableItem) => void
  onSave?: (configs: EntityConfig[]) => void
}

export default function AddColumnValueDialog(props: AddColumnValueDialogProps) {
  const {
    visible = false,
    availableDataSources = [],
    selectedDataSource = null,
    loadingDataSources = false,
    allTables = [],
    initialConfigs = [],
    saving = false,
    onUpdateVisible,
    onChangeDataSource,
    onSelectTable,
    onSave,
  } = props
  const { t } = useTranslation()

  // dialogVisible: computed get/set → controlled visible + onUpdateVisible
  const setDialogVisible = (val: boolean) => onUpdateVisible?.(val)

  const [activeTableId, setActiveTableId] = useState<any>(null)
  const [entityConfigs, setEntityConfigs] = useState<EntityConfig[]>([])

  const activeTableName = useMemo(() => {
    const table = allTables.find((tb) => tb.id === activeTableId)
    return table?.table_name || ''
  }, [allTables, activeTableId])

  const currentTableColumns = useMemo(() => {
    const table = allTables.find((tb) => tb.id === activeTableId)
    return table?.columns || []
  }, [allTables, activeTableId])

  const disabledColumns = useMemo(() => {
    return entityConfigs
      .filter((c) => c.table_id === activeTableId)
      .map((c) => c.column_name)
  }, [entityConfigs, activeTableId])

  // table_id for each config that has selected columns (duplicates indicate multiple columns)
  const selectedTableIds = useMemo(() => {
    return entityConfigs.map((c) => c.table_id)
  }, [entityConfigs])

  const handleDataSourceChange = (id: any) => {
    const source = availableDataSources.find((s) => s.id === id)
    setActiveTableId(null)
    setEntityConfigs([])
    onChangeDataSource?.(source)
  }

  const handleTableSelect = (table: TableItem) => {
    if (activeTableId === table.id) return
    setActiveTableId(table.id)
    onSelectTable?.(table)
  }

  const handleColumnSelect = (column: TableColumn) => {
    const source = selectedDataSource
    const table = allTables.find((tb) => tb.id === activeTableId)
    const defaultRule = column.description || ''

    setEntityConfigs((prev) => [
      ...prev,
      {
        source_id: source?.id,
        source_type: source?.type === 'database' ? 'database' : 'structured',
        table_id: activeTableId,
        table_name: table?.table_name || '',
        column_name: column.column_name,
        description: column.description,
        metadata_fields: [],
        rule: defaultRule,
      },
    ])
  }

  const removeConfig = (index: number) => {
    setEntityConfigs((prev) => prev.filter((_, i) => i !== index))
  }

  // Update one field of a specific config
  const updateConfigField = (index: number, field: keyof EntityConfig, value: any) => {
    setEntityConfigs((prev) =>
      prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    )
  }

  const getTableColumnsForMetadata = (tableId: any, excludeColumnName?: string): TableColumn[] => {
    const table = allTables.find((tb) => tb.id === tableId)
    if (!table || !table.columns) return []
    return table.columns.filter((col) => col.column_name !== excludeColumnName)
  }

  const selectAllMetadata = (index: number) => {
    const config = entityConfigs[index]
    const availableColumns = getTableColumnsForMetadata(config.table_id, config.column_name)
    updateConfigField(index, 'metadata_fields', availableColumns.map((col) => col.column_name))
  }

  const clearAllMetadata = (index: number) => {
    updateConfigField(index, 'metadata_fields', [])
  }

  const handleCancel = () => {
    setDialogVisible(false)
    setEntityConfigs([])
    setActiveTableId(null)
  }

  const handleSave = () => {
    if (entityConfigs.length === 0) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseSelectColumn') })
      return
    }
    onSave?.([...entityConfigs])
  }

  // Reset when dialog opens (watch props.visible)
  useEffect(() => {
    if (visible) {
      // Pre-fill with initialConfigs if provided (for example, from AI suggestions)
      if (initialConfigs && initialConfigs.length > 0) {
        setEntityConfigs(initialConfigs.map((c) => ({ ...c })))
        // Auto-select the first table that has pre-filled configs
        const firstConfigTableId = initialConfigs[0]?.table_id
        const targetTable = allTables.find((tb) => tb.id === firstConfigTableId)
        if (targetTable) {
          handleTableSelect(targetTable)
        } else if (allTables.length > 0) {
          handleTableSelect(allTables[0])
        }
      } else {
        setEntityConfigs([])
        setActiveTableId(null)
        if (allTables.length > 0) {
          handleTableSelect(allTables[0])
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // Auto-select first table when tables are loaded (watch props.allTables)
  useEffect(() => {
    if (allTables.length > 0 && !activeTableId && visible) {
      handleTableSelect(allTables[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTables])

  return (
    <Modal
      opened={visible}
      onClose={() => setDialogVisible(false)}
      title={t('business.entity.addColumnValueTitle')}
      size="85%"
      closeOnClickOutside={false}
      className="business-entity-dialog"
      styles={{ content: { marginTop: '5vh' } }}
    >
      {/* Data source selector */}
      {availableDataSources.length > 0 && (
        <div className={styles.dataSourceSelector}>
          <span className={styles.selectorLabel}>{t('business.entity.selectDataSource')}</span>
          <Select
            value={selectedDataSource?.id != null ? String(selectedDataSource.id) : null}
            onChange={(val) => {
              const source = availableDataSources.find((s) => String(s.id) === val)
              handleDataSourceChange(source?.id)
            }}
            placeholder={t('business.entity.selectDataSourcePlaceholder')}
            className={styles.dataSourceSelectField}
            disabled={loadingDataSources}
            data={availableDataSources.map((source) => ({
              value: String(source.id),
              label: source.name || '',
            }))}
            renderOption={({ option }) => {
              const source = availableDataSources.find((s) => String(s.id) === option.value)
              if (!source) return <span>{option.label}</span>
              return (
                <Group gap={8} wrap="nowrap">
                  {source.type === 'database' ? (
                    <ElSvgIcon name="Coin" size={16} />
                  ) : (
                    <ElSvgIcon name="Grid" size={16} />
                  )}
                  <span>{source.name}</span>
                  <Badge size="sm" color={source.type === 'database' ? 'blue' : 'orange'}>
                    {source.type === 'database'
                      ? source.db_type || t('business.entity.database')
                      : t('business.entity.spreadsheet')}
                  </Badge>
                </Group>
              )
            }}
          />
        </div>
      )}
      {availableDataSources.length === 0 && !loadingDataSources && (
        <div className={styles.noDataSourceHint}>
          <EmptyHint description={t('business.entity.noDataSourceHint')} />
        </div>
      )}

      {selectedDataSource && (
        <div className={styles.columnValueDialogContent}>
          {/* Left panel: table and column linked selector */}
          <div className={styles.tableColumnSelectionPanel}>
            <TableSelector
              tables={allTables as any}
              activeTableId={activeTableId}
              selectedTableIds={selectedTableIds}
              onSelect={handleTableSelect}
            />
            <ColumnSelector
              columns={currentTableColumns}
              tableId={activeTableId}
              tableName={activeTableName}
              mode="single"
              disabledColumns={disabledColumns as any}
              onSelect={handleColumnSelect}
            />
          </div>

          {/* Right panel: selected configs area */}
          <div className={`${styles.selectedConfigsPanel} ${styles.columnValueConfigs}`}>
            <div className={styles.areaHeader}>
              <h4>{t('business.entity.selectedConfigs', { count: entityConfigs.length })}</h4>
            </div>
            {entityConfigs.length > 0 ? (
              <div className={styles.configsListContainer}>
                {entityConfigs.map((config, index) => (
                  <div
                    key={`${config.table_id}-${config.column_name}`}
                    className={styles.columnValueConfigItem}
                  >
                    <div className={styles.configItemHeader}>
                      <div className={styles.configItemInfo}>
                        <Badge color="gray" size="sm">
                          {config.table_name}
                        </Badge>
                        <span className={styles.configColumnName}>{config.column_name}</span>
                      </div>
                      <Button
                        size="xs"
                        color="red"
                        onClick={() => removeConfig(index)}
                        px={8}
                      >
                        <ElSvgIcon name="Delete" size={14} />
                      </Button>
                    </div>
                    <div className={styles.configRuleSection}>
                      <span className={styles.ruleLabel}>
                        {t('business.entity.configDescription')}
                      </span>
                      <TextInput
                        value={config.rule || ''}
                        onChange={(e) => updateConfigField(index, 'rule', e.currentTarget.value)}
                        placeholder={t('business.entity.configDescPlaceholder')}
                        maxLength={500}
                      />
                    </div>
                    <div className={styles.configMetadataSection}>
                      <div className={styles.metadataHeader}>
                        <span className={styles.metadataLabel}>
                          {t('business.entity.metadataFieldsLabel')}
                        </span>
                        <div className={styles.metadataActions}>
                          <Button size="xs" onClick={() => selectAllMetadata(index)}>
                            {t('business.entity.selectAll')}
                          </Button>
                          <Button
                            size="xs"
                            color="gray"
                            onClick={() => clearAllMetadata(index)}
                            disabled={
                              !config.metadata_fields || config.metadata_fields.length === 0
                            }
                          >
                            {t('business.entity.deselect')}
                          </Button>
                        </div>
                      </div>
                      <MultiSelect
                        value={config.metadata_fields || []}
                        onChange={(val) => updateConfigField(index, 'metadata_fields', val)}
                        searchable
                        placeholder={t('business.entity.metadataPlaceholder')}
                        style={{ width: '100%' }}
                        data={getTableColumnsForMetadata(config.table_id, config.column_name).map(
                          (col) => ({ value: col.column_name, label: col.column_name }),
                        )}
                        renderOption={({ option }) => {
                          const col = getTableColumnsForMetadata(
                            config.table_id,
                            config.column_name,
                          ).find((c) => c.column_name === option.value)
                          return (
                            <span>
                              <span>{option.value}</span>
                              {col?.description && (
                                <span className={styles.metadataOptionDesc}>{col.description}</span>
                              )}
                            </span>
                          )
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.noConfigsHint}>
                <EmptyHint description={t('business.entity.noSelectedConfigs')}>
                  <p className={styles.hintText}>{t('business.entity.clickColumnToAdd')}</p>
                </EmptyHint>
              </div>
            )}
          </div>
        </div>
      )}

      {/* footer */}
      <div className={styles.dialogFooter}>
        <Button variant="default" onClick={handleCancel}>
          {t('business.entity.cancel')}
        </Button>
        <Button
          onClick={handleSave}
          loading={saving}
          disabled={entityConfigs.length === 0}
          leftSection={<ElSvgIcon name="Check" size={16} />}
        >
          {t('business.entity.createColumnValue', { count: entityConfigs.length })}
        </Button>
      </div>
    </Modal>
  )
}

// el-empty has no direct equivalent: implement with Center + Text
function EmptyHint({
  description,
  children,
}: {
  description?: string
  children?: ReactNode
}) {
  return (
    <Center style={{ flexDirection: 'column', padding: '12px 0' }}>
      <Text size="sm" c="dimmed">
        {description}
      </Text>
      {children}
    </Center>
  )
}
