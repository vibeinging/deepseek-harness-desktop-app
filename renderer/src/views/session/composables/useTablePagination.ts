/**
 * Table pagination logic.
 */
import { useCallback, useRef, useState } from 'react'

interface TablePaginationState {
  currentPage: number
  pageSize: number
}

export function useTablePagination() {
  // Table pagination state (key: messageId-blockIndex)
  // State triggers re-render; ref mirror keeps callbacks reading the latest values (prevents stale closures).
  const [tablePagination, setTablePagination] = useState<Map<string, TablePaginationState>>(
    () => new Map()
  )
  const paginationRef = useRef(tablePagination)
  paginationRef.current = tablePagination

  // Get or initialize table pagination state.
  const getTablePagination = useCallback(
    (messageId: any, blockIndex: any): TablePaginationState => {
      const key = `${messageId}-${blockIndex}`
      const current = paginationRef.current
      if (!current.has(key)) {
        const init: TablePaginationState = {
          currentPage: 1,
          pageSize: 10
        }
        // On initialization, write back to state with a new Map to trigger re-render.
        const next = new Map(current)
        next.set(key, init)
        paginationRef.current = next
        setTablePagination(next)
        return init
      }
      return current.get(key)!
    },
    []
  )

  // Get table data.
  const getTableData = useCallback((data: any): any[] => {
    if (!data || typeof data !== 'object') {
      return []
    }

    // New format: { data: [...] }
    if (data.data && Array.isArray(data.data)) {
      return data.data
    }

    // Legacy format: { rows: [] }
    if (data.rows && Array.isArray(data.rows)) {
      return data.rows
    }

    return []
  }, [])

  // Get table columns.
  const getTableColumns = useCallback((data: any): any[] => {
    if (!data || typeof data !== 'object') {
      return []
    }

    // New format: { data: [...], fields: [...] }
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      if (data.fields && Array.isArray(data.fields)) {
        return data.fields.map((f: any) => f.alias || f.expression || f)
      }
      return Object.keys(data.data[0])
    }

    // Legacy format: { headers: [], rows: [] }
    if (data.headers && Array.isArray(data.headers)) {
      return data.headers
    }

    return []
  }, [])

  // Get paginated table rows.
  const getPaginatedTableData = useCallback(
    (data: any, messageId: any, blockIndex: any): any[] => {
      const rows = getTableData(data)
      const pagination = getTablePagination(messageId, blockIndex)
      const start = (pagination.currentPage - 1) * pagination.pageSize
      const end = start + pagination.pageSize
      return rows.slice(start, end)
    },
    [getTableData, getTablePagination]
  )

  // Handle page number changes.
  const handleTablePageChange = useCallback((messageId: any, blockIndex: any, page: number) => {
    const key = `${messageId}-${blockIndex}`
    const current = paginationRef.current
    const pagination = current.get(key)
    if (pagination) {
      const next = new Map(current)
      next.set(key, { ...pagination, currentPage: page })
      paginationRef.current = next
      setTablePagination(next)
    }
  }, [])

  // Handle page size changes.
  const handleTableSizeChange = useCallback((messageId: any, blockIndex: any, size: number) => {
    const key = `${messageId}-${blockIndex}`
    const current = paginationRef.current
    const pagination = current.get(key)
    if (pagination) {
      const next = new Map(current)
      next.set(key, { ...pagination, pageSize: size, currentPage: 1 })
      paginationRef.current = next
      setTablePagination(next)
    }
  }, [])

  // Clear all pagination state (called on session switch / full reload to avoid unbounded Map growth).
  const clearTablePagination = useCallback(() => {
    const next = new Map<string, TablePaginationState>()
    paginationRef.current = next
    setTablePagination(next)
  }, [])

  // Clear pagination state for a specific messageId (called when a message is deleted).
  const clearTablePaginationFor = useCallback((messageId: any) => {
    const prefix = `${messageId}-`
    const current = paginationRef.current
    const next = new Map(current)
    for (const key of current.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
      }
    }
    paginationRef.current = next
    setTablePagination(next)
  }, [])

  // Build table summary text.
  const getTableSummary = useCallback(
    (data: any): string => {
      const rows = getTableData(data)
      if (rows.length === 0) {
        return '无数据'
      }
      const row_count = data.row_count !== undefined ? data.row_count : rows.length
      return `共 ${row_count} 条数据`
    },
    [getTableData]
  )

  return {
    tablePagination,
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    handleTablePageChange,
    handleTableSizeChange,
    getTableSummary,
    clearTablePagination,
    clearTablePaginationFor
  }
}
