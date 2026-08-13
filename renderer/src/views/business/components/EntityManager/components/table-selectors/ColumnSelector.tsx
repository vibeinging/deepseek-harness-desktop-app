import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, TextInput, Pagination, Center, Text } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './ColumnSelector.module.scss'

// Column object (kept same field convention as original Vue component)
export interface ColumnItem {
  column_name: string
  description?: string
  data_type?: string
  [key: string]: any
}

// Selected columns (payload emitted via onSelect/onAddColumns)
export interface SelectedColumn {
  table_id: string | number | null
  table_name: string
  column_name: string
  description?: string
  data_type?: string
}

export interface ColumnSelectorProps {
  columns?: ColumnItem[]
  tableId?: string | number | null
  tableName?: string
  // 'single': click to add immediately; 'multi': select multiple and add in batch
  mode?: 'single' | 'multi'
  // List of already added column names (used to disable them)
  disabledColumns?: string[]
  pageSize?: number
  // defineEmits(['select', 'add-columns'])
  onSelect?: (column: ColumnItem) => void
  onAddColumns?: (columns: SelectedColumn[]) => void
}

export default function ColumnSelector({
  columns = [],
  tableId = null,
  tableName = '',
  mode = 'single',
  disabledColumns = [],
  pageSize = 20,
  onSelect,
  onAddColumns,
}: ColumnSelectorProps) {
  const { t } = useTranslation()

  const [searchKeyword, setSearchKeyword] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedColumns, setSelectedColumns] = useState<SelectedColumn[]>([])

  const filteredColumns = useMemo<ColumnItem[]>(() => {
    if (!searchKeyword.trim()) {
      return columns
    }
    const keyword = searchKeyword.toLowerCase().trim()
    return columns.filter(
      (col) =>
        col.column_name.toLowerCase().includes(keyword) ||
        (col.description && col.description.toLowerCase().includes(keyword)),
    )
  }, [columns, searchKeyword])

  const paginatedColumns = useMemo<ColumnItem[]>(() => {
    const start = (currentPage - 1) * pageSize
    const end = start + pageSize
    return filteredColumns.slice(start, end)
  }, [filteredColumns, currentPage, pageSize])

  const totalPages = useMemo(() => {
    return Math.ceil(filteredColumns.length / pageSize)
  }, [filteredColumns, pageSize])

  const isColumnDisabled = (columnName: string) => {
    return disabledColumns.includes(columnName)
  }

  const isColumnSelected = (column: ColumnItem) => {
    return selectedColumns.some(
      (c) => c.table_id === tableId && c.column_name === column.column_name,
    )
  }

  const selectableColumns = useMemo<ColumnItem[]>(() => {
    return filteredColumns.filter((col) => !isColumnDisabled(col.column_name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredColumns, disabledColumns])

  const isAllSelected = useMemo(() => {
    if (selectableColumns.length === 0) return false
    return selectableColumns.every((col) => isColumnSelected(col))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectableColumns, selectedColumns, tableId])

  const isSomeSelected = useMemo(() => {
    if (selectableColumns.length === 0) return false
    return selectableColumns.some((col) => isColumnSelected(col))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectableColumns, selectedColumns, tableId])

  const handleSearch = (val: string) => {
    setSearchKeyword(val)
    setCurrentPage(1)
  }

  const handleColumnClick = (column: ColumnItem) => {
    if (isColumnDisabled(column.column_name)) return
    onSelect?.(column)
  }

  const onColumnCheckChange = (column: ColumnItem, checked: boolean) => {
    if (checked) {
      if (!isColumnSelected(column)) {
        setSelectedColumns((prev) => [
          ...prev,
          {
            table_id: tableId,
            table_name: tableName,
            column_name: column.column_name,
            description: column.description,
            data_type: column.data_type,
          },
        ])
      }
    } else {
      setSelectedColumns((prev) =>
        prev.filter(
          (c) => !(c.table_id === tableId && c.column_name === column.column_name),
        ),
      )
    }
  }

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedColumns((prev) => {
        const next = [...prev]
        for (const col of selectableColumns) {
          const already = next.some(
            (c) => c.table_id === tableId && c.column_name === col.column_name,
          )
          if (!already) {
            next.push({
              table_id: tableId,
              table_name: tableName,
              column_name: col.column_name,
              description: col.description,
              data_type: col.data_type,
            })
          }
        }
        return next
      })
    } else {
      // Remove all columns of current table
      setSelectedColumns((prev) => prev.filter((c) => c.table_id !== tableId))
    }
  }

  const addSelectedColumns = () => {
    if (selectedColumns.length > 0) {
      onAddColumns?.([...selectedColumns])
      setSelectedColumns([])
    }
  }

  // Reset when table changes
  useEffect(() => {
    setCurrentPage(1)
    setSearchKeyword('')
    setSelectedColumns([])
  }, [tableId])

  return (
    <div className={styles.columnSelectArea}>
      <div className={styles.areaHeader}>
        <h4>{t('business.entity.selectColumn')}</h4>
      </div>
      {tableId ? (
        <>
          <div className={styles.areaHeader}>
            <div className={styles.columnActions}>
              <TextInput
                value={searchKeyword}
                placeholder={t('business.entity.searchFieldPlaceholder')}
                leftSection={<ElSvgIcon name="Search" size={14} />}
                size="xs"
                onChange={(e) => handleSearch(e.currentTarget.value)}
              />
              {/* In multi-select mode, show Select all + Add buttons */}
              {mode === 'multi' && (
                <>
                  <Checkbox
                    size="xs"
                    checked={isAllSelected}
                    indeterminate={isSomeSelected && !isAllSelected}
                    onChange={(e) => toggleSelectAll(e.currentTarget.checked)}
                    label={t('business.entity.selectAll')}
                  />
                  <Button
                    size="xs"
                    disabled={selectedColumns.length === 0}
                    onClick={addSelectedColumns}
                    leftSection={<ElSvgIcon name="Plus" size={14} />}
                  >
                    {t('business.entity.add')} ({selectedColumns.length})
                  </Button>
                </>
              )}
            </div>
          </div>
          {filteredColumns.length > 0 ? (
            <div className={styles.columnsCheckboxList}>
              {paginatedColumns.map((column) => {
                const disabled = isColumnDisabled(column.column_name)
                const itemClass = [
                  styles.columnCheckboxItem,
                  disabled ? styles.disabled : '',
                  mode === 'single' ? styles.clickable : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <div
                    key={column.column_name}
                    className={itemClass}
                    onClick={() => mode === 'single' && handleColumnClick(column)}
                  >
              {/* Multi-select mode */}
                    {mode === 'multi' ? (
                      <Checkbox
                        className={styles.columnCheckbox}
                        checked={isColumnSelected(column)}
                        disabled={disabled}
                        onChange={(e) =>
                          onColumnCheckChange(column, e.currentTarget.checked)
                        }
                        label={
                          <div className={styles.columnInfo}>
                            <span className={styles.columnName}>{column.column_name}</span>
                            {column.description && (
                              <span
                                className={styles.columnDesc}
                                title={column.description}
                              >
                                {column.description}
                              </span>
                            )}
                          </div>
                        }
                      />
                    ) : (
                      /* Single-select mode */
                      <>
                        <div className={styles.columnInfo}>
                          <span className={styles.columnName}>{column.column_name}</span>
                          {column.description && (
                            <span className={styles.columnDesc} title={column.description}>
                              {column.description}
                            </span>
                          )}
                        </div>
                        <span className={styles.addIcon}>
                          <ElSvgIcon name="Plus" size={16} />
                        </span>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className={styles.noColumnsMini}>
              <span>
                {searchKeyword
                  ? t('business.entity.noMatchingColumns')
                  : t('business.entity.noColumns')}
              </span>
            </div>
          )}
          {totalPages > 1 && (
            <div className={styles.columnPaginationMini}>
              <Pagination
                value={currentPage}
                total={totalPages}
                onChange={setCurrentPage}
                size="xs"
                withControls
              />
            </div>
          )}
        </>
      ) : (
        <div className={styles.noTableSelectedHint}>
          {/* Replaced el-empty with Center + Text */}
          <Center style={{ flexDirection: 'column', gap: 8 }}>
            <ElSvgIcon name="Files" size={60} color="#dcdfe6" />
            <Text size="sm" c="dimmed">
              {t('business.entity.selectTableFirst')}
            </Text>
          </Center>
        </div>
      )}
    </div>
  )
}
