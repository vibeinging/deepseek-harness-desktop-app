import { useState, useMemo, useEffect } from 'react'
import { TextInput, Pagination } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './TableSelector.module.scss'

interface TableItem {
  id: string | number
  table_name: string
  description?: string
  [key: string]: any
}

interface TableSelectorProps {
  tables?: TableItem[]
  activeTableId?: string | number | null
  // Table IDs with selected columns (used to show selection markers)
  selectedTableIds?: Array<string | number>
  pageSize?: number
  onSelect?: (table: TableItem) => void
}

export default function TableSelector({
  tables = [],
  activeTableId = null,
  selectedTableIds = [],
  pageSize = 15,
  onSelect,
}: TableSelectorProps) {
  const { t } = useTranslation()

  const [searchKeyword, setSearchKeyword] = useState('')
  const [currentPage, setCurrentPage] = useState(1)

  const filteredTables = useMemo(() => {
    if (!searchKeyword.trim()) {
      return tables
    }
    const keyword = searchKeyword.toLowerCase().trim()
    return tables.filter(
      (table) =>
        table.table_name.toLowerCase().includes(keyword) ||
        (table.description && table.description.toLowerCase().includes(keyword))
    )
  }, [tables, searchKeyword])

  const paginatedTables = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    const end = start + pageSize
    return filteredTables.slice(start, end)
  }, [filteredTables, currentPage, pageSize])

  const totalPages = useMemo(() => {
    return Math.ceil(filteredTables.length / pageSize)
  }, [filteredTables.length, pageSize])

  const handleSearch = (value: string) => {
    setSearchKeyword(value)
    setCurrentPage(1)
  }

  const getTableSelectedCount = (tableId: string | number) => {
    return selectedTableIds.filter((id) => id === tableId).length
  }

  const selectTable = (table: TableItem) => {
    onSelect?.(table)
  }

  // Reset pagination when tables change
  useEffect(() => {
    setCurrentPage(1)
    setSearchKeyword('')
  }, [tables])

  return (
    <div className={styles['table-select-area']}>
      <div className={styles['area-header']}>
        <h4>{t('business.entity.selectTable')}</h4>
      </div>
      <div className={styles['table-search-box']}>
        <TextInput
          value={searchKeyword}
          placeholder={t('business.entity.searchTablePlaceholder')}
          leftSection={<ElSvgIcon name="Search" />}
          size="xs"
          onChange={(e) => handleSearch(e.currentTarget.value)}
        />
      </div>
      {filteredTables.length > 0 ? (
        <div className={styles['tables-list-container']}>
          {paginatedTables.map((table) => (
            <div
              key={table.id}
              className={`${styles['table-list-item']}${
                activeTableId === table.id ? ` ${styles.active}` : ''
              }`}
              onClick={() => selectTable(table)}
            >
              <span className={styles['table-name']}>{table.table_name}</span>
              {getTableSelectedCount(table.id) > 0 && (
                <span className={styles['table-selected-badge']}>
                  {getTableSelectedCount(table.id)}
                </span>
              )}
              {table.description && (
                <span
                  className={styles['table-desc']}
                  title={table.description}
                >
                  {table.description}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles['no-tables-mini']}>
          <span>
            {searchKeyword
              ? t('business.entity.noMatchingTables')
              : t('business.entity.noTables')}
          </span>
        </div>
      )}
      {totalPages > 1 && (
        <div className={styles['table-pagination-mini']}>
          <Pagination
            value={currentPage}
            total={totalPages}
            size="sm"
            onChange={setCurrentPage}
          />
        </div>
      )}
    </div>
  )
}
