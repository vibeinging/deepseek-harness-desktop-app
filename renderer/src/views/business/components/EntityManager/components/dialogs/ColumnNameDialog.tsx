import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Badge, Button, Center, CloseButton, Group, Modal, Select, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import TableSelector from '../table-selectors/TableSelector'
import ColumnSelector from '../table-selectors/ColumnSelector'
import styles from './ColumnNameDialog.module.scss'

// No strong types are available for source/table/column structures, so use any
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
  data_type?: string
  table_id?: any
  table_name?: string
  [key: string]: any
}

interface TableItem {
  id?: any
  table_name?: string
  columns?: TableColumn[]
  [key: string]: any
}

interface EntityConfig {
  table_id?: any
  table_name?: string
  column_name: string
  entity_name?: string
  data_type?: string
  [key: string]: any
}

interface GroupedConfig {
  table_id: any
  table_name?: string
  columns: EntityConfig[]
}

export interface ColumnNameDialogProps {
  visible?: boolean
  availableDataSources?: DataSource[]
  selectedDataSource?: DataSource | null
  loadingDataSources?: boolean
  allTables?: TableItem[]
  saving?: boolean
  // defineEmits → callback props
  onUpdateVisible?: (val: boolean) => void
  onChangeDataSource?: (source?: DataSource) => void
  onSelectTable?: (table: TableItem) => void
  onSave?: (configs: EntityConfig[]) => void
}

export default function ColumnNameDialog(props: ColumnNameDialogProps) {
  const {
    visible = false,
    availableDataSources = [],
    selectedDataSource = null,
    loadingDataSources = false,
    allTables = [],
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

  const groupedConfigs = useMemo<GroupedConfig[]>(() => {
    const grouped: Record<string, GroupedConfig> = {}
    for (const config of entityConfigs) {
      const key = String(config.table_id)
      if (!grouped[key]) {
        grouped[key] = {
          table_id: config.table_id,
          table_name: config.table_name,
          columns: [],
        }
      }
      grouped[key].columns.push(config)
    }
    return Object.values(grouped)
  }, [entityConfigs])

  const configStats = useMemo(() => {
    const tableCount = groupedConfigs.length
    const columnCount = entityConfigs.length
    return { tableCount, columnCount }
  }, [groupedConfigs, entityConfigs])

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

  const handleAddColumns = (columns: TableColumn[]) => {
    setEntityConfigs((prev) => {
      const next = [...prev]
      for (const col of columns) {
        const exists = next.some(
          (c) => c.table_id === col.table_id && c.column_name === col.column_name,
        )
        if (!exists) {
          next.push({
            table_id: col.table_id,
            table_name: col.table_name,
            column_name: col.column_name,
            entity_name: col.description || col.column_name,
            data_type: col.data_type,
          })
        }
      }
      return next
    })
    notifications.show({
      color: 'green',
      message: t('business.entity.columnsAdded', { count: columns.length }),
    })
  }

  const removeColumnConfig = (tableId: any, columnName: string) => {
    setEntityConfigs((prev) => {
      const index = prev.findIndex(
        (c) => c.table_id === tableId && c.column_name === columnName,
      )
      if (index > -1) {
        const next = [...prev]
        next.splice(index, 1)
        return next
      }
      return prev
    })
  }

  const removeTableColumns = (tableId: any) => {
    setEntityConfigs((prev) => prev.filter((c) => c.table_id !== tableId))
  }

  const handleCancel = () => {
    setDialogVisible(false)
    setEntityConfigs([])
    setActiveTableId(null)
  }

  const handleSave = () => {
    if (entityConfigs.length === 0) {
      notifications.show({
        color: 'yellow',
        message: t('business.entity.pleaseAddColumnName'),
      })
      return
    }
    onSave?.([...entityConfigs])
  }

  // Reset when dialog opens (watch props.visible)
  useEffect(() => {
    if (visible) {
      setEntityConfigs([])
      setActiveTableId(null)
      // Auto-select first table if available
      if (allTables.length > 0) {
        handleTableSelect(allTables[0])
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
      title={t('business.entity.addColumnNameTitle')}
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
        <div className={styles.columnNameDialogContent}>
          {/* Left: linked table and column selection area */}
          <div className={styles.tableColumnSelectionPanel}>
            <TableSelector
              tables={allTables as any}
              activeTableId={activeTableId}
              onSelect={handleTableSelect}
            />
            <ColumnSelector
              columns={currentTableColumns}
              tableId={activeTableId}
              tableName={activeTableName}
              mode="multi"
              disabledColumns={disabledColumns}
              onAddColumns={handleAddColumns}
            />
          </div>

          {/* Right: selected config area */}
          <div className={styles.selectedConfigsPanel}>
            <div className={styles.areaHeader}>
              <h4>
                {t('business.entity.selectedConfigsTableColumn', {
                  tableCount: configStats.tableCount,
                  columnCount: configStats.columnCount,
                })}
              </h4>
            </div>
            {entityConfigs.length > 0 ? (
              <div className={styles.configsListContainer}>
                {groupedConfigs.map((tableGroup) => (
                  <div key={tableGroup.table_id} className={styles.configTableGroup}>
                    <div className={styles.configGroupHeader}>
                      <div className={styles.groupTitle}>
                        <Badge color="gray" size="sm">
                          {tableGroup.table_name}
                        </Badge>
                        <span className={styles.groupCount}>
                          {tableGroup.columns.length} {t('business.entity.columns')}
                        </span>
                      </div>
                      <Button
                        size="xs"
                        color="red"
                        variant="subtle"
                        onClick={() => removeTableColumns(tableGroup.table_id)}
                      >
                        {t('business.entity.removeAll')}
                      </Button>
                    </div>
                    <div className={styles.configColumnsTags}>
                      {tableGroup.columns.map((col) => (
                        <Badge
                          key={col.column_name}
                          color="gray"
                          size="sm"
                          rightSection={
                            <CloseButton
                              size={14}
                              radius="xl"
                              variant="transparent"
                              onClick={() =>
                                removeColumnConfig(tableGroup.table_id, col.column_name)
                              }
                            />
                          }
                        >
                          {col.column_name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.noConfigsHint}>
                <EmptyHint description={t('business.entity.noSelectedConfigs')}>
                  <p className={styles.hintText}>{t('business.entity.selectTableColumnToAdd')}</p>
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
          {t('business.entity.createColumnName', {
            tableCount: configStats.tableCount,
            columnCount: configStats.columnCount,
          })}
        </Button>
      </div>
    </Modal>
  )
}

// el-empty has no direct equivalent; use Center + Text instead
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
