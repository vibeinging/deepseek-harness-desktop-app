// Migrated from EntityList.vue: entity mapping list view (data nouns table + field noun tags)
import { useTranslation } from 'react-i18next'
import { Badge, Button, Switch, Table, Tooltip } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './EntityList.module.scss'

// EP el-tag type → Mantine Badge color mapping
const tagColorMap: Record<string, string> = {
  success: 'green',
  warning: 'orange',
  info: 'gray',
  danger: 'red',
  primary: 'blue',
}
const badgeColor = (type: string) => tagColorMap[type] || 'gray'

export interface EntityListProps {
  mergedEntityMappings?: any[]
  togglingConfig?: string | number | null
  generatingTableColumn?: string | number | null
  generatingColumnNameTable?: string | number | null
  deletingTableColumn?: string | null
  deletingColumnNameTable?: string | null
  // defineEmits → callback props
  onEditRule?: (row: any) => void
  onToggleConfigActive?: (row: any, val: boolean) => void
  onToggleColumnNameActive?: (table: any, val: boolean) => void
  onGenerateEmbeddings?: (id: any) => void
  onGenerateColumnNameEmbeddings?: (id: any) => void
  onDeleteColumnValue?: (row: any) => void
  onDeleteColumnNameTable?: (table: any) => void
}

export default function EntityList({
  mergedEntityMappings = [],
  togglingConfig = null,
  generatingTableColumn = null,
  generatingColumnNameTable = null,
  deletingTableColumn = null,
  deletingColumnNameTable = null,
  onEditRule,
  onToggleConfigActive,
  onToggleColumnNameActive,
  onGenerateEmbeddings,
  onGenerateColumnNameEmbeddings,
  onDeleteColumnValue,
  onDeleteColumnNameTable,
}: EntityListProps) {
  const { t } = useTranslation()

  // Vector status check (keep original exact value matching logic)
  const isGeneratingStatus = (status: any) =>
    ['生成中', 'Generating', 'generating'].includes(status)
  const isGeneratedStatus = (status: any) =>
    ['已生成', 'Generated', 'generated'].includes(status)
  const isFailedStatus = (status: any) =>
    ['生成失败', 'Failed', 'failed'].includes(status)
  const isNotGeneratedStatus = (status: any) =>
    ['未生成', 'Not Generated', 'not_generated', 'not generated'].includes(status)

  const getStatusTagType = (status: any) => {
    if (isGeneratedStatus(status)) return 'success'
    if (isGeneratingStatus(status)) return 'primary'
    return 'warning'
  }

  const getVectorStatusText = (status: any) => {
    if (isGeneratedStatus(status)) return t('business.entity.generated')
    if (isGeneratingStatus(status)) return t('business.entity.generating')
    if (isFailedStatus(status)) return t('business.entity.generateFailed')
    if (isNotGeneratedStatus(status)) return t('business.entity.notGenerated')
    return status || t('business.entity.notGenerated')
  }

  // Vector status Badge (shared by list/table) — wrap with Tooltip when failed and has error
  const renderVectorStatusBadge = (status: any, error: any) => {
    if (isFailedStatus(status) && error) {
      return (
        <Tooltip label={error} position="top" openDelay={300} withinPortal>
          <Badge color="red" size="sm" variant="light">
            {getVectorStatusText(status)}
          </Badge>
        </Tooltip>
      )
    }
    return (
      <Badge color={badgeColor(getStatusTagType(status))} size="sm" variant="light">
        {isGeneratingStatus(status) && (
          <span className={styles.isLoading}>
            <ElSvgIcon name="Loading" size={12} />
          </span>
        )}
        {getVectorStatusText(status)}
      </Badge>
    )
  }

  return (
    <div className={styles.entitiesListDisplay}>
      {mergedEntityMappings.map((table) => (
        <div
          key={table.key}
          className={`${styles.tableEntityGroup} ${
            table.type === 'column_name' ? styles.columnNameGroup : ''
          }`}
        >
          {/* Unified header layout */}
          <div className={styles.tableGroupHeader}>
            <div className={styles.headerLeft}>
              <Badge
                color={table.type === 'column_value' ? 'green' : 'orange'}
                size="sm"
                variant="light"
                className={styles.typeTag}
              >
                {table.type === 'column_value'
                  ? t('business.entity.dataType')
                  : t('business.entity.fieldType')}
              </Badge>
              <h4>{table.table_name}</h4>
              <div className={styles.tableStats}>
                {table.type === 'column_value' ? (
                  <>
                    <Badge color="gray" size="sm" variant="light">
                      {table.configs.length} {t('business.entity.columns')}
                    </Badge>
                    <Badge
                      color={table.totalEntities > 0 ? 'green' : 'orange'}
                      size="sm"
                      variant="light"
                    >
                      {table.totalEntities} {t('business.entity.entities')}
                    </Badge>
                  </>
                ) : (
                  <>
                    <Badge color="gray" size="sm" variant="light">
                      {table.columns.length} {t('business.entity.columns')}
                    </Badge>
                    <Badge
                      color={table.entity_count > 0 ? 'green' : 'orange'}
                      size="sm"
                      variant="light"
                    >
                      {table.entity_count} {t('business.entity.entities')}
                    </Badge>
                    {isFailedStatus(table.vector_status) && table.vector_error ? (
                      <Tooltip
                        label={table.vector_error}
                        position="top"
                        openDelay={300}
                        withinPortal
                      >
                        <Badge color="red" size="sm" variant="light">
                          {getVectorStatusText(table.vector_status)}
                        </Badge>
                      </Tooltip>
                    ) : (
                      <Badge
                        color={badgeColor(getStatusTagType(table.vector_status))}
                        size="sm"
                        variant="light"
                      >
                        {isGeneratingStatus(table.vector_status) && (
                          <span className={styles.isLoading}>
                            <ElSvgIcon name="Loading" size={12} />
                          </span>
                        )}
                        {getVectorStatusText(table.vector_status)}
                      </Badge>
                    )}
                  </>
                )}
              </div>
            </div>
            {table.type === 'column_name' && (
              <div className={styles.tableActions}>
                {table.is_active === false && table.ref_is_active !== undefined ? (
                  <Tooltip
                    label={
                      t('business.entity.disabledByDatasource') ||
                      '已被数据源管理员全局禁用'
                    }
                    position="top"
                    withinPortal
                  >
                    <div
                      className={styles.disabledSwitchWrapper}
                      style={{ marginRight: 12 }}
                    >
                      <Switch checked={false} disabled />
                      <span className={styles.disabledIcon} style={{ color: '#E6A23C' }}>
                        <ElSvgIcon name="WarningFilled" size={14} color="#E6A23C" />
                      </span>
                    </div>
                  </Tooltip>
                ) : (
                  <Switch
                    checked={table.is_active}
                    onChange={(e) =>
                      onToggleColumnNameActive?.(table, e.currentTarget.checked)
                    }
                    disabled={togglingConfig === table.id}
                    style={{ marginRight: 12 }}
                  />
                )}
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => onGenerateColumnNameEmbeddings?.(table.id)}
                  loading={generatingColumnNameTable === table.id}
                  leftSection={<ElSvgIcon name="Connection" size={14} />}
                >
                  {t('business.entity.generateVector')}
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => onDeleteColumnNameTable?.(table)}
                  loading={deletingColumnNameTable === table.table_name}
                  leftSection={<ElSvgIcon name="Delete" size={14} />}
                >
                  {t('business.entity.delete')}
                </Button>
              </div>
            )}
          </div>

          {/* Data noun content: table */}
          {table.type === 'column_value' ? (
            <div className={styles.tableScroll}>
              <Table style={{ width: '100%' }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 200 }}>
                      {t('business.entity.entityField')}
                    </Table.Th>
                    <Table.Th style={{ minWidth: 180 }}>
                      {t('business.entity.configDescription')}
                    </Table.Th>
                    <Table.Th style={{ minWidth: 120, maxWidth: 260 }}>
                      {t('business.entity.metadataFields')}
                    </Table.Th>
                    <Table.Th style={{ width: 120 }}>
                      {t('business.entity.enable')}
                    </Table.Th>
                    <Table.Th style={{ width: 120 }}>
                      {t('business.entity.vectorStatus')}
                    </Table.Th>
                    <Table.Th style={{ width: 100 }}>
                      {t('business.entity.entityCount')}
                    </Table.Th>
                    <Table.Th style={{ width: 220 }}>
                      {t('business.entity.actions')}
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {table.configs.map((row: any) => (
                    <Table.Tr key={row.id ?? row.column_name}>
                      {/* Entity field */}
                      <Table.Td>
                        <Badge color="blue" size="sm" variant="light">
                          {row.column_name}
                        </Badge>
                        {/* Auto-generated tag (created from AgenticSearch fb_search fallback promote) */}
                        {row.auto_promoted && (
                          <Tooltip
                            label={t(
                              'business.entity.autoPromotedTooltip',
                              'AgenticSearch fb_search 失败兜底时自动从数据召回生成的实体配置',
                            )}
                            position="top"
                            withinPortal
                          >
                            <Badge
                              color="orange"
                              size="sm"
                              variant="outline"
                              className={styles.autoPromotedTag}
                            >
                              {t('business.entity.autoPromoted', '自动生成')}
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Td>

                      {/* Configuration description (rule) */}
                      <Table.Td>
                        <div
                          className={styles.ruleCell}
                          onClick={() => onEditRule?.(row)}
                        >
                          <span
                            className={`${styles.ruleText} ${
                              !row.rule ? styles.noRule : ''
                            }`}
                          >
                            {row.rule || t('business.entity.clickToSet')}
                          </span>
                          <span className={styles.editRuleIcon}>
                            <ElSvgIcon name="Edit" size={14} color="#409eff" />
                          </span>
                        </div>
                      </Table.Td>

                      {/* Metadata fields */}
                      <Table.Td>
                        {row.metadata_fields && row.metadata_fields.length > 0 ? (
                          <Tooltip
                            disabled={row.metadata_fields.length <= 2}
                            position="top"
                            withinPortal
                            label={
                              <div className={styles.metadataTooltip}>
                                {row.metadata_fields.map((field: any) => (
                                  <Badge
                                    key={field}
                                    size="sm"
                                    color="gray"
                                    variant="light"
                                    className={styles.metadataTooltipTag}
                                  >
                                    {field}
                                  </Badge>
                                ))}
                              </div>
                            }
                          >
                            <div className={styles.metadataFieldsInline}>
                              {row.metadata_fields
                                .slice(0, 2)
                                .map((field: any) => (
                                  <Badge
                                    key={field}
                                    size="sm"
                                    color="gray"
                                    variant="light"
                                    className={styles.metadataTag}
                                  >
                                    {field}
                                  </Badge>
                                ))}
                              {row.metadata_fields.length > 2 && (
                                <span className={styles.moreFields}>
                                  +{row.metadata_fields.length - 2}
                                </span>
                              )}
                            </div>
                          </Tooltip>
                        ) : (
                          <span className={styles.noMetadata}>
                            {t('business.entity.none')}
                          </span>
                        )}
                      </Table.Td>

                      {/* Enable switch */}
                      <Table.Td>
                        {row.is_active === false &&
                        row.ref_is_active !== undefined ? (
                          <Tooltip
                            label={
                              t('business.entity.disabledByDatasource') ||
                              '已被数据源管理员全局禁用'
                            }
                            position="top"
                            withinPortal
                          >
                            <div className={styles.disabledSwitchWrapper}>
                              <Switch checked={false} disabled />
                              <span
                                className={styles.disabledIcon}
                                style={{ color: '#E6A23C' }}
                              >
                                <ElSvgIcon
                                  name="WarningFilled"
                                  size={14}
                                  color="#E6A23C"
                                />
                              </span>
                            </div>
                          </Tooltip>
                        ) : (
                          <Switch
                            checked={row.is_active}
                            onChange={(e) =>
                              onToggleConfigActive?.(row, e.currentTarget.checked)
                            }
                            disabled={togglingConfig === row.id}
                          />
                        )}
                      </Table.Td>

                      {/* Vector status */}
                      <Table.Td>
                        {renderVectorStatusBadge(
                          row.vector_status,
                          row.vector_error,
                        )}
                      </Table.Td>

                      {/* Entity count */}
                      <Table.Td>
                        <span>{row.entity_count || 0}</span>
                      </Table.Td>

                      {/* Actions */}
                      <Table.Td>
                        <div className={styles.actionBtn}>
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => onGenerateEmbeddings?.(row.id)}
                            loading={generatingTableColumn === row.id}
                            leftSection={<ElSvgIcon name="Connection" size={14} />}
                          >
                            {t('business.entity.generateVector')}
                          </Button>
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => onDeleteColumnValue?.(row)}
                            loading={
                              deletingTableColumn ===
                              `${table.table_name}-${row.column_name}`
                            }
                            leftSection={<ElSvgIcon name="Delete" size={14} />}
                          >
                            {t('business.entity.delete')}
                          </Button>
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          ) : (
            /* Field noun content: tag list */
            <div className={styles.columnNameContent}>
              {table.columns.map((col: any) => (
                <Tooltip
                  key={col.column_name}
                  label={col.description}
                  disabled={!col.description}
                  position="top"
                  withinPortal
                >
                  <Badge
                    size="sm"
                    color={col.auto_promoted ? 'orange' : 'gray'}
                    variant={col.auto_promoted ? 'outline' : 'light'}
                    className={styles.columnTag}
                  >
                    {col.column_name}
                    {col.description && (
                      <span className={styles.columnDescIndicator}>*</span>
                    )}
                    {col.auto_promoted && (
                      <span
                        className={styles.columnAutoPromoted}
                        title={t(
                          'business.entity.autoPromotedTooltip',
                          'AgenticSearch fb_search 失败兜底时自动从数据召回生成的实体配置',
                        )}
                      >
                        ⚙
                      </span>
                    )}
                  </Badge>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
