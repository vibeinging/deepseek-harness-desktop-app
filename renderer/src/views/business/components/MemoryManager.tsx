import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FileButton,
  LoadingOverlay,
  Modal,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconRefresh,
  IconUpload,
  IconPlus,
  IconSearch,
  IconTrash,
  IconDownload,
  IconPlugConnected,
  IconLayoutGrid,
  IconTarget,
  IconWand,
  IconArrowRight,
  IconCircleCheck
} from '@tabler/icons-react'
import * as XLSX from 'xlsx'
import { useResponsive } from '@/hooks/use-responsive'
import SingleTableColumnPicker from './SingleTableColumnPicker'
import SemanticEmptyState from './SemanticEmptyState'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  getMemoryListReq,
  createMemoryReq,
  updateMemoryReq,
  deleteMemoryReq,
  bulkDeleteMemoryReq,
  bulkImportMemoryReq
} from '@/api/memory'
import { getBusinessDataSourcesReq } from '@/api/business'
import styles from './MemoryManager.module.scss'

interface MemoryManagerProps {
  projectId: string
  businessId: string
}

interface FormData {
  source_id: string
  source_type: string
  source_table: string
  source_column: string
  keyword: string
  keywords: string[]
  chosen_value: string
}

const EMPTY_FORM: FormData = {
  source_id: '',
  source_type: '',
  source_table: '',
  source_column: '',
  keyword: '',
  keywords: [],
  chosen_value: ''
}

export default function MemoryManager({ projectId, businessId }: MemoryManagerProps) {
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // List and pagination
  const [loading, setLoading] = useState(false)
  const [memoryList, setMemoryList] = useState<any[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [searchKeyword, setSearchKeyword] = useState('')

  // Bulk selection
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<any>>(new Set())
  const selectedCount = selectedIds.size
  const isAllSelected = memoryList.length > 0 && selectedIds.size === memoryList.length
  const isIndeterminate = selectedCount > 0 && !isAllSelected

  // Data sources
  const [dataSources, setDataSources] = useState<any[]>([])
  const [connectionId, setConnectionId] = useState<any>(null)
  const [selectedSourceType, setSelectedSourceType] = useState<string>('database')
  const [selectedDatabaseConnectionId, setSelectedDatabaseConnectionId] = useState<any>(null)

  // Keyword tag input
  const [keywordDraft, setKeywordDraft] = useState('')

  // Form
  const [formDialogVisible, setFormDialogVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [formData, setFormData] = useState<FormData>({ ...EMPTY_FORM })
  // Form validation errors (equivalent to el-form rules)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  // Bulk import
  const [bulkImportDialogVisible, setBulkImportDialogVisible] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [bulkImportOverwrite, setBulkImportOverwrite] = useState(true)
  const resetFileRef = useRef<() => void>(null)

  // Props reference for watch dependency checks
  const propsRef = useRef({ projectId, businessId })
  propsRef.current = { projectId, businessId }

  // Partially update formData fields
  const patchForm = (patch: Partial<FormData>) => setFormData((prev) => ({ ...prev, ...patch }))

  // Dialog width: full-screen on mobile, fixed width on desktop
  const dialogWidth = isMobile ? '96%' : '880px'

  // Preview: summary for creating N memory records
  const previewCount = editingId ? 0 : formData.keywords.length
  const previewSummary = useMemo(() => {
    if (editingId) return ''
    const { source_table, source_column, chosen_value } = formData
    if (!source_table || !source_column || !chosen_value) return ''
    return `${source_table}.${source_column} → ${chosen_value}`
  }, [editingId, formData])

  const formatTime = (value: any) => {
    if (!value) return '—'
    const dt = new Date(value)
    if (isNaN(dt.getTime())) return value
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
  }

  const loadList = async (resetPage = false) => {
    const { projectId: pid, businessId: bid } = propsRef.current
    if (!pid || !bid) return
    let page = currentPage
    if (resetPage) {
      page = 1
      setCurrentPage(1)
    }
    setLoading(true)
    try {
      const res: any = await getMemoryListReq(pid, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        search: searchKeyword.trim()
      })
      const items = res?.items || res?.data?.items || []
      setMemoryList(items)
      setTotalCount(res?.total ?? res?.data?.total ?? items.length)
    } catch (err) {
      notifications.show({ color: 'red', message: t('business.memory.loadFailed', '加载记忆失败') })
      setMemoryList([])
      setTotalCount(0)
    } finally {
      setLoading(false)
    }
  }

  const loadDataSources = async () => {
    const { projectId: pid, businessId: bid } = propsRef.current
    try {
      const res: any = await getBusinessDataSourcesReq(pid)
      if (!res?.success) return
      const data = res.data || {}
      const sources: any[] = []
      ;(data.database_connections || []).forEach((ds: any) => {
        sources.push({
          id: `db_${ds.id}`,
          name: ds.name || ds.connection_name || ds.display_name || 'Database',
          source_id: ds.id,
          source_type: ds.source_type,
          db_type: ds.db_type,
          type: 'database'
        })
      })
      ;(data.structured_data_sources || []).forEach((ds: any) => {
        sources.push({
          id: `struct_${ds.id}`,
          name: ds.name || ds.display_name || 'Structured',
          source_id: ds.id,
          source_type: ds.source_type,
          database_connection_id: ds.database_connection_id,
          type: 'structured'
        })
      })
      setDataSources(sources)
    } catch (e) {
      // Silent failure: if data source loading fails, do not block list browsing
    }
  }

  const handleSearch = () => loadList(true)

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
  }
  const handlePageSizeChange = (size: string | null) => {
    if (!size) return
    setPageSize(Number(size))
    setCurrentPage(1)
  }

  // Reload on page change (matches el-pagination current/size change)
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize])

  // Multi-select
  const isSelected = (id: any) => selectedIds.has(id)
  const setSelected = (id: any, val: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (val) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelectedIds(isAllSelected ? new Set() : new Set(memoryList.map((m) => m.id)))
  }
  const enterBulkDeleteMode = () => {
    setBulkDeleteMode(true)
    setSelectedIds(new Set(memoryList.map((m) => m.id)))
  }
  const exitBulkDeleteMode = () => {
    setBulkDeleteMode(false)
    setSelectedIds(new Set())
  }

  const confirmBulkDelete = () => {
    if (selectedCount === 0) {
      notifications.show({ color: 'yellow', message: t('business.memory.selectFirst', '请先选择要删除的记忆') })
      return
    }
    modals.openConfirmModal({
      title: t('business.memory.confirmDelete', '确认删除'),
      children: t('business.memory.confirmBulkDeleteMsg', '将删除 {count} 条记忆，下次相同关键词会重新让团队确认。', {
        count: selectedCount
      }),
      labels: {
        confirm: t('business.memory.delete', '删除'),
        cancel: t('common.cancel', '取消')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await bulkDeleteMemoryReq(propsRef.current.projectId, Array.from(selectedIds)
          )
          const deleted = res?.data?.deleted_count ?? selectedCount
          notifications.show({
            color: 'green',
            message: t('business.memory.bulkDeleteSuccess', '已删除 {count} 条记忆', { count: deleted })
          })
          exitBulkDeleteMode()
          await loadList(true)
        } catch (err) {
          notifications.show({ color: 'red', message: t('business.memory.deleteFailed', '删除失败') })
        }
      }
    })
  }

  const handleRowClick = (row: any) => {
    if (bulkDeleteMode) return
    openEditDialog(row)
  }

  const handleDelete = (row: any) => {
    modals.openConfirmModal({
      title: t('business.memory.confirmDelete', '确认删除'),
      children: t('business.memory.confirmDeleteOne', '删除「{keyword} → {value}」？下次相同关键词会重新让您确认。', {
        keyword: row.normalized_keyword,
        value: row.chosen_value
      }),
      labels: {
        confirm: t('business.memory.delete', '删除'),
        cancel: t('common.cancel', '取消')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteMemoryReq(propsRef.current.projectId, row.id)
          notifications.show({ color: 'green', message: t('business.memory.deleteSuccess', '已删除') })
          setMemoryList((prev) => prev.filter((m) => m.id !== row.id))
          setTotalCount((prev) => Math.max(0, prev - 1))
        } catch (err) {
          notifications.show({ color: 'red', message: t('business.memory.deleteFailed', '删除失败') })
        }
      }
    })
  }

  // Form
  const resetForm = () => {
    setEditingId('')
    setFormData({ ...EMPTY_FORM })
    setConnectionId(null)
    setSelectedSourceType('database')
    setSelectedDatabaseConnectionId(null)
    setKeywordDraft('')
    setFormErrors({})
  }

  const addKeyword = () => {
    const kw = keywordDraft.trim()
    if (!kw) return
    if (formData.keywords.includes(kw)) {
      setKeywordDraft('')
      return
    }
    patchForm({ keywords: [...formData.keywords, kw] })
    setKeywordDraft('')
  }

  const removeKeyword = (idx: number) => {
    patchForm({ keywords: formData.keywords.filter((_, i) => i !== idx) })
  }

  // When input is empty, Backspace deletes last tag (common tag-input behavior)
  const onBackspace = () => {
    if (!keywordDraft && formData.keywords.length > 0) {
      patchForm({ keywords: formData.keywords.slice(0, -1) })
    }
  }

  const handleDataSourceChange = (sourceId: any) => {
    const ds = dataSources.find((x) => x.source_id === sourceId)
    if (ds) {
      setConnectionId(sourceId)
      setSelectedSourceType(ds.type)
      setSelectedDatabaseConnectionId(ds.database_connection_id || null)
      // Switching data source clears table/column
      patchForm({ source_id: sourceId, source_type: ds.source_type, source_table: '', source_column: '' })
    } else {
      setConnectionId(null)
      setSelectedSourceType('database')
      setSelectedDatabaseConnectionId(null)
      patchForm({ source_id: sourceId || '', source_type: '', source_table: '', source_column: '' })
    }
  }

  const openCreateDialog = async () => {
    resetForm()
    if (dataSources.length === 0) await loadDataSources()
    setFormDialogVisible(true)
  }

  const openEditDialog = async (row: any) => {
    resetForm()
    setEditingId(row.id)
    setFormData({
      ...EMPTY_FORM,
      keyword: row.normalized_keyword || '',
      chosen_value: row.chosen_value || '',
      source_table: row.source_table || '',
      source_column: row.source_column || ''
    })
    if (dataSources.length === 0) await loadDataSources()
    // In edit mode, schema has no source_id linkage — user manually selects data source so list can load.
    // table/column is passed via v-model to picker; picker can display current values without relying on data source.
    setFormDialogVisible(true)
  }

  // Validate form (equivalent to el-form rules + formRef.validate)
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!editingId) {
      if (!formData.source_id) {
        errors.source_id = t('business.memory.dataSourceRequired', '请选择数据源')
      }
    }
    if (!formData.source_table || !formData.source_column) {
      errors.source_column = t('business.memory.selectTableColumn', '请选择一对表 / 列')
    }
    if (editingId) {
      if (!formData.keyword.trim()) {
        errors.keyword = t('business.memory.keywordRequired', '关键词必填')
      }
    } else {
      if (!Array.isArray(formData.keywords) || formData.keywords.length === 0) {
        errors.keywords = t('business.memory.keywordsRequired', '至少添加一个关键词')
      }
    }
    if (!formData.chosen_value.trim()) {
      errors.chosen_value = t('business.memory.chosenValueRequired', '真值必填')
    }
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const submitForm = async () => {
    if (!validateForm()) return
    if (!formData.source_table || !formData.source_column) {
      notifications.show({ color: 'yellow', message: t('business.memory.selectTableColumn', '请选择一对表 / 列') })
      return
    }
    setSubmitting(true)
    try {
      const basePayload = {
        source_table: formData.source_table.trim(),
        source_column: formData.source_column.trim(),
        chosen_value: formData.chosen_value.trim()
      }
      if (editingId) {
        await updateMemoryReq(propsRef.current.projectId, editingId, {
          ...basePayload,
          keyword: formData.keyword.trim()
        })
        notifications.show({ color: 'green', message: t('business.memory.updateSuccess', '已保存') })
      } else {
        const keywords = (formData.keywords || []).map((k) => String(k).trim()).filter(Boolean)
        const res: any = await createMemoryReq(propsRef.current.projectId, {
          ...basePayload,
          keywords
        })
        const message = res?.message || res?.data?.message
        if (message) notifications.show({ color: 'green', message })
        else notifications.show({ color: 'green', message: t('business.memory.createSuccess', '已创建') })
      }
      setFormDialogVisible(false)
      await loadList(!editingId)
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || ''
      notifications.show({
        color: 'red',
        message:
          (editingId
            ? t('business.memory.updateFailed', '保存失败')
            : t('business.memory.createFailed', '创建失败')) + (msg ? `: ${msg}` : '')
      })
    } finally {
      setSubmitting(false)
    }
  }

  // Bulk import
  const openBulkImportDialog = () => {
    setSelectedFile(null)
    setBulkImportOverwrite(true)
    resetFileRef.current?.()
    setBulkImportDialogVisible(true)
  }
  const handleFileChange = (file: File | null) => {
    if (!file) return
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      notifications.show({ color: 'yellow', message: t('business.memory.importInvalidFile', '请上传 .xlsx 或 .xls 文件') })
      resetFileRef.current?.()
      return
    }
    setSelectedFile(file)
  }

  const downloadTemplate = () => {
    try {
      const templateData = [
        {
          source_table: 'suppliers',
          source_column: 'supplier_name',
          keyword: '宏远',
          chosen_value: '宏远科技有限公司'
        },
        {
          source_table: 'suppliers',
          source_column: 'supplier_name',
          keyword: '宏元',
          chosen_value: '宏远科技有限公司'
        },
        {
          source_table: 'suppliers',
          source_column: 'supplier_name',
          keyword: '天弘',
          chosen_value: '天弘基金管理有限公司'
        }
      ]
      const workbook = XLSX.utils.book_new()
      const worksheet = XLSX.utils.json_to_sheet(templateData)
      worksheet['!cols'] = [{ wch: 24 }, { wch: 20 }, { wch: 16 }, { wch: 36 }]
      XLSX.utils.book_append_sheet(workbook, worksheet, '记忆导入模板')
      XLSX.writeFile(workbook, '记忆导入模板.xlsx')
      notifications.show({ color: 'green', message: t('business.memory.templateDownloaded', '模板已下载') })
    } catch (err) {
      notifications.show({ color: 'red', message: t('business.memory.templateDownloadFailed', '模板下载失败') })
    }
  }

  const submitBulkImport = async () => {
    if (!selectedFile) {
      notifications.show({ color: 'yellow', message: t('business.memory.selectFileFirst', '请先选择文件') })
      return
    }
    setImporting(true)
    try {
      const res: any = await bulkImportMemoryReq(propsRef.current.projectId, selectedFile,
        bulkImportOverwrite
      )
      const result = res?.data || {}
      const errors = result.errors || []
      if (errors.length > 0) {
        modals.open({
          title: t('business.memory.importPartialFailed', '部分行导入失败'),
          children: (
            <div style={{ whiteSpace: 'pre-wrap' }}>
              {errors
                .slice(0, 20)
                .map((e: any) => `${t('business.memory.rowLabel', '行')} ${e.row}: ${e.error}`)
                .join('\n') +
                (errors.length > 20
                  ? `\n...（${t('business.memory.totalErrors', '共 {n} 条错误', { n: errors.length })}）`
                  : '')}
            </div>
          )
        })
      } else {
        notifications.show({ color: 'green', message: result.message || t('business.memory.importSuccess', '导入成功') })
      }
      setBulkImportDialogVisible(false)
      await loadList(true)
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || ''
      notifications.show({
        color: 'red',
        message: t('business.memory.importFailed', '导入失败') + (msg ? `: ${msg}` : '')
      })
    } finally {
      setImporting(false)
    }
  }

  // Watch projectId / businessId changes (equivalent to watch [projectId, businessId], immediate: false)
  const firstPropsWatchRef = useRef(true)
  useEffect(() => {
    if (firstPropsWatchRef.current) {
      firstPropsWatchRef.current = false
      return
    }
    setSearchKeyword('')
    setCurrentPage(1)
    loadList()
    loadDataSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, businessId])

  // Sync bulk selection when list changes (equivalent to watch memoryList)
  useEffect(() => {
    if (!bulkDeleteMode) return
    setSelectedIds(new Set((memoryList || []).map((m) => m.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryList])

  // Reset when bulk import modal closes (equivalent to watch bulkImportDialogVisible)
  useEffect(() => {
    if (!bulkImportDialogVisible) {
      setSelectedFile(null)
      setBulkImportOverwrite(true)
      resetFileRef.current?.()
    }
  }, [bulkImportDialogVisible])

  // onMounted
  useEffect(() => {
    ;(async () => {
      await loadList()
      await loadDataSources()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Data source dropdown options
  const dataSourceOptions = useMemo(
    () => dataSources.map((ds) => ({ value: ds.source_id, label: ds.name, type: ds.type })),
    [dataSources]
  )

  const showEmpty = !loading && memoryList.length === 0 && !searchKeyword

  return (
    <div className={styles.tabContainer}>
      <div className={styles.contentCard} style={{ position: 'relative' }}>
        <LoadingOverlay visible={loading} zIndex={5} />
        {/* Header operations area (hidden in empty state; empty state already shows create/import CTA) */}
        {!showEmpty && (
        <div className={styles.operationsHeader}>
          <div className={styles.headerIntro}>
            <span>
              {t(
                'business.memory.headerIntro',
                '团队在对话中确认过的字面量 → 真实值映射。下次同字面量会作为候选优先排序。'
              )}
            </span>
          </div>
          <div className={styles.headerActions}>
            <TextInput
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.currentTarget.value)}
              placeholder={t('business.memory.searchPlaceholder', '搜索关键词 / 真值 / 字段')}
              className={styles.searchInput}
              leftSection={<IconSearch size={16} />}
              onKeyUp={(e) => {
                if (e.key === 'Enter') handleSearch()
              }}
            />
            <Button
              color="red"
              variant="light"
              disabled={bulkDeleteMode ? selectedCount === 0 : memoryList.length === 0}
              leftSection={<IconTrash size={16} />}
              onClick={() => (bulkDeleteMode ? confirmBulkDelete() : enterBulkDeleteMode())}
            >
              {bulkDeleteMode
                ? t('business.memory.bulkDelete', '删除所选') + (selectedCount > 0 ? `(${selectedCount})` : '')
                : t('business.memory.bulkDeleteMode', '批量删除')}
            </Button>
            <Button variant="default" leftSection={<IconPlus size={16} />} onClick={openCreateDialog}>
              {t('business.memory.createMemory', '新建记忆')}
            </Button>
            <Button variant="default" leftSection={<IconUpload size={16} />} onClick={openBulkImportDialog}>
              {t('business.memory.import', '批量导入')}
            </Button>
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              loading={loading}
              onClick={() => loadList(true)}
            >
              {t('business.memory.refresh', '刷新')}
            </Button>
          </div>
        </div>
        )}

        {/* Memory list */}
        {showEmpty ? (
          <SemanticEmptyState
            icon={<ElSvgIcon name="Star" size={26} color="#fff" />}
            satellites={[
              <ElSvgIcon key="a" name="Connection" size={20} />,
              <ElSvgIcon key="b" name="Search" size={20} />
            ]}
            title={t('business.memory.emptyTitle', '记忆库')}
            description={t('business.memory.emptyDesc', '尚无记忆——团队在对话中做选择后会自动累积')}
            features={[
              { icon: <ElSvgIcon name="Connection" size={16} />, label: t('business.memory.feature1', '对话中自动沉淀') },
              { icon: <ElSvgIcon name="Search" size={16} />, label: t('business.memory.feature2', '字面量映射') },
              { icon: <ElSvgIcon name="Star" size={16} />, label: t('business.memory.feature3', '优先命中') }
            ]}
            actions={
              <>
                <Button onClick={openCreateDialog}>
                  {t('business.memory.createMemory', '新建记忆')}
                </Button>
                <Button variant="default" onClick={openBulkImportDialog}>
                  {t('business.memory.import', '批量导入')}
                </Button>
              </>
            }
          />
        ) : (
          <div className={styles.memoryList}>
            <Table className={styles.memoryTable} style={{ width: '100%', marginTop: 10 }}>
              <Table.Thead>
                <Table.Tr>
                  {bulkDeleteMode && (
                    <Table.Th style={{ width: 120, textAlign: 'center' }}>
                      <div className={styles.bulkSelectHeader} onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isAllSelected}
                          indeterminate={isIndeterminate}
                          onChange={() => toggleSelectAll()}
                        />
                        <span className={styles.bulkSelectCancel} onClick={exitBulkDeleteMode}>
                          {t('business.memory.cancelBulk', '取消')}
                        </span>
                      </div>
                    </Table.Th>
                  )}
                  <Table.Th style={{ minWidth: 200 }}>{t('business.memory.columns.field', '字段')}</Table.Th>
                  <Table.Th style={{ minWidth: 140 }}>{t('business.memory.columns.keyword', '关键词')}</Table.Th>
                  <Table.Th style={{ minWidth: 180 }}>
                    {t('business.memory.columns.chosenValue', '选定的真值')}
                  </Table.Th>
                  <Table.Th style={{ width: 100, textAlign: 'center' }}>
                    {t('business.memory.columns.hitCount', '命中次数')}
                  </Table.Th>
                  <Table.Th style={{ width: 170 }}>{t('business.memory.columns.lastUsedAt', '最近使用')}</Table.Th>
                  <Table.Th style={{ width: 120 }}>{t('business.memory.columns.createdBy', '创建者')}</Table.Th>
                  <Table.Th style={{ width: 120, textAlign: 'right' }}>
                    {t('business.memory.columns.actions', '操作')}
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {memoryList.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={bulkDeleteMode ? 8 : 7} style={{ textAlign: 'center', color: '#909399' }}>
                      {t('business.memory.noSearchResults', '没有匹配的记忆')}
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  memoryList.map((row) => (
                    <Table.Tr
                      key={row.id}
                      className={styles.memoryRow}
                      style={{ cursor: 'pointer' }}
                      onClick={() => handleRowClick(row)}
                    >
                      {bulkDeleteMode && (
                        <Table.Td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected(row.id)}
                            onChange={(e) => setSelected(row.id, e.currentTarget.checked)}
                          />
                        </Table.Td>
                      )}
                      <Table.Td>
                        <Tooltip label={`${row.source_table}.${row.source_column}`} withinPortal>
                          <span className={styles.mono}>
                            {row.source_table}.{row.source_column}
                          </span>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td>{row.normalized_keyword}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" color="green" variant="light">
                          {row.chosen_value}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'center' }}>
                        <Badge size="sm" color="gray" variant="light">
                          {row.hit_count || 0}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <span className={styles.monoTime}>{formatTime(row.last_used_at)}</span>
                      </Table.Td>
                      <Table.Td>
                        {row.created_by_name ? (
                          <span className={styles.createdBy}>{row.created_by_name}</span>
                        ) : (
                          <span className={styles.emptyText}>—</span>
                        )}
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        <div className={styles.actionLinks} onClick={(e) => e.stopPropagation()}>
                          <span className={`${styles.actionLink} ${styles.primary}`} onClick={() => openEditDialog(row)}>
                            {t('business.memory.edit', '编辑')}
                          </span>
                          <span className={`${styles.actionLink} ${styles.danger}`} onClick={() => handleDelete(row)}>
                            {t('business.memory.delete', '删除')}
                          </span>
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>

            {/* Pagination */}
            {totalCount > 0 && (
              <div className={styles.paginationWrapper}>
                <Text size="sm" c="dimmed" style={{ marginRight: 'auto' }}>
                  {t('common.total', '共')} {totalCount}
                </Text>
                {!isMobile && (
                  <Select
                    value={String(pageSize)}
                    onChange={handlePageSizeChange}
                    data={[20, 50, 100, 200].map((n) => ({ value: String(n), label: `${n}/页` }))}
                    style={{ width: 100, marginRight: 12 }}
                    size="xs"
                    allowDeselect={false}
                  />
                )}
                <Pagination
                  value={currentPage}
                  onChange={handlePageChange}
                  total={Math.max(1, Math.ceil(totalCount / pageSize))}
                  size={isMobile ? 'sm' : 'md'}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create / Edit dialog */}
      <Modal
        opened={formDialogVisible}
        onClose={() => {
          setFormDialogVisible(false)
          resetForm()
        }}
        title={
          editingId
            ? t('business.memory.editMemory', '编辑记忆')
            : t('business.memory.createMemory', '新建记忆')
        }
        size={dialogWidth}
        styles={{ inner: { paddingTop: '6vh', alignItems: 'flex-start' } }}
      >
        <div className={styles.memoryForm}>
          {/* Section 1: Data location */}
          <div className={styles.formSection}>
            <div className={styles.sectionTitle}>
              <IconTarget size={18} className={styles.sectionIcon} />
              <span>{t('business.memory.sectionLocation', '记忆位置')}</span>
              <span className={styles.sectionHint}>
                {t('business.memory.sectionLocationHint', '指明这条记忆要补在哪张表的哪一列')}
              </span>
            </div>
            <div className={styles.sectionBody}>
              <Select
                label={t('business.metric.relatedDataSource', '关联数据源')}
                placeholder={t('business.metric.selectDataSource', '请选择数据源')}
                clearable
                value={formData.source_id || null}
                onChange={(v) => handleDataSourceChange(v)}
                error={formErrors.source_id}
                data={dataSourceOptions}
                className={styles.fullControl}
                renderOption={({ option }: any) => (
                  <div className={styles.rowSC} style={{ gap: 8 }}>
                    {option.type === 'database' ? (
                      <IconPlugConnected size={16} />
                    ) : (
                      <IconLayoutGrid size={16} />
                    )}
                    <span>{option.label}</span>
                  </div>
                )}
                mb="md"
              />

              <div>
                {/* TODO(migration): SingleTableColumnPicker is still a stub, pass values via original v-model:table/column contract */}
                <Text size="sm" fw={500} mb={8}>
                  {t('business.memory.fieldTableColumn', '表 / 列')}
                </Text>
                <SingleTableColumnPicker
                  table={formData.source_table}
                  column={formData.source_column}
                  onUpdateTable={(v: any) => patchForm({ source_table: v })}
                  onUpdateColumn={(v: any) => patchForm({ source_column: v })}
                  databaseId={connectionId}
                  sourceType={selectedSourceType}
                  databaseConnectionId={selectedDatabaseConnectionId}
                />
                {formErrors.source_column && (
                  <Text size="xs" c="red" mt={4}>
                    {formErrors.source_column}
                  </Text>
                )}
              </div>
            </div>
          </div>

          {/* Section 2: Keywords → Chosen value mapping */}
          <div className={`${styles.formSection} ${styles.mappingSection}`}>
            <div className={styles.sectionTitle}>
              <IconWand size={18} className={styles.sectionIcon} />
              <span>{t('business.memory.sectionMapping', '关键词映射')}</span>
              {!editingId && (
                <span className={styles.sectionHint}>
                  {t('business.memory.sectionMappingHint', '多个用户字面量 → 同一个真值')}
                </span>
              )}
            </div>

            <div className={styles.mappingBody}>
              {/* Keywords side */}
              <div className={`${styles.mappingSide} ${styles.keywordsSide}`}>
                <div className={styles.sideLabel}>
                  <span className={styles.sideLabelText}>{t('business.memory.columns.keyword', '关键词')}</span>
                  {!editingId && formData.keywords.length > 0 && (
                    <Badge size="sm" radius="xl">
                      {formData.keywords.length}
                    </Badge>
                  )}
                </div>

                {!editingId ? (
                  <>
                    <div className={styles.keywordTagsArea}>
                      {formData.keywords.map((kw, idx) => (
                        <Badge
                          key={`${kw}-${idx}`}
                          className={styles.keywordTag}
                          color="blue"
                          variant="light"
                          rightSection={
                            <span
                              style={{ cursor: 'pointer', display: 'inline-flex' }}
                              onClick={() => removeKeyword(idx)}
                            >
                              ×
                            </span>
                          }
                        >
                          {kw}
                        </Badge>
                      ))}
                      {formData.keywords.length === 0 && (
                        <span className={styles.emptyHint}>
                          {t('business.memory.noKeywordsYet', '尚未添加关键词')}
                        </span>
                      )}
                    </div>
                    <div className={styles.noMarginFormItem}>
                      <div className={styles.addKeywordRow}>
                        <TextInput
                          value={keywordDraft}
                          onChange={(e) => setKeywordDraft(e.currentTarget.value)}
                          placeholder={t(
                            'business.memory.keywordsPlaceholder',
                            '输入关键词后按回车添加；可添加多个，都映射到同一真值'
                          )}
                          className={styles.addKeywordInput}
                          error={formErrors.keywords}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addKeyword()
                            } else if (e.key === 'Backspace') {
                              onBackspace()
                            }
                          }}
                        />
                        <Button color="primary" disabled={!keywordDraft.trim()} onClick={addKeyword}>
                          <IconPlus size={16} />
                          <span style={{ marginLeft: 4 }}>{t('common.add', '添加')}</span>
                        </Button>
                      </div>
                    </div>
                    <div className={styles.sideTip}>
                      {t('business.memory.keywordsTipShort', '例：宏远、宏元、宏远科技 → 宏远科技有限公司')}
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.noMarginFormItem}>
                      <TextInput
                        value={formData.keyword}
                        onChange={(e) => patchForm({ keyword: e.currentTarget.value })}
                        placeholder={t('business.memory.keywordPlaceholder', '用户问句中的字面量')}
                        error={formErrors.keyword}
                      />
                    </div>
                    <div className={styles.sideTip}>
                      {t(
                        'business.memory.editKeywordHint',
                        '只编辑当前这一条；要为同一真值新增别名，请用"新建记忆"。'
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Arrow */}
              <div className={styles.mappingArrow}>
                <IconArrowRight size={34} />
                <span className={styles.arrowLabel}>{t('business.memory.mapsTo', '映射到')}</span>
              </div>

              {/* Chosen value side */}
              <div className={`${styles.mappingSide} ${styles.chosenSide}`}>
                <div className={styles.sideLabel}>
                  <span className={styles.sideLabelText}>{t('business.memory.columns.chosenValue', '真值')}</span>
                  <Badge size="sm" radius="xl" color="green">
                    1
                  </Badge>
                </div>
                <div className={styles.noMarginFormItem}>
                  <TextInput
                    value={formData.chosen_value}
                    onChange={(e) => patchForm({ chosen_value: e.currentTarget.value })}
                    placeholder={t('business.memory.chosenValuePlaceholder', '库内真实值，例如：宏远科技有限公司')}
                    error={formErrors.chosen_value}
                  />
                </div>
                <div className={styles.sideTip}>
                  {t('business.memory.chosenValueTip', '需为库内真实存在的值；后续会作为对齐结果直接进入 SQL。')}
                </div>
              </div>
            </div>
          </div>

          {/* Preview */}
          {!editingId && previewCount > 0 && (
            <div className={styles.formPreview}>
              <IconCircleCheck size={18} />
              <span>{t('business.memory.willCreateN', '将创建 {n} 条记忆', { n: previewCount })}</span>
              {previewSummary && <span className={styles.previewSummary}>{previewSummary}</span>}
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setFormDialogVisible(false)}>
            {t('common.cancel', '取消')}
          </Button>
          <Button color="primary" loading={submitting} onClick={submitForm}>
            {editingId ? t('common.save', '保存') : t('common.create', '创建')}
          </Button>
        </div>
      </Modal>

      {/* Bulk import dialog */}
      <Modal
        opened={bulkImportDialogVisible}
        onClose={() => setBulkImportDialogVisible(false)}
        title={t('business.memory.import', '批量导入')}
        size="560px"
      >
        <div className={styles.bulkImportContent}>
          <Alert color="blue" variant="light" style={{ marginBottom: 16 }} title={t('business.memory.importFormatTitle', 'Excel 格式说明')}>
            <div>
              <strong>{t('business.memory.importRequiredCols', '必需列（不限顺序）：')}</strong>
            </div>
            <ul>
              <li>
                <code>source_table</code>: {t('business.memory.importColTable', '物理表名（含库前缀，若有）')}
              </li>
              <li>
                <code>source_column</code>: {t('business.memory.importColColumn', '物理列名')}
              </li>
              <li>
                <code>keyword</code>: {t('business.memory.importColKeyword', '用户字面量（会自动规范化）')}
              </li>
              <li>
                <code>chosen_value</code>: {t('business.memory.importColChosen', '库内真实值（最长 512 字符）')}
              </li>
            </ul>
            <div style={{ marginTop: 8, color: '#909399', fontSize: 12 }}>
              {t(
                'business.memory.importNote',
                '说明：同 (table, column, keyword) 已存在时，可勾选下方"覆盖"选项决定是否更新；空字段行会被拒绝并在结果中列出。同一真值可对应多个关键词——写多行即可。'
              )}
            </div>
          </Alert>

          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <Button color="primary" leftSection={<IconDownload size={16} />} onClick={downloadTemplate}>
              {t('business.memory.downloadTemplate', '下载模板')}
            </Button>
            <FileButton
              resetRef={resetFileRef}
              accept=".xlsx,.xls"
              onChange={handleFileChange}
            >
              {(buttonProps) => <Button variant="default" {...buttonProps}>{t('business.memory.selectFile', '选择 Excel 文件')}</Button>}
            </FileButton>
          </div>

          {selectedFile && (
            <div className={styles.selectedFile} style={{ marginBottom: 16 }}>
              <Text>
                {t('business.memory.selectedFile', '已选择')}: {selectedFile.name}
              </Text>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Checkbox
              checked={bulkImportOverwrite}
              onChange={(e) => setBulkImportOverwrite(e.currentTarget.checked)}
              label={t('business.memory.overwriteExisting', '覆盖已存在的记忆（同 表+列+关键词）')}
            />
            <Text c="dimmed" size="sm" style={{ marginLeft: 8, marginTop: 4 }}>
              {t('business.memory.overwriteTip', '不勾选则跳过同唯一键的行')}
            </Text>
          </div>
        </div>

        <div className={styles.modalFooter}>
          <Button variant="default" onClick={() => setBulkImportDialogVisible(false)}>
            {t('common.cancel', '取消')}
          </Button>
          <Button color="primary" loading={importing} disabled={!selectedFile} onClick={submitBulkImport}>
            {t('business.memory.startImport', '开始导入')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
