// Migrated from Vue: views/database/components/TableEditDialog.vue
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Modal,
  Button,
  Textarea,
  TextInput,
  Table,
  Popover,
  Checkbox,
  Pagination,
  Select,
  Group,
  ScrollArea,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconSearch, IconWand } from '@tabler/icons-react'
import {
  updateTableDescriptionReq,
  updateColumnDescriptionReq,
  generateSingleTableDescriptionReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  getTableColumnsReq,
} from '@/api/database'
import { useProjectStore } from '@/store/project'
import styles from './TableEditDialog.module.scss'

export interface TableEditDialogProps {
  // defineProps modelValue -> align with consumer convention using opened/onClose
  opened?: boolean
  table?: any
  databaseId: string
  // defineEmits(['update:modelValue', 'saved'])
  onClose?: () => void
  onSaved?: () => void
}

export default function TableEditDialog(props: TableEditDialogProps) {
  const { opened = false, table = null, databaseId } = props
  const { t } = useTranslation()

  // Read current project ID immediately (aligned with Pinia store behavior)
  const currentProjectId = useProjectStore((s) => s.currentProject?.id || null)

  const [editingTable, setEditingTable] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  // AI generation state
  const [aiExtraNotes, setAiExtraNotes] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateBtnState, setGenerateBtnState] = useState<'idle' | 'generating' | 'vectorGenerating'>('idle')
  const generateButtonText = useMemo(() => {
    const map: Record<string, string> = {
      idle: 'database.tableEdit.aiGenerateBtn',
      generating: 'database.tableEdit.generating',
      vectorGenerating: 'database.tableEdit.vectorGenerating',
    }
    return t(map[generateBtnState] || map.idle)
  }, [generateBtnState, t])

  // Column search and pagination
  const [columnSearchKeyword, setColumnSearchKeyword] = useState('')
  const [columnCurrentPage, setColumnCurrentPage] = useState(1)
  const [columnPageSize, setColumnPageSize] = useState(10)

  // Filtered columns
  const filteredColumns = useMemo(() => {
    if (!editingTable?.columns) return []
    if (!columnSearchKeyword.trim()) {
      return editingTable.columns
    }
    const keyword = columnSearchKeyword.toLowerCase().trim()
    return editingTable.columns.filter(
      (col: any) =>
        col.column_name.toLowerCase().includes(keyword) ||
        (col.description && col.description.toLowerCase().includes(keyword))
    )
  }, [editingTable, columnSearchKeyword])

  // Paginated columns
  const paginatedColumns = useMemo(() => {
    const start = (columnCurrentPage - 1) * columnPageSize
    const end = start + columnPageSize
    return filteredColumns.slice(start, end)
  }, [filteredColumns, columnCurrentPage, columnPageSize])

  // Total pages
  const totalColumnPages = useMemo(() => {
    return Math.ceil(filteredColumns.length / columnPageSize)
  }, [filteredColumns, columnPageSize])

  // Handle column search
  const handleColumnSearch = (val: string) => {
    setColumnSearchKeyword(val)
    setColumnCurrentPage(1)
  }

  // Handle page-size change
  const handleColumnSizeChange = (size: number) => {
    setColumnPageSize(size)
    setColumnCurrentPage(1)
  }

  // Popover visibility state
  const [popoverVisible, setPopoverVisible] = useState<{
    tableDesc: boolean
    colDesc: Record<string, boolean>
    exampleValues: Record<string, boolean>
    enumMappings: Record<string, boolean>
  }>({
    tableDesc: false,
    colDesc: {},
    exampleValues: {},
    enumMappings: {},
  })

  // Temporary table description value
  const [tempTableDescription, setTempTableDescription] = useState('')
  // Temporary column description values
  const [tempColumnDescription, setTempColumnDescription] = useState<Record<string, string>>({})
  // Temporary example values
  const [exampleValuesText, setExampleValuesText] = useState<Record<string, string>>({})
  const [jsonError, setJsonError] = useState<Record<string, string>>({})
  // Temporary enum mapping values
  const [enumMappingsText, setEnumMappingsText] = useState<Record<string, string>>({})
  const [enumJsonError, setEnumJsonError] = useState<Record<string, string>>({})

  // Watch table changes (align with watch(props.table, { immediate: true }))
  useEffect(() => {
    const newTable = table
    if (newTable) {
      const cloned = JSON.parse(JSON.stringify(newTable))
      // Ensure fields exist
      if (cloned.columns) {
        cloned.columns.forEach((column: any) => {
          if (!Object.prototype.hasOwnProperty.call(column, 'is_high_recall')) {
            column.is_high_recall = false
          }
          if (!column.example_values) {
            column.example_values = []
          }
        })
      }
      setEditingTable(cloned)
      // Reset temporary states
      setTempTableDescription('')
      setTempColumnDescription({})
      setExampleValuesText({})
      setJsonError({})
      setEnumMappingsText({})
      setEnumJsonError({})
      setPopoverVisible({ tableDesc: false, colDesc: {}, exampleValues: {}, enumMappings: {} })
      // Reset search and pagination
      setColumnSearchKeyword('')
      setColumnCurrentPage(1)
      // Reset AI generation state
      setAiExtraNotes('')
      setIsGenerating(false)
      setGenerateBtnState('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])

  // ========== AI description generation ==========
  const handleAIGenerate = async () => {
    if (!editingTable || !editingTable.id) {
      notifications.show({ color: 'yellow', message: t('database.tableEdit.tableNotExist') })
      return
    }

    try {
      setIsGenerating(true)
      setGenerateBtnState('generating')

      // 1) Call AI description generation API with extra notes
      const descRes: any = await generateSingleTableDescriptionReq(
        currentProjectId,
        databaseId,
        editingTable.id,
        2, // limit_examples
        aiExtraNotes // User-provided extra notes
      )

      if (!descRes.success || !descRes.data) {
        notifications.show({ color: 'red', message: descRes.msg || t('database.tableEdit.generateFailed') })
        return
      }

      const { columns_generated, table_description_generated, table_description } = descRes.data

      // Update table description in the edit form
      let nextTable = { ...editingTable }
      if (table_description) {
        nextTable.description = table_description
      }

      // Reload column data to update the UI
      if (columns_generated > 0) {
        try {
          const columnsRes: any = await getTableColumnsReq(currentProjectId, databaseId, editingTable.id)
          if (columnsRes.success && columnsRes.data) {
            nextTable.columns = columnsRes.data
          }
        } catch (e) {
          console.error('刷新列数据失败:', e)
        }
      }
      setEditingTable(nextTable)

      notifications.show({
        color: 'green',
        message: t('database.tableEdit.generateSuccess', {
          columns: columns_generated,
          tableUpdated: table_description_generated,
        }),
      })

      // 2) Generate vectors
      try {
        setGenerateBtnState('vectorGenerating')

        // Generate table description vector
        await storeSingleTableVectorReq(currentProjectId, databaseId, editingTable.id)

        // Generate column description vectors
        await storeTableColumnsVectorReq(currentProjectId, databaseId, editingTable.id)
      } catch (e) {
        console.error('生成向量失败:', e)
        notifications.show({ color: 'yellow', message: t('database.tableEdit.vectorFailed') })
      }

      // Trigger refresh
      props.onSaved?.()
    } catch (error: any) {
      console.error('AI生成描述失败:', error)
      notifications.show({
        color: 'red',
        message: error?.response?.data?.detail || error?.message || t('database.tableEdit.generateFailed'),
      })
    } finally {
      setIsGenerating(false)
      setGenerateBtnState('idle')
    }
  }

  // ========== Table description ==========
  const initTableDescription = () => {
    setTempTableDescription(editingTable?.description || '')
  }

  const saveTableDescription = async () => {
    setSaving(true)
    try {
      await updateTableDescriptionReq(currentProjectId, databaseId, editingTable.id, tempTableDescription)
      setEditingTable((prev: any) => ({ ...prev, description: tempTableDescription }))
      setPopoverVisible((p) => ({ ...p, tableDesc: false }))
      notifications.show({ color: 'green', message: t('database.tableEdit.tableDescSaved') })
      props.onSaved?.()
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('database.tableEdit.saveFailed') + error.message })
    } finally {
      setSaving(false)
    }
  }

  // ========== Column description ==========
  const initColumnDescription = (column: any) => {
    setTempColumnDescription((prev) => ({ ...prev, [column.id]: column.description || '' }))
  }

  const saveColumnDescription = async (column: any) => {
    setSaving(true)
    try {
      const res: any = await updateColumnDescriptionReq(
        currentProjectId,
        databaseId,
        column.id,
        tempColumnDescription[column.id]
      )
      const nextDesc = tempColumnDescription[column.id]
      // Auto-update enum mappings parsed from description
      const nextEnum = res.data?.enum_mappings
      updateColumnInState(column.id, (c) => {
        c.description = nextDesc
        if (nextEnum) {
          c.enum_mappings = nextEnum
        }
      })
      setPopoverVisible((p) => ({ ...p, colDesc: { ...p.colDesc, [column.id]: false } }))
      notifications.show({ color: 'green', message: t('database.tableEdit.columnDescSaved') })
      props.onSaved?.()
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('database.tableEdit.saveFailed') + error.message })
    } finally {
      setSaving(false)
    }
  }

  // ========== Example values ==========
  const initExampleValuesText = (column: any) => {
    const values = column.example_values || []
    setExampleValuesText((prev) => ({
      ...prev,
      [column.id]: values.length > 0 ? JSON.stringify(values, null, 2) : '',
    }))
    setJsonError((prev) => ({ ...prev, [column.id]: '' }))
  }

  const saveExampleValues = async (column: any) => {
    const text = exampleValuesText[column.id]?.trim() || ''
    setJsonError((prev) => ({ ...prev, [column.id]: '' }))

    let parsedValues: any[] = []
    if (text) {
      try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
          setJsonError((prev) => ({ ...prev, [column.id]: t('database.tableEdit.mustBeArray') }))
          return
        }
        parsedValues = parsed.map((v: any) => (typeof v === 'string' ? v : JSON.stringify(v)))
      } catch (e) {
        setJsonError((prev) => ({ ...prev, [column.id]: t('database.tableEdit.jsonFormatError') }))
        return
      }
    }

    setSaving(true)
    try {
      await updateColumnDescriptionReq(
        currentProjectId,
        databaseId,
        column.id,
        column.description || '',
        null,
        parsedValues
      )
      updateColumnInState(column.id, (c) => {
        c.example_values = parsedValues
      })
      setPopoverVisible((p) => ({ ...p, exampleValues: { ...p.exampleValues, [column.id]: false } }))
      notifications.show({ color: 'green', message: t('database.tableEdit.exampleValuesSaved') })
      props.onSaved?.()
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('database.tableEdit.saveFailed') + error.message })
    } finally {
      setSaving(false)
    }
  }

  // ========== Enum values ==========
  // Convert mappings array to compact text format
  const mappingsToText = (mappings: any[]) => {
    if (!mappings?.length) return ''
    return mappings.map((m: any) => `${m.code}=${m.label}`).join('\n')
  }

  // Parse compact text into mappings array
  const textToMappings = (text: string) => {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l)
    const mappings: any[] = []
    for (const line of lines) {
      // Match format: code=label
      const match = line.match(/^([^=]+)=(.+)$/)
      if (!match) {
        throw new Error(t('database.tableEdit.enumFormatError', { line }))
      }
      const [, code, label] = match
      mappings.push({
        code: code.trim(),
        label: label.trim(),
      })
    }
    return mappings
  }

  const initEnumMappingsText = (column: any) => {
    const mappings = column.enum_mappings?.mappings || []
    setEnumMappingsText((prev) => ({ ...prev, [column.id]: mappingsToText(mappings) }))
    setEnumJsonError((prev) => ({ ...prev, [column.id]: '' }))
  }

  const saveEnumMappings = async (column: any) => {
    const text = enumMappingsText[column.id]?.trim() || ''
    setEnumJsonError((prev) => ({ ...prev, [column.id]: '' }))

    let parsedMappings: any[] = []
    if (text) {
      try {
        parsedMappings = textToMappings(text)
      } catch (e: any) {
        setEnumJsonError((prev) => ({ ...prev, [column.id]: e.message }))
        return
      }
    }

    const payloadEnumMappings = {
      mappings: parsedMappings,
      auto_detected: false,
      detection_method: 'manual',
    }

    setSaving(true)
    try {
      await updateColumnDescriptionReq(
        currentProjectId,
        databaseId,
        column.id,
        column.description || '',
        null,
        null,
        payloadEnumMappings
      )
      updateColumnInState(column.id, (c) => {
        c.enum_mappings = payloadEnumMappings
      })
      setPopoverVisible((p) => ({ ...p, enumMappings: { ...p.enumMappings, [column.id]: false } }))
      notifications.show({ color: 'green', message: t('database.tableEdit.enumValuesSaved') })
      props.onSaved?.()
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('database.tableEdit.saveFailed') + error.message })
    } finally {
      setSaving(false)
    }
  }

  const formatEnumMappingsPreview = (enumMappings: any) => {
    const mappings = enumMappings?.mappings || []
    if (!mappings.length) return '—'
    const preview = mappings.slice(0, 3).map((m: any) => `${m.code}=${m.label}`)
    return mappings.length > 3 ? `${preview.join(', ')}...` : preview.join(', ')
  }

  // ========== High recall ==========
  const toggleHighRecall = async (column: any, newValue: boolean) => {
    const oldValue = column.is_high_recall
    // Update UI first
    updateColumnInState(column.id, (c) => {
      c.is_high_recall = newValue
    })

    try {
      await updateColumnDescriptionReq(
        currentProjectId,
        databaseId,
        column.id,
        column.description || '',
        newValue
      )
      notifications.show({
        color: 'green',
        message: newValue ? t('database.tableEdit.highRecallSet') : t('database.tableEdit.highRecallUnset'),
      })
      props.onSaved?.()
    } catch (error: any) {
      // Revert to previous value on failure
      updateColumnInState(column.id, (c) => {
        c.is_high_recall = oldValue
      })
      notifications.show({ color: 'red', message: t('database.tableEdit.saveFailed') + error.message })
    }
  }

  // Helper: in-place update for a specific column in editingTable.columns while keeping references stable and triggering rerender
  const updateColumnInState = (columnId: any, mutator: (c: any) => void) => {
    setEditingTable((prev: any) => {
      if (!prev?.columns) return prev
      const columns = prev.columns.map((c: any) => {
        if (c.id === columnId) {
          const cloned = { ...c }
          mutator(cloned)
          return cloned
        }
        return c
      })
      return { ...prev, columns }
    })
  }

  const tableTitle = `${t('database.tableEdit.title')} - ${
    editingTable?.schema_name && editingTable?.schema_name !== 'default'
      ? `${editingTable.schema_name}.${editingTable.table_name}`
      : editingTable?.table_name || ''
  }`

  return (
    <Modal
      opened={opened}
      onClose={() => props.onClose?.()}
      title={tableTitle}
      size="80%"
      yOffset="3vh"
    >
      {editingTable && (
        <div className={styles['single-edit-structure']}>
          {/* Table name */}
          <div className={styles['form-item']}>
            <div className={styles['form-label']}>{t('database.info.tableName')}</div>
            <div className={styles['form-content']}>
              <strong>
                {editingTable.schema_name && editingTable.schema_name !== 'default'
                  ? `${editingTable.schema_name}.${editingTable.table_name}`
                  : editingTable.table_name}
              </strong>
            </div>
          </div>

          {/* AI description area */}
          <div className={styles['form-item']}>
            <div className={styles['form-label']}>{t('database.tableEdit.aiNotes')}</div>
            <div className={styles['form-content']}>
              <div className={styles['ai-generate-section']}>
                <Textarea
                  className={styles['ai-notes-input']}
                  value={aiExtraNotes}
                  onChange={(e) => setAiExtraNotes(e.currentTarget.value)}
                  autosize
                  minRows={2}
                  maxRows={2}
                  placeholder={t('database.tableEdit.aiNotesPlaceholder')}
                  disabled={isGenerating}
                />
                <Button
                  loading={isGenerating}
                  disabled={isGenerating}
                  onClick={handleAIGenerate}
                  leftSection={<IconWand size={16} />}
                >
                  {generateButtonText}
                </Button>
              </div>
            </div>
          </div>

          {/* Table note */}
          <div className={styles['form-item']}>
            <div className={styles['form-label']}>{t('database.info.tableComment')}</div>
            <div className={styles['form-content']}>
              <Popover
                position="bottom"
                width={500}
                withinPortal
                opened={popoverVisible.tableDesc}
                onChange={(o) => {
                  setPopoverVisible((p) => ({ ...p, tableDesc: o }))
                  if (o) initTableDescription()
                }}
              >
                <Popover.Target>
                  <div
                    className={styles['editable-field']}
                    onClick={() => {
                      const next = !popoverVisible.tableDesc
                      setPopoverVisible((p) => ({ ...p, tableDesc: next }))
                      if (next) initTableDescription()
                    }}
                  >
                    {editingTable.description ? (
                      <span className={styles['field-value']}>{editingTable.description}</span>
                    ) : (
                      <span className={styles.placeholder}>{t('database.tableEdit.clickToEdit')}</span>
                    )}
                  </div>
                </Popover.Target>
                <Popover.Dropdown>
                  <div className={styles['field-editor']}>
                    <Textarea
                      value={tempTableDescription}
                      onChange={(e) => setTempTableDescription(e.currentTarget.value)}
                      autosize
                      minRows={4}
                      maxRows={4}
                      placeholder={t('database.tableEdit.tableDescPlaceholder')}
                    />
                    <div className={styles['editor-footer']}>
                      <div></div>
                      <div className={styles['footer-buttons']}>
                        <Button
                          size="xs"
                          variant="default"
                          onClick={() => setPopoverVisible((p) => ({ ...p, tableDesc: false }))}
                        >
                          {t('database.action.cancel')}
                        </Button>
                        <Button size="xs" loading={saving} onClick={saveTableDescription}>
                          {t('database.action.save')}
                        </Button>
                      </div>
                    </div>
                  </div>
                </Popover.Dropdown>
              </Popover>
            </div>
          </div>

            {/* Columns */}
          <div className={styles['form-item']}>
            <div className={styles['form-label']}>{t('database.info.columns')}</div>
            <div className={styles['form-content']}>
              {/* Search and count */}
              <div className={styles['column-toolbar']}>
                <TextInput
                  value={columnSearchKeyword}
                  onChange={(e) => handleColumnSearch(e.currentTarget.value)}
                  placeholder={t('database.tableEdit.searchColumn')}
                  leftSection={<IconSearch size={14} />}
                  size="xs"
                  style={{ width: 220 }}
                />
                <span className={styles['column-count']}>
                  {t('database.tableEdit.totalColumns', { count: editingTable.columns?.length || 0 })}
                </span>
              </div>
              <ScrollArea h={400} type="auto">
                <Table className={styles['column-table']} striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('database.info.columnName')}</Table.Th>
                      <Table.Th style={{ width: 100 }}>{t('database.info.dataType')}</Table.Th>
                      <Table.Th style={{ minWidth: 200 }}>{t('database.tables.description')}</Table.Th>
                      <Table.Th style={{ width: 200 }}>{t('database.tableEdit.exampleValues')}</Table.Th>
                      <Table.Th style={{ width: 200 }}>{t('database.tableEdit.enumValues')}</Table.Th>
                      <Table.Th style={{ width: 80, textAlign: 'center' }}>
                        {t('database.tableEdit.highRecall')}
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {paginatedColumns.map((row: any) => (
                      <Table.Tr key={row.id}>
                        <Table.Td>{row.column_name}</Table.Td>
                        <Table.Td>{row.data_type}</Table.Td>

              {/* Description */}
                        <Table.Td>
                          <Popover
                            position="bottom"
                            width={400}
                            withinPortal
                            opened={!!popoverVisible.colDesc[row.id]}
                            onChange={(o) => {
                              setPopoverVisible((p) => ({ ...p, colDesc: { ...p.colDesc, [row.id]: o } }))
                              if (o) initColumnDescription(row)
                            }}
                          >
                            <Popover.Target>
                              <div
                                className={styles['editable-field']}
                                onClick={() => {
                                  const next = !popoverVisible.colDesc[row.id]
                                  setPopoverVisible((p) => ({ ...p, colDesc: { ...p.colDesc, [row.id]: next } }))
                                  if (next) initColumnDescription(row)
                                }}
                              >
                                {row.description ? (
                                  <span className={styles['field-value']}>{row.description}</span>
                                ) : (
                                  <span className={styles.placeholder}>{t('database.tableEdit.clickToEdit')}</span>
                                )}
                              </div>
                            </Popover.Target>
                            <Popover.Dropdown>
                              <div className={styles['field-editor']}>
                                <Textarea
                                  value={tempColumnDescription[row.id] || ''}
                                  onChange={(e) =>
                                    setTempColumnDescription((prev) => ({ ...prev, [row.id]: e.currentTarget.value }))
                                  }
                                  autosize
                                  minRows={3}
                                  maxRows={3}
                                  placeholder={t('database.tableEdit.columnDescPlaceholder')}
                                />
                                <div className={styles['editor-footer']}>
                                  <div></div>
                                  <div className={styles['footer-buttons']}>
                                    <Button
                                      size="xs"
                                      variant="default"
                                      onClick={() =>
                                        setPopoverVisible((p) => ({
                                          ...p,
                                          colDesc: { ...p.colDesc, [row.id]: false },
                                        }))
                                      }
                                    >
                                      {t('database.action.cancel')}
                                    </Button>
                                    <Button size="xs" loading={saving} onClick={() => saveColumnDescription(row)}>
                                      {t('database.action.save')}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </Popover.Dropdown>
                          </Popover>
                        </Table.Td>

                        {/* Example values */}
                        <Table.Td>
                          <Popover
                            position="bottom"
                            width={400}
                            withinPortal
                            opened={!!popoverVisible.exampleValues[row.id]}
                            onChange={(o) => {
                              setPopoverVisible((p) => ({
                                ...p,
                                exampleValues: { ...p.exampleValues, [row.id]: o },
                              }))
                              if (o) initExampleValuesText(row)
                            }}
                          >
                            <Popover.Target>
                              <div
                                className={styles['editable-field']}
                                onClick={() => {
                                  const next = !popoverVisible.exampleValues[row.id]
                                  setPopoverVisible((p) => ({
                                    ...p,
                                    exampleValues: { ...p.exampleValues, [row.id]: next },
                                  }))
                                  if (next) initExampleValuesText(row)
                                }}
                              >
                                {row.example_values?.length ? (
                                  <>
                                    <span className={`${styles['field-value']} ${styles.truncate}`}>
                                      {row.example_values.slice(0, 3).join(', ')}
                                      {row.example_values.length > 3 && <span>...</span>}
                                    </span>
                                    <span className={styles['count-badge']}>{row.example_values.length}</span>
                                  </>
                                ) : (
                                  <span className={styles.placeholder}>{t('database.tableEdit.clickToEdit')}</span>
                                )}
                              </div>
                            </Popover.Target>
                            <Popover.Dropdown>
                              <div className={styles['field-editor']}>
                                <div className={styles['editor-header']}>
                                  <span>{t('database.tableEdit.editExampleValues')}</span>
                                  <span className={styles['editor-tip']}>{t('database.tableEdit.jsonArrayFormat')}</span>
                                </div>
                                <Textarea
                                  value={exampleValuesText[row.id] || ''}
                                  onChange={(e) =>
                                    setExampleValuesText((prev) => ({ ...prev, [row.id]: e.currentTarget.value }))
                                  }
                                  autosize
                                  minRows={8}
                                  maxRows={8}
                                  placeholder={'["示例值1", "示例值2"]'}
                                />
                                <div className={styles['editor-footer']}>
                                  {jsonError[row.id] && (
                                    <span className={styles['json-error']}>{jsonError[row.id]}</span>
                                  )}
                                  <div className={styles['footer-buttons']}>
                                    <Button
                                      size="xs"
                                      variant="default"
                                      onClick={() =>
                                        setPopoverVisible((p) => ({
                                          ...p,
                                          exampleValues: { ...p.exampleValues, [row.id]: false },
                                        }))
                                      }
                                    >
                                      {t('database.action.cancel')}
                                    </Button>
                                    <Button size="xs" loading={saving} onClick={() => saveExampleValues(row)}>
                                      {t('database.action.save')}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </Popover.Dropdown>
                          </Popover>
                        </Table.Td>

                        {/* Enum values */}
                        <Table.Td>
                          <Popover
                            position="bottom"
                            width={420}
                            withinPortal
                            opened={!!popoverVisible.enumMappings[row.id]}
                            onChange={(o) => {
                              setPopoverVisible((p) => ({
                                ...p,
                                enumMappings: { ...p.enumMappings, [row.id]: o },
                              }))
                              if (o) initEnumMappingsText(row)
                            }}
                          >
                            <Popover.Target>
                              <div
                                className={styles['editable-field']}
                                onClick={() => {
                                  const next = !popoverVisible.enumMappings[row.id]
                                  setPopoverVisible((p) => ({
                                    ...p,
                                    enumMappings: { ...p.enumMappings, [row.id]: next },
                                  }))
                                  if (next) initEnumMappingsText(row)
                                }}
                              >
                                {row.enum_mappings?.mappings?.length ? (
                                  <>
                                    <span className={`${styles['field-value']} ${styles.truncate}`}>
                                      {formatEnumMappingsPreview(row.enum_mappings)}
                                    </span>
                                    <span className={styles['count-badge']}>
                                      {row.enum_mappings.mappings.length}
                                    </span>
                                  </>
                                ) : (
                                  <span className={styles.placeholder}>{t('database.tableEdit.clickToEdit')}</span>
                                )}
                              </div>
                            </Popover.Target>
                            <Popover.Dropdown>
                              <div className={styles['field-editor']}>
                                <div className={styles['editor-header']}>
                                  <span>{t('database.tableEdit.editEnumValues')}</span>
                                  <span className={styles['editor-tip']}>{t('database.tableEdit.enumFormat')}</span>
                                </div>
                                <Textarea
                                  value={enumMappingsText[row.id] || ''}
                                  onChange={(e) =>
                                    setEnumMappingsText((prev) => ({ ...prev, [row.id]: e.currentTarget.value }))
                                  }
                                  autosize
                                  minRows={8}
                                  maxRows={8}
                                  placeholder={'1=正常\n2=异常\n3=待处理'}
                                />
                                <div className={styles['editor-footer']}>
                                  {enumJsonError[row.id] && (
                                    <span className={styles['json-error']}>{enumJsonError[row.id]}</span>
                                  )}
                                  <div className={styles['footer-buttons']}>
                                    <Button
                                      size="xs"
                                      variant="default"
                                      onClick={() =>
                                        setPopoverVisible((p) => ({
                                          ...p,
                                          enumMappings: { ...p.enumMappings, [row.id]: false },
                                        }))
                                      }
                                    >
                                      {t('database.action.cancel')}
                                    </Button>
                                    <Button size="xs" loading={saving} onClick={() => saveEnumMappings(row)}>
                                      {t('database.action.save')}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </Popover.Dropdown>
                          </Popover>
                        </Table.Td>

                        {/* High recall */}
                        <Table.Td style={{ textAlign: 'center' }}>
                          <Checkbox
                            checked={!!row.is_high_recall}
                            onChange={(e) => toggleHighRecall(row, e.currentTarget.checked)}
                            style={{ display: 'inline-flex', justifyContent: 'center' }}
                          />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
              {/* Pagination */}
              {totalColumnPages > 1 && (
                <div className={styles['column-pagination']}>
                  {/* layout: total, sizes, prev, pager, next */}
                  <span className={styles['column-count']}>
                    {t('database.tableEdit.totalColumns', { count: filteredColumns.length })}
                  </span>
                  <Select
                    size="xs"
                    style={{ width: 90 }}
                    value={String(columnPageSize)}
                    onChange={(v) => handleColumnSizeChange(Number(v) || 10)}
                    data={[
                      { value: '10', label: '10' },
                      { value: '20', label: '20' },
                      { value: '50', label: '50' },
                    ]}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: true }}
                  />
                  <Pagination
                    value={columnCurrentPage}
                    onChange={setColumnCurrentPage}
                    total={totalColumnPages}
                    size="sm"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

              {/* Footer */}
      <div className={styles['dialog-footer']}>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => props.onClose?.()}>
            {t('database.action.close')}
          </Button>
        </Group>
      </div>
    </Modal>
  )
}
