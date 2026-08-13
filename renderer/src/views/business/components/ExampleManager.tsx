import { useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Modal,
  Textarea,
  TextInput,
  Badge,
  SegmentedControl,
  Group,
  Switch,
  Pagination,
  Select,
  Loader,
  LoadingOverlay,
  Center,
  Text,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useResponsive } from '@/hooks/use-responsive'
import {
  getExamplesReq,
  getExamplesStatsReq,
  createExamplesReq,
  updateExampleReq,
  deleteExamplesReq,
  searchExamplesReq,
  generateExampleEmbeddingsReq,
} from '@/api/business-semantic'
import ExampleEmptyState from './ExampleEmptyState'
import styles from './ExampleManager.module.scss'

export interface ExampleManagerProps {
  projectId: string
  businessId: string
}

interface ExampleItem {
  question: string
  content: string
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export default function ExampleManager({ projectId, businessId }: ExampleManagerProps) {
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // Reactive data
  const [examplesStats, setExamplesStats] = useState<any>({
    total_examples: 0,
    status: 'empty',
    collection_name: '',
    database_id: businessId,
  })

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showSearchDialog, setShowSearchDialog] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [adding, setAdding] = useState(false)
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_deleting, setDeleting] = useState(false)
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generatingExampleId, setGeneratingExampleId] = useState<any>(null)
  const [togglingExampleId, setTogglingExampleId] = useState<any>(null)
  const [searchQuestion, setSearchQuestion] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [examplesList, setExamplesList] = useState<any[]>([])
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<{ id: any; question: string; content: string }>({
    id: '',
    question: '',
    content: '',
  })

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  })

  // Add sample dialog-related state
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form') // 'form' or 'json'
  const [exampleItems, setExampleItems] = useState<ExampleItem[]>([{ question: '', content: '' }]) // Sample list in form mode
  const [jsonInput, setJsonInput] = useState('') // Input for JSON mode

  // Hidden file input (replacement for el-upload)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Computed
  const formattedJsonInput = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonInput)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return t('business.example.invalidJsonFormat')
    }
  }, [jsonInput, t])

  // Methods
  const loadExamplesStats = async () => {
    try {
      const response: any = await getExamplesStatsReq(projectId)
      if (response.success) {
        setExamplesStats(response.data)
      }
    } catch (error) {
      console.error('加载样例统计失败:', error)
    }
  }

  // Add one sample row
  const addExampleItem = () => {
    setExampleItems((prev) => [...prev, { question: '', content: '' }])
  }

  // Remove one sample row
  const removeExampleItem = (index: number) => {
    setExampleItems((prev) => {
      if (prev.length > 1) {
        const next = [...prev]
        next.splice(index, 1)
        return next
      }
      return prev
    })
  }

  // Update a field in one sample row
  const updateExampleItem = (index: number, key: keyof ExampleItem, value: string) => {
    setExampleItems((prev) => prev.map((item, i) => (i === index ? { ...item, [key]: value } : item)))
  }

  // Handle file upload
  const handleFileUpload = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string
        // Parse JSON
        const parsed = JSON.parse(content)

        if (!Array.isArray(parsed)) {
          notifications.show({ color: 'red', message: t('business.example.jsonMustBeArray') })
          return
        }

        // Validate each sample's fields
        const validItems = parsed.filter((item: any) => {
          if (!item.question || !item.content) {
            return false
          }
          return true
        })

        if (validItems.length === 0) {
          notifications.show({ color: 'red', message: t('business.example.noValidExamples') })
          return
        }

        // Append to form data; clear placeholder row first if it is the only empty row
        setExampleItems((prev) => {
          let base = prev
          if (prev.length === 1 && !prev[0].question && !prev[0].content) {
            base = []
          }
          // Append new sample data
          const appended = validItems.map((item: any) => ({
            question: item.question.trim(),
            content: item.content.trim(),
          }))
          return [...base, ...appended]
        })

        // Switch to form mode
        setInputMode('form')

        notifications.show({
          color: 'green',
          message: t('business.example.importSuccess', { count: validItems.length }),
        })
      } catch (error: any) {
        notifications.show({
          color: 'red',
          message: t('business.example.jsonFileFormatError', { message: error.message }),
        })
      }
    }
    reader.onerror = () => {
      notifications.show({ color: 'red', message: t('business.example.fileReadFailed') })
    }
    reader.readAsText(file)
  }

  // File input change
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileUpload(file)
    }
    // Allow selecting the same file again
    e.target.value = ''
  }

  // Export JSON file
  const handleExportJson = async () => {
    try {
      // Read all sample data
      const response: any = await getExamplesReq(projectId, 1, 999999)

      if (!response || !response.success || !response.data?.items) {
        notifications.show({ color: 'red', message: t('business.example.getExamplesFailed') })
        return
      }

      const examples = response.data.items.map((item: any) => ({
        question: item.question,
        content: item.content,
      }))

      if (examples.length === 0) {
        notifications.show({ color: 'yellow', message: t('business.example.noExamplesExport') })
        return
      }

      // Build JSON string
      const jsonStr = JSON.stringify(examples, null, 2)

      // Create Blob
      const blob = new Blob([jsonStr], { type: 'application/json' })

      // Create download link
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `examples_${businessId}_${new Date().getTime()}.json`

      // Trigger download
      document.body.appendChild(link)
      link.click()

      // Cleanup
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      notifications.show({
        color: 'green',
        message: t('business.example.exportSuccess', { count: examples.length }),
      })
    } catch (error: any) {
      console.error('导出失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.exportFailed') + ': ' + error.message,
      })
    }
  }

  // Edit sample
  const handleEditExample = (example: any) => {
    // Fill edit form
    setEditForm({
      id: example.id,
      question: example.question,
      content: example.content,
    })
    setShowEditDialog(true)
  }

  // Save edited sample
  const handleSaveEdit = async () => {
    try {
      if (!editForm.question.trim() || !editForm.content.trim()) {
        notifications.show({ color: 'yellow', message: t('business.example.questionAnswerRequired') })
        return
      }

      setEditing(true)

      // Update sample directly
      await updateExampleReq(projectId, editForm.id, {
        question: editForm.question.trim(),
        content: editForm.content.trim(),
      })

      notifications.show({ color: 'green', message: t('business.example.editSuccess') })
      setShowEditDialog(false)

      // Refresh list
      await loadExamplesStats()
      await loadExamplesList()
    } catch (error: any) {
      console.error('编辑失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.editFailed') + ': ' + error.message,
      })
    } finally {
      setEditing(false)
    }
  }

  // Copy sample
  const copyExample = (example: any) => {
    // Fill form and open add dialog
    setInputMode('form')
    setExampleItems([
      {
        question: example.question + ` (${t('business.example.copyLabel')})`,
        content: example.content,
      },
    ])
    setShowAddDialog(true)
  }

  // Toggle sample active state
  const toggleExampleActive = async (example: any, isActive: boolean) => {
    try {
      setTogglingExampleId(example.id)
      const response: any = await updateExampleReq(projectId, example.id, {
        is_active: isActive,
      })
      if (response.success) {
        // Update local state
        setExamplesList((prev) =>
          prev.map((item) => (item.id === example.id ? { ...item, is_active: isActive } : item))
        )
        notifications.show({
          color: 'green',
          message: isActive ? t('business.example.enabled') : t('business.example.disabled'),
        })
      }
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: t('business.example.operationFailed') + ': ' + error.message,
      })
    } finally {
      setTogglingExampleId(null)
    }
  }

  // Generate embedding for one sample
  const generateSingleEmbedding = async (example: any) => {
    try {
      setGeneratingExampleId(example.id)
      const response: any = await generateExampleEmbeddingsReq(projectId, example.id)
      if (response.success) {
        notifications.show({ color: 'green', message: t('business.example.vectorGenSuccess') })
        await loadExamplesList()
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.singleVectorGenFailed') + ': ' + error.message,
      })
    } finally {
      setGeneratingExampleId(null)
    }
  }

  // Generate embeddings for all samples
  const generateAllEmbeddings = async () => {
    if (examplesList.length === 0) {
      notifications.show({ color: 'yellow', message: t('business.example.noExamplesVector') })
      return
    }

    try {
      setGeneratingAll(true)
      notifications.show({ color: 'blue', message: t('business.example.startVectorGen') })

      const response: any = await generateExampleEmbeddingsReq(projectId)

      if (response.success) {
        notifications.show({ color: 'green', message: t('business.example.allVectorGenSuccess') })
        await loadExamplesList()
      }
    } catch (error: any) {
      console.error('批量生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.batchVectorGenFailed') + ': ' + error.message,
      })
    } finally {
      setGeneratingAll(false)
    }
  }

  const handleAddExamples = async () => {
    try {
      let parsedExamples: any[] = []

      // Load data based on input mode
      if (inputMode === 'form') {
        // Form mode: validate and transform
        const validItems = exampleItems.filter((item) => item.question.trim() && item.content.trim())

        if (validItems.length === 0) {
          notifications.show({ color: 'yellow', message: t('business.example.fillAtLeastOne') })
          return
        }

        parsedExamples = validItems.map((item) => ({
          question: item.question.trim(),
          content: item.content.trim(),
        }))
      } else {
        // JSON mode: parse and validate
        if (!jsonInput.trim()) {
          notifications.show({ color: 'yellow', message: t('business.example.pleaseInputData') })
          return
        }

        try {
          parsedExamples = JSON.parse(jsonInput)
          if (!Array.isArray(parsedExamples)) {
            throw new Error(t('business.example.jsonMustBeArray'))
          }

          // Validate all required fields for each sample
          for (let i = 0; i < parsedExamples.length; i++) {
            const example = parsedExamples[i]
            if (!example.question || !example.content) {
              throw new Error(t('business.example.exampleMissingFields', { index: i + 1 }))
            }
            // Keep only question/content fields by removing extras
            parsedExamples[i] = {
              question: example.question.trim(),
              content: example.content.trim(),
            }
          }
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('business.example.jsonFormatError') + ': ' + error.message,
          })
          return
        }
      }

      setAdding(true)

      const response: any = await createExamplesReq(projectId, {
        examples: parsedExamples,
        example_type: 'sql',
      })

      if (response.success) {
        notifications.show({
          color: 'green',
          message: response.msg || t('business.example.addSuccess'),
        })
        setShowAddDialog(false)
        // Clear form
        setExampleItems([{ question: '', content: '' }])
        setJsonInput('')
        await loadExamplesStats()
        await loadExamplesList()
      } else {
        notifications.show({ color: 'red', message: response.msg || t('business.example.addFailed') })
      }
    } catch (error: any) {
      console.error('添加样例失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.addFailed') + ': ' + error.message,
      })
    } finally {
      setAdding(false)
    }
  }

  // Note: handleClearAll is not bound in Vue template, but kept for business parity
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleClearAll = async () => {
    modals.openConfirmModal({
      title: t('business.example.confirmClearTitle'),
      children: t('business.example.confirmClearMsg'),
      labels: {
        confirm: t('business.example.confirm'),
        cancel: t('business.example.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          // Load all sample IDs
          const allIds = examplesList.map((item) => item.id)
          if (allIds.length === 0) {
            notifications.show({ color: 'yellow', message: t('business.example.noExamplesClear') })
            return
          }

          const response: any = await deleteExamplesReq(projectId, allIds)
          if (response.success) {
            notifications.show({
              color: 'green',
              message: response.msg || t('business.example.clearSuccess'),
            })
            await loadExamplesStats()
            await loadExamplesList()
          } else {
            notifications.show({
              color: 'red',
              message: response.msg || t('business.example.clearFailed'),
            })
          }
        } catch (error: any) {
          console.error('清空样例失败:', error)
          notifications.show({
            color: 'red',
            message: t('business.example.clearFailed') + ': ' + error.message,
          })
        }
      },
    })
  }

  const handleTestSearch = async () => {
    if (!searchQuestion.trim()) {
      notifications.show({ color: 'yellow', message: t('business.example.pleaseInputSearch') })
      return
    }

    try {
      setSearching(true)
      setHasSearched(true)

      const response: any = await searchExamplesReq(projectId, searchQuestion)

      if (response.success) {
        setSearchResults(response.data?.items || [])
      } else {
        notifications.show({ color: 'red', message: response.msg || t('business.example.searchFailed') })
      }
    } catch (error: any) {
      console.error('搜索样例失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.searchFailed') + ': ' + error.message,
      })
    } finally {
      setSearching(false)
    }
  }

  const handlePageChange = (page: number) => {
    setPagination((prev) => ({ ...prev, page }))
  }

  const handlePageSizeChange = (pageSize: number) => {
    setPagination((prev) => ({ ...prev, pageSize, page: 1 }))
  }

  const handleDeleteExample = (example: any) => {
    modals.openConfirmModal({
      title: t('business.example.confirmDeleteTitle'),
      children: t('business.example.confirmDeleteMsg', {
        question: example.question.substring(0, 50),
      }),
      labels: {
        confirm: t('business.example.confirm'),
        cancel: t('business.example.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          setDeleting(true)

          const response: any = await deleteExamplesReq(projectId, [example.id])

          if (response.success) {
            notifications.show({ color: 'green', message: t('business.example.deleteSuccess') })
            // Go back one page if current page had one item and is not the first page
            if (examplesList.length === 1 && pagination.page > 1) {
              setPagination((prev) => ({ ...prev, page: prev.page - 1 }))
            } else {
              await loadExamplesList()
            }
            await loadExamplesStats()
          } else {
            notifications.show({
              color: 'red',
              message: response.msg || t('business.example.deleteFailed'),
            })
          }
        } catch (error: any) {
          console.error('删除样例失败:', error)
          notifications.show({
            color: 'red',
            message: t('business.example.deleteFailed') + ': ' + error.message,
          })
        } finally {
          setDeleting(false)
        }
      },
    })
  }

  const loadExamplesList = async () => {
    try {
      setLoading(true)
      const response: any = await getExamplesReq(projectId, pagination.page,
        pagination.pageSize
      )

      if (response && response.success) {
        setExamplesList(response.data?.items || [])
        setPagination((prev) => {
          const total = response.data?.total || 0
          let totalPages
          // Calculate total pages: use total_pages when present, otherwise derive from total and pageSize
          if (response.data?.total_pages !== undefined) {
            totalPages = response.data.total_pages
          } else {
            totalPages = total > 0 ? Math.ceil(total / prev.pageSize) : 0
          }
          return { ...prev, total, totalPages }
        })
      } else {
        // Clear list if response is unsuccessful
        setExamplesList([])
        setPagination((prev) => ({ ...prev, total: 0, totalPages: 0 }))
      }
    } catch (error: any) {
      console.error('加载样例列表失败:', error)
      // Clear list on error instead of showing error when empty data is expected
      setExamplesList([])
      setPagination((prev) => ({ ...prev, total: 0, totalPages: 0 }))
      // Show error toast only when error is not 404
      if (error.response?.status !== 404) {
        notifications.show({ color: 'red', message: t('business.example.loadListFailed') })
      }
    } finally {
      setLoading(false)
    }
  }

  // Close add dialog (and clear form)
  const handleDialogClose = () => {
    if (adding) return
    // Clear form
    setExampleItems([{ question: '', content: '' }])
    setJsonInput('')
    setShowAddDialog(false)
  }

  // Add sample from empty state
  const handleAddFirst = () => {
    setInputMode('form')
    setShowAddDialog(true)
  }

  // Bulk import from empty state
  const handleBulkImport = () => {
    setInputMode('json')
    setShowAddDialog(true)
  }

  // Watchers
  // Watch databaseId changes (immediate)
  useEffect(() => {
    if (businessId) {
      setExamplesStats((prev: any) => ({ ...prev, database_id: businessId }))
      loadExamplesStats()
      loadExamplesList()
    } else {
      // Reset state
      setExamplesStats({
        total_examples: 0,
        status: 'empty',
        collection_name: '',
        database_id: businessId,
      })
      setExamplesList([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  // Reload when page / pageSize changes (equivalent to original handlePageChange/handlePageSizeChange calling loadExamplesList)
  useEffect(() => {
    if (businessId) {
      loadExamplesList()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.page, pagination.pageSize])

  return (
    <div className={styles.tabContainer}>
      {/* Unified content card */}
      <div className={styles.contentCard}>
        <LoadingOverlay visible={loading} zIndex={5} />

        {/* Top action area */}
        {examplesList.length > 0 && (
          <div className={styles.operationsHeader}>
            <div className={styles.headerIntro}>
              <span>{t('business.example.headerIntro')}</span>
            </div>
            <div className={styles.headerActions}>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Search" size={16} />}
                onClick={() => setShowSearchDialog(true)}
              >
                {t('business.example.searchExample')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Plus" size={16} />}
                onClick={() => setShowAddDialog(true)}
              >
                {t('business.example.addExample')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Download" size={16} />}
                onClick={handleExportJson}
                disabled={examplesList.length === 0}
              >
                {t('business.example.exportAll')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Connection" size={16} />}
                onClick={generateAllEmbeddings}
                loading={generatingAll}
                disabled={examplesList.length === 0}
              >
                {t('business.example.generateAllVectors')}
              </Button>
            </div>
          </div>
        )}

        {/* Search area removed, moved into dialog */}

        {/* Content area */}
        {/* Empty state */}
        {!loading && examplesList.length === 0 ? (
          <ExampleEmptyState onAddFirst={handleAddFirst} onBulkImport={handleBulkImport} />
        ) : (
          /* when data exists */
          <div className={styles.examplesList}>
            <table className={styles.examplesTable}>
              <thead>
                <tr>
                  <th className={styles.colCenter} style={{ width: 70 }}>
                    {t('business.example.enable')}
                  </th>
                  <th style={{ minWidth: 200 }}>{t('business.example.question')}</th>
                  <th style={{ minWidth: 250 }}>{t('business.example.answer')}</th>
                  <th className={styles.colCenter} style={{ width: 120 }}>
                    {t('business.example.vectorization')}
                  </th>
                  <th className={styles.colRight} style={{ width: 150 }}>
                    {t('business.example.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {examplesList.map((row) => (
                  <tr key={row.id} onClick={() => handleEditExample(row)}>
                    <td className={styles.colCenter}>
                      <Switch
                        size="sm"
                        checked={!!row.is_active}
                        onChange={(event) => toggleExampleActive(row, event.currentTarget.checked)}
                        disabled={togglingExampleId === row.id}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td>
                      <span className={styles.questionText}>{row.question}</span>
                    </td>
                    <td>
                      <span className={styles.sqlText}>{row.content}</span>
                    </td>
                    <td>
                      <div className={styles.embeddingCell} onClick={(e) => e.stopPropagation()}>
                        <Badge size="sm" color={row.has_embedding ? 'green' : 'yellow'} variant="light">
                          {row.has_embedding
                            ? t('business.example.vectorized')
                            : t('business.example.notVectorized')}
                        </Badge>
                        {generatingExampleId !== row.id ? (
                          <span
                            className={styles.refreshIcon}
                            title={
                              row.has_embedding
                                ? t('business.example.reVectorize')
                                : t('business.example.vectorize')
                            }
                            onClick={() => generateSingleEmbedding(row)}
                          >
                            <ElSvgIcon name="Refresh" size={14} />
                          </span>
                        ) : (
                          <span className={`${styles.refreshIcon} ${styles.loading}`}>
                            <Loader size={14} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className={styles.actionLinks} onClick={(e) => e.stopPropagation()}>
                        <span
                          className={`${styles.actionLink} ${styles.primary}`}
                          onClick={() => copyExample(row)}
                        >
                          {t('business.example.copy')}
                        </span>
                        <span
                          className={`${styles.actionLink} ${styles.primary}`}
                          onClick={() => handleEditExample(row)}
                        >
                          {t('business.example.edit')}
                        </span>
                        <span
                          className={`${styles.actionLink} ${styles.danger}`}
                          onClick={() => handleDeleteExample(row)}
                        >
                          {t('business.example.delete')}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {pagination.total > 0 && searchResults.length === 0 && (
              <div className={styles.paginationWrapper}>
                <Group gap="sm" wrap="wrap" justify={isMobile ? 'flex-start' : 'center'}>
                  <Text size="sm" c="dimmed">
                    {t('common.total', '共')} {pagination.total}
                  </Text>
                  {!isMobile && (
                    <Select
                      size="xs"
                      w={110}
                      data={['10', '20', '50', '100'].map((v) => ({
                        value: v,
                        label: `${v} / page`,
                      }))}
                      value={String(pagination.pageSize)}
                      onChange={(val) => val && handlePageSizeChange(Number(val))}
                      allowDeselect={false}
                    />
                  )}
                  <Pagination
                    total={pagination.totalPages}
                    value={pagination.page}
                    onChange={handlePageChange}
                    size="sm"
                  />
                </Group>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add sample dialog */}
      <Modal
        opened={showAddDialog}
        onClose={handleDialogClose}
        title={t('business.example.addExampleData')}
        size="85%"
        closeOnClickOutside={false}
      >
        <div className={styles.addExamplesContainer}>
          {/* Top toolbar */}
          <div className={styles.dialogTopActions}>
            {/* Input mode switcher */}
            <div className={styles.modeSwitch}>
              <SegmentedControl
                value={inputMode}
                onChange={(val) => setInputMode(val as 'form' | 'json')}
                data={[
                  { value: 'form', label: t('business.example.formMode') },
                  { value: 'json', label: t('business.example.bulkImport') },
                ]}
              />
            </div>

            {/* Upload button */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={onFileInputChange}
              />
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Upload" size={16} />}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('business.example.uploadJson')}
              </Button>
            </div>
          </div>

          {/* Form mode */}
          {inputMode === 'form' ? (
            <div className={styles.formMode}>
              <div className={styles.examplesList}>
                {exampleItems.map((item, index) => (
                  <div key={index} className={styles.exampleItemCard}>
                    <div className={styles.cardHeader}>
                      <span className={styles.itemIndex}>
                        {t('business.example.exampleIndex', { index: index + 1 })}
                      </span>
                      <Button
                        variant="subtle"
                        color="gray"
                        size="compact-sm"
                        onClick={() => removeExampleItem(index)}
                        disabled={exampleItems.length === 1}
                        leftSection={<ElSvgIcon name="Delete" size={14} color="#f56c6c" />}
                      >
                        {t('business.example.delete')}
                      </Button>
                    </div>
                    <div className={styles.cardBody}>
                      <div className={styles.formItem}>
                        <label className={styles.formLabel}>{t('business.example.question')}</label>
                        <Textarea
                          value={item.question}
                          onChange={(e) => updateExampleItem(index, 'question', e.currentTarget.value)}
                          autosize
                          minRows={1}
                          placeholder={t('business.example.questionPlaceholder')}
                        />
                      </div>
                      <div className={styles.formItem}>
                        <label className={styles.formLabel}>{t('business.example.answer')}</label>
                        <Textarea
                          value={item.content}
                          onChange={(e) => updateExampleItem(index, 'content', e.currentTarget.value)}
                          autosize
                          minRows={3}
                          placeholder={t('business.example.answerPlaceholder')}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Button
                variant="default"
                onClick={addExampleItem}
                style={{ width: '100%', marginTop: 12 }}
                leftSection={<ElSvgIcon name="Plus" size={16} />}
              >
                {t('business.example.addMore')}
              </Button>
            </div>
          ) : (
            /* JSON mode */
            <div className={styles.jsonMode}>
              <Textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.currentTarget.value)}
                autosize
                minRows={15}
                maxRows={15}
                placeholder={t('business.example.jsonPlaceholder')}
              />
              {jsonInput && (
                <div className={styles.jsonPreview}>
                  <h4>{t('business.example.jsonPreview')}</h4>
                  <pre className={styles.jsonCode}>{formattedJsonInput}</pre>
                </div>
              )}
            </div>
          )}

          {/* Usage instructions */}
          <div
            style={{
              marginTop: 16,
              padding: '12px 16px',
              borderRadius: 8,
              background: 'var(--el-color-info-light-9, #f4f4f5)',
              border: '1px solid var(--el-color-info-light-7, #dedfe0)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#303133' }}>
              {t('business.example.usageGuideTitle')}
            </div>
            <ul className={styles.usageGuide} style={{ margin: 0, paddingLeft: 20 }}>
              <li>{t('business.example.usageGuide1')}</li>
              <li>{t('business.example.usageGuide2')}</li>
              <li>{t('business.example.usageGuide3')}</li>
              <li>{t('business.example.usageGuide4')}</li>
            </ul>
          </div>
        </div>

        {/* footer */}
        <div className={styles.dialogFooter} style={{ marginTop: 16 }}>
          <Button variant="default" onClick={handleDialogClose}>
            {t('business.example.cancel')}
          </Button>
          <Button onClick={handleAddExamples} loading={adding}>
            {adding ? t('business.example.adding') : t('business.example.confirmAdd')}
          </Button>
        </div>
      </Modal>

      {/* Edit sample dialog */}
      <Modal
        opened={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        title={t('business.example.editExample')}
        size="80%"
      >
        <div className={styles.editForm}>
          <div className={styles.formItem}>
            <label className={styles.formLabel}>{t('business.example.question')}</label>
            <Textarea
              value={editForm.question}
              onChange={(e) => setEditForm((prev) => ({ ...prev, question: e.currentTarget.value }))}
              autosize
              minRows={3}
              maxRows={3}
              placeholder={t('business.example.inputQuestion')}
            />
          </div>
          <div className={styles.formItem}>
            <label className={styles.formLabel}>{t('business.example.answer')}</label>
            <Textarea
              value={editForm.content}
              onChange={(e) => setEditForm((prev) => ({ ...prev, content: e.currentTarget.value }))}
              autosize
              minRows={26}
              maxRows={26}
              placeholder={t('business.example.inputAnswer')}
            />
          </div>
        </div>
        <div className={styles.dialogFooter} style={{ marginTop: 16 }}>
          <Button variant="default" onClick={() => setShowEditDialog(false)}>
            {t('business.example.cancel')}
          </Button>
          <Button onClick={handleSaveEdit} loading={editing}>
            {editing ? t('business.example.saving') : t('business.example.save')}
          </Button>
        </div>
      </Modal>

      {/* Search sample dialog */}
      <Modal
        opened={showSearchDialog}
        onClose={() => setShowSearchDialog(false)}
        title={t('business.example.searchExample')}
        size="70%"
      >
        <div className={styles.searchDialogContent}>
          <TextInput
            className={styles.searchInput}
            size="lg"
            value={searchQuestion}
            onChange={(e) => setSearchQuestion(e.currentTarget.value)}
            placeholder={t('business.example.searchPlaceholder')}
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleTestSearch()
            }}
            rightSection={
              <span
                className={`${styles.searchIconBtn} ${searching ? styles.searching : ''}`}
                onClick={handleTestSearch}
              >
                {!searching ? <ElSvgIcon name="Search" size={18} /> : <Loader size={18} />}
              </span>
            }
          />

          {/* Search results */}
          {searchResults.length > 0 ? (
            <div className={styles.searchResultsList}>
              <div className={styles.resultsHeader}>
                <h4>
                  {t('business.example.recallResults')} ({searchResults.length})
                </h4>
              </div>
              <div className={styles.resultsList}>
                {searchResults.map((result, index) => (
                  <div
                    key={index}
                    className={styles.resultItem}
                    onClick={() => handleEditExample(result)}
                  >
                    <div className={styles.resultHeader}>
                      <Badge size="sm" color="green">
                        {t('business.example.similarity')}: {(result.similarity * 100).toFixed(1)}%
                      </Badge>
                    </div>
                    <div className={styles.resultBody}>
                      <div className={styles.resultQuestion}>
                        <span className={styles.label}>{t('business.example.question')}:</span>
                        <span className={styles.content}>{result.question}</span>
                      </div>
                      <div className={styles.resultSql}>
                        <span className={styles.label}>{t('business.example.answer')}:</span>
                        <pre className={styles.content}>{result.content}</pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            hasSearched &&
            searchResults.length === 0 && (
              <div className={styles.noResults}>
                <Center>
                  <Text c="dimmed">{t('business.example.noSimilarExamples')}</Text>
                </Center>
              </div>
            )
          )}
        </div>
      </Modal>
    </div>
  )
}
