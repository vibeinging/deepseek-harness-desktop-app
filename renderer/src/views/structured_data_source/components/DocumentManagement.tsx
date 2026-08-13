import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Tooltip,
  Progress,
  Table,
  Checkbox,
  Pagination,
  Select,
  Modal,
  LoadingOverlay
} from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconFileSpreadsheet,
  IconFileText,
  IconFolderOpen,
  IconRefresh,
  IconTrash,
  IconUpload
} from '@tabler/icons-react'
import {
  listDocumentsReq,
  deleteDocumentReq,
  processDocumentsReq,
  deleteDocumentsBatchReq,
  createDocumentsReq,
  uploadDocumentsReq
} from '@/api/structured_data_source/document'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './DocumentManagement.module.scss'

export interface DocumentManagementProps {
  dataSourceId: string
  /** defineEmits('documents-processed') */
  onDocumentsProcessed?: () => void
}

// Upload file status item type (used for progress display and retry-after-failure actions).
interface UploadedItem {
  uid: string
  name: string
  size: number
  progress: number
  success: boolean
  failed: boolean
  error: string
  source: File
  relative_path: string
  timer: any
}

const acceptedExtensions = '.csv,.xlsx,.xls,.json,.jsonl'

const getFileNameFromPath = (filePath: any) => {
  if (!filePath || typeof filePath !== 'string') return ''
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

const getDocumentName = (row: any) => row?.file_name || row?.title || row?.name || getFileNameFromPath(row?.file_path || row?.relative_path) || '-'

const getDocumentPath = (row: any) => row?.file_path || row?.relative_path || ''

export default function DocumentManagement({ dataSourceId, onDocumentsProcessed }: DocumentManagementProps) {
  const { t } = useTranslation()
  const projectId = useProjectStore((s) => projectGetters.currentProjectId(s))
  const { isMobile } = useResponsive()

  // List mode state
  const [loading, setLoading] = useState(false)
  const [documentList, setDocumentList] = useState<any[]>([])
  const [openingDocumentIds, setOpeningDocumentIds] = useState<Set<any>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalCount, setTotalCount] = useState(0)
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<any[]>([])
  const [selectedUploadedPaths, setSelectedUploadedPaths] = useState<any[]>([])
  // Selected row key set (aligned with el-table selection semantics)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<any>>(new Set())

  // Upload mode state
  const [uploadDialogVisible, setUploadDialogVisible] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedItem[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Poll timer + list snapshot (aligned with Vue refs to avoid stale-closure reads)
  const pollingTimerRef = useRef<any>(null)
  const documentStatusSnapshotRef = useRef<Map<any, any>>(new Map())
  const isDocumentListInitializedRef = useRef(false)

  // Mirror latest dependencies for async callbacks/timers to read, matching Vue ref.value behavior.
  const dataSourceIdRef = useRef(dataSourceId)
  const projectIdRef = useRef(projectId)
  dataSourceIdRef.current = dataSourceId
  projectIdRef.current = projectId

  const successUploadCount = useMemo(() => uploadedFiles.filter((f) => f.success).length, [uploadedFiles])
  const documentStats = useMemo(() => {
    const processing = documentList.filter((item) => item.status === 'processing' || item.status === 'pending').length
    const completed = documentList.filter((item) => item.status === 'completed').length
    const failed = documentList.filter((item) => item.status === 'failed' || item.status === 'cancelled').length
    return {
      total: totalCount || documentList.length,
      completed,
      processing,
      failed,
      selected: selectedDocumentIds.length + selectedUploadedPaths.length
    }
  }, [documentList, selectedDocumentIds.length, selectedUploadedPaths.length, totalCount])

  // Generate unique table row keys to avoid duplicated keys causing render issues.
  const rowKey = (row: any) => row._rowKey || row.id || row.file_path || row.relative_path || getDocumentName(row)

  // Normalize list data and add _rowKey
  const normalizeDocumentList = (items: any) => {
    if (!Array.isArray(items)) return []
    return items.map((item, index) => ({
      ...item,
      _rowKey:
        item.id || item.document_id || `${item.file_path || item.relative_path || getDocumentName(item) || 'row'}-${index}`
    }))
  }

  // ============ List mode logic ============

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
  }, [])

  // Fetch document list
  const getDocuments = useCallback(async () => {
    if (!dataSourceIdRef.current || !projectIdRef.current) return

    setLoading(true)
    try {
      const res: any = await listDocumentsReq(projectIdRef.current, dataSourceIdRef.current, currentPage, pageSize)
      setTotalCount(res?.data?.total || 0)
      // Ensure documentList is always an array
      const items = res?.data?.items
      const newList = normalizeDocumentList(items)

      let hasNewlyCompleted = false
      if (isDocumentListInitializedRef.current) {
        for (const doc of newList) {
          const key = doc.id || doc._rowKey
          const prevStatus = documentStatusSnapshotRef.current.get(key)
          if (doc.status === 'completed' && prevStatus && prevStatus !== 'completed') {
            hasNewlyCompleted = true
            break
          }
        }
      }

      documentStatusSnapshotRef.current = new Map(newList.map((doc) => [doc.id || doc._rowKey, doc.status]))
      isDocumentListInitializedRef.current = true
      setDocumentList(newList)

      if (hasNewlyCompleted) {
        onDocumentsProcessed?.()
      }

      checkAndManagePolling(newList)
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.getDocumentListFailed') })
      // Ensure documentList is empty array on error.
      setDocumentList([])
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize, onDocumentsProcessed, t])

  // Use ref mirror for getDocuments so timers/events always use the latest version.
  const getDocumentsRef = useRef(getDocuments)
  getDocumentsRef.current = getDocuments

  // Start polling
  const startPolling = useCallback(() => {
    if (pollingTimerRef.current) return
    pollingTimerRef.current = setInterval(() => {
      getDocumentsRef.current()
    }, 3000)
  }, [])

  // Check documents in processing status and manage polling
  const checkAndManagePolling = useCallback(
    (list: any[]) => {
      const hasProcessing = list.some((item) => {
        return item.status === 'pending' || item.status === 'processing'
      })

      if (hasProcessing) {
        startPolling()
      } else {
        stopPolling()
      }
    },
    [startPolling, stopPolling]
  )

  // Watch data source ID and projectId changes (equivalent to watch(..., { immediate: true }))
  useEffect(() => {
    if (dataSourceId && projectId) {
      getDocumentsRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, projectId])

  // Refetch list when page size or page number changes.
  const isFirstPageEffect = useRef(true)
  useEffect(() => {
    if (isFirstPageEffect.current) {
      isFirstPageEffect.current = false
      return
    }
    getDocumentsRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize])

  // Stop polling on unmount (equivalent to onBeforeUnmount)
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  // Handle selection changes (derived from selected row key set)
  const computeSelection = (rows: any[]) => {
    const ids: any[] = []
    const uploads: any[] = []

    rows.forEach((r) => {
      if (r.status === 'uploaded' && !r.id && r.file_path) {
        uploads.push(r.file_path)
      }
      if (r.id) {
        ids.push(r.id)
      }
    })

    setSelectedDocumentIds(ids)
    setSelectedUploadedPaths(uploads)
  }

  // Toggle single-row selection
  const toggleRowSelection = (row: any, checked: boolean) => {
    const key = rowKey(row)
    const next = new Set(selectedRowKeys)
    if (checked) next.add(key)
    else next.delete(key)
    setSelectedRowKeys(next)
    computeSelection(documentList.filter((r) => next.has(rowKey(r))))
  }

  // Toggle select-all
  const allSelected = documentList.length > 0 && documentList.every((r) => selectedRowKeys.has(rowKey(r)))
  const someSelected = documentList.some((r) => selectedRowKeys.has(rowKey(r))) && !allSelected
  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      const next = new Set(documentList.map((r) => rowKey(r)))
      setSelectedRowKeys(next)
      computeSelection(documentList)
    } else {
      setSelectedRowKeys(new Set())
      computeSelection([])
    }
  }

  // Batch process unprocessed files
  const batchProcessUploaded = async () => {
    if (selectedUploadedPaths.length === 0) return

    try {
      // Create document record
      const createFormData = new FormData()
      createFormData.append('data_source_id', dataSourceId)
      createFormData.append('file_paths', JSON.stringify(selectedUploadedPaths))

      const createRes: any = await createDocumentsReq(projectId, createFormData)
      if (!createRes.success) {
        notifications.show({ color: 'red', message: t('structuredData.createDocumentFailed') })
        return
      }

      const createdDocs = createRes.data?.created_documents || []
      const documentIds = createdDocs.map((doc: any) => doc.document_id).filter((id: any) => id)

      if (documentIds.length === 0) {
        notifications.show({ color: 'yellow', message: t('structuredData.noDocumentsCreated') })
        return
      }

      // Submit processing task
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))
      const res: any = await processDocumentsReq(projectId, processFormData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('structuredData.batchProcessSubmitted') })
        setSelectedUploadedPaths([])
        setTimeout(() => getDocumentsRef.current(), 500)
      } else {
        notifications.show({ color: 'red', message: t('structuredData.batchProcessFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.batchProcessFailed') })
    }
  }

  // Bulk delete
  const batchDeleteAll = () => {
    if (selectedDocumentIds.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDocuments') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.batchDeleteTitle'),
      children: t('structuredData.batchDeleteConfirm', { count: selectedDocumentIds.length }),
      labels: { confirm: t('structuredData.confirm'), cancel: t('structuredData.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const formData = new FormData()
          formData.append('data_source_id', dataSourceId)
          formData.append('document_ids', JSON.stringify(selectedDocumentIds))

          const res: any = await deleteDocumentsBatchReq(projectId, formData)
          if (res?.success) {
            const deletedIds = res?.data?.deleted_ids || []
            notifications.show({
              color: 'green',
              message: t('structuredData.batchDeleteSuccess', { count: deletedIds.length })
            })
          } else {
            notifications.show({ color: 'red', message: t('structuredData.batchDeleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('structuredData.batchDeleteFailed') })
        } finally {
          setSelectedDocumentIds([])
          setSelectedUploadedPaths([])
          setSelectedRowKeys(new Set())
          getDocumentsRef.current()
        }
      }
    })
  }

  // Reprocess document
  const reprocessDocument = async (row: any) => {
    try {
      const formData = new FormData()
      formData.append('data_source_id', dataSourceId)
      formData.append('document_ids', JSON.stringify([row.id]))
      const res: any = await processDocumentsReq(projectId, formData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('structuredData.reprocessSubmitted') })
        setTimeout(() => getDocumentsRef.current(), 500)
      } else {
        notifications.show({ color: 'red', message: t('structuredData.submitFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.reprocessFailed') })
    }
  }

  const openDocumentLocation = async (row: any) => {
    const key = rowKey(row)
    if (!row?.id || openingDocumentIds.has(key)) {
      return
    }

    const filePath = getDocumentPath(row)
    if (!filePath) {
      notifications.show({ color: 'yellow', message: t('structuredData.openDocumentMissing') })
      return
    }

    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.revealInFinder) {
      notifications.show({ color: 'yellow', message: t('structuredData.openDocumentDesktopOnly') })
      return
    }

    setOpeningDocumentIds((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      const ok = await electronAPI.revealInFinder(filePath)
      if (!ok) {
        notifications.show({ color: 'red', message: t('structuredData.openDocumentFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.openDocumentFailed') })
    } finally {
      setOpeningDocumentIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  // Delete document
  const deleteDocument = (row: any) => {
    modals.openConfirmModal({
      title: t('structuredData.deleteConfirmTitle'),
      children: t('structuredData.deleteDocumentConfirm', { name: getDocumentName(row) }),
      labels: { confirm: t('structuredData.confirm'), cancel: t('structuredData.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const formData = { document_id: row.id }
          const res: any = await deleteDocumentReq(projectId, formData)
          if (res?.success) {
            notifications.show({ color: 'green', message: t('structuredData.deleteSuccess') })
            getDocumentsRef.current()
          } else {
            notifications.show({ color: 'red', message: t('structuredData.deleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('structuredData.deleteFailed') })
        }
      }
    })
  }

  // Utility helpers
  const formatFileSize = (bytes: any) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const getStatusText = (status: any, errorMsg: any = null) => {
    const statusMap: Record<string, string> = {
      pending: t('structuredData.statusPending'),
      processing: t('structuredData.statusProcessing'),
      completed: t('structuredData.statusCompleted'),
      failed: t('structuredData.statusFailed'),
      cancelled: t('structuredData.statusCancelled'),
      uploaded: t('structuredData.statusUnprocessed')
    }
    // Show inline error message when available
    if (errorMsg && status === 'processing') {
      return errorMsg
    }
    return statusMap[status] || status
  }

  const getStatusClass = (status: any) => {
    if (status === 'completed') return 'status-completed'
    if (status === 'failed') return 'status-failed'
    if (status === 'cancelled') return 'status-cancelled'
    if (status === 'uploaded') return 'status-uploaded'
    return 'status-processing'
  }

  const formatUploadTime = (value: any) => {
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Render status cell
  const renderStatusCell = (row: any) => {
    const statusText = getStatusText(row.status, row.error_msg)
    const statusClass = styles[getStatusClass(row.status)]
    if (['completed', 'failed', 'cancelled', 'uploaded'].includes(row.status)) {
      return <span className={`${styles['status-pill']} ${statusClass}`}>{statusText}</span>
    }
    return (
      <div className={styles['progress-status']}>
        <Progress
          value={row.progress || 0}
          color={row.status === 'failed' ? 'red' : undefined}
          size={6}
          className={styles['status-progress']}
        />
        <span className={`${styles['status-pill']} ${statusClass}`}>{statusText}</span>
      </div>
    )
  }

  // ============ Upload mode logic ============

  // Open upload dialog
  const enterUploadMode = () => {
    setUploadDialogVisible(true)
    setUploadedFiles([])
    // Reset upload status
  }

  // Close upload dialog
  const handleCloseUploadDialog = () => {
    setUploadDialogVisible(false)
    setUploadedFiles([])
  }

  // Exit upload mode after completion
  const exitUploadMode = () => {
    setUploadDialogVisible(false)
    setUploadedFiles([])
    getDocumentsRef.current()
  }

  // Custom upload
  const customUploadRequest = useCallback(
    async (file: File) => {
      const form = new FormData()
      form.append('data_source_id', dataSourceIdRef.current)
      form.append('files', file)

      const uid = ((file as any).uid || Date.now() + Math.random()).toString()
      const item: UploadedItem = {
        uid,
        name: file.name,
        size: file.size || 0,
        progress: 1,
        success: false,
        failed: false,
        error: '',
        source: file,
        relative_path: '',
        timer: null
      }
      setUploadedFiles((prev) => [...prev, item])

      // Simulate upload progress
      const timer = setInterval(() => {
        setUploadedFiles((prev) =>
          prev.map((it) => {
            if (it.uid !== uid) return it
            if (it.success || it.failed) {
              clearInterval(timer)
              return it
            }
            if (it.progress < 90) {
              return { ...it, progress: Math.min(90, it.progress + Math.max(1, Math.round(Math.random() * 5))) }
            }
            return it
          })
        )
      }, 200)
      setUploadedFiles((prev) => prev.map((it) => (it.uid === uid ? { ...it, timer } : it)))

      try {
        const res: any = await uploadDocumentsReq(projectIdRef.current, form)
        if (res.success && res.data) {
          clearInterval(timer)

          // Save file paths - backend returns an array of filenames
          const uploadedFileNames = res.data.uploaded_files || []
          const relativePath = uploadedFileNames.length > 0 ? uploadedFileNames[0] : file.name

          setUploadedFiles((prev) =>
            prev.map((it) =>
              it.uid === uid
                ? { ...it, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
                : it
            )
          )

          console.log('文件上传成功:', {
            fileName: file.name,
            relativePath: relativePath,
            response: res.data
          })
        } else {
          const errMsg = res.message || t('structuredData.uploadFailed')
          clearInterval(timer)

          setUploadedFiles((prev) =>
            prev.map((it) => (it.uid === uid ? { ...it, failed: true, error: errMsg, progress: 0 } : it))
          )
        }
      } catch (e: any) {
        clearInterval(timer)

        setUploadedFiles((prev) =>
          prev.map((it) =>
            it.uid === uid ? { ...it, failed: true, error: e?.message || '上传失败', progress: 0 } : it
          )
        )
      }
    },
    [t]
  )

  // Dropzone onDrop callback: upload files one by one
  const handleDrop = useCallback(
    (files: File[]) => {
      files.forEach((f) => {
        void customUploadRequest(f)
      })
    },
    [customUploadRequest]
  )

  // Retry upload
  const retryFileUpload = async (idx: number) => {
    const uf = uploadedFiles[idx]
    if (!uf || !uf.source) return

    // Reset status
    setUploadedFiles((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, failed: false, error: '', success: false, progress: 1 } : it))
    )

    const form = new FormData()
    form.append('data_source_id', dataSourceIdRef.current)
    form.append('files', uf.source)

    const timer = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((it, i) => {
          if (i !== idx) return it
          if (it.success || it.failed) {
            clearInterval(timer)
            return it
          }
          if (it.progress < 90) {
            return { ...it, progress: Math.min(90, it.progress + Math.max(1, Math.round(Math.random() * 5))) }
          }
          return it
        })
      )
    }, 200)
    setUploadedFiles((prev) => prev.map((it, i) => (i === idx ? { ...it, timer } : it)))

    try {
      const res: any = await uploadDocumentsReq(projectIdRef.current, form)
      if (res.success && res.data) {
        clearInterval(timer)

        // Save file paths - backend returns array of file names
        const uploadedFileNames = res.data.uploaded_files || []
        const relativePath = uploadedFileNames.length > 0 ? uploadedFileNames[0] : uf.name

        setUploadedFiles((prev) =>
          prev.map((it, i) =>
            i === idx
              ? { ...it, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
              : it
          )
        )
      } else {
        clearInterval(timer)

        setUploadedFiles((prev) =>
          prev.map((it, i) =>
            i === idx ? { ...it, failed: true, error: res.message || t('structuredData.uploadFailed'), progress: 0 } : it
          )
        )
      }
    } catch (e: any) {
      clearInterval(timer)

      setUploadedFiles((prev) =>
        prev.map((it, i) =>
          i === idx ? { ...it, failed: true, error: e?.message || t('structuredData.uploadFailed'), progress: 0 } : it
        )
      )
    }
  }

  // Remove file
  const removeUploadedFile = (idx: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  // Clear all files
  const clearUploadedFiles = () => {
    setUploadedFiles([])
  }

  // Submit for processing
  const handleSubmitUpload = async () => {
    const uploadedFileList = uploadedFiles.filter((f) => f.success && f.relative_path)
    const filePaths = uploadedFileList.map((f) => f.relative_path)

    console.log('准备提交处理:', {
      totalFiles: uploadedFiles.length,
      successFiles: uploadedFiles.filter((f) => f.success).length,
      filesWithPath: uploadedFileList.length,
      filePaths: filePaths
    })

    if (filePaths.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noFilesToProcess') })
      return
    }

    setSubmitting(true)
    try {
      // 1. Create document record
      const createFormData = new FormData()
      createFormData.append('data_source_id', dataSourceId)
      createFormData.append('file_paths', JSON.stringify(filePaths))

      const createRes: any = await createDocumentsReq(projectId, createFormData)
      if (!createRes.success) {
        notifications.show({ color: 'red', message: createRes.message || t('structuredData.createDocumentFailed') })
        return
      }

      // 2. Collect document_ids
      const documentIds =
        createRes.data?.created_documents?.map((doc: any) => doc.document_id)?.filter((id: any) => id != null) || []

      if (documentIds.length === 0) {
        notifications.show({ color: 'red', message: t('structuredData.noDocumentsCreated') })
        return
      }

      // 3. Process documents
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))

      const processRes: any = await processDocumentsReq(projectId, processFormData)
      if (processRes.success) {
        notifications.show({ color: 'green', message: t('structuredData.addedToProcessQueue') })
        exitUploadMode()
      } else {
        notifications.show({ color: 'red', message: processRes.message || t('structuredData.addToQueueFailed') })
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('structuredData.processFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize))

  return (
    <div className={styles['document-management']}>
      {/* List mode */}
      <div className={styles['list-mode']}>
        <div className={`${styles['content-card']} ${styles['document-card']}`} style={{ position: 'relative' }}>
          <LoadingOverlay visible={loading} zIndex={10} />
          <div className={styles['operations-header']}>
            <div className={styles['header-copy']}>
              <div className={styles['title-row']}>
                <span className={styles['title-icon']}>
                  <IconFileSpreadsheet size={18} stroke={1.7} />
                </span>
                <div>
                  <h3>{t('structuredData.tabs.files')}</h3>
                  <p>{t('structuredData.fileManagementSubtitle')}</p>
                </div>
              </div>
              <div className={styles['stats-row']}>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.totalFiles')}</span>
                  <strong>{documentStats.total}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.statusCompleted')}</span>
                  <strong>{documentStats.completed}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.statusProcessing')}</span>
                  <strong>{documentStats.processing}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.statusFailed')}</span>
                  <strong>{documentStats.failed}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.selectedFiles')}</span>
                  <strong>{documentStats.selected}</strong>
                </div>
              </div>
            </div>
            <div className={styles['header-actions']}>
              <Button color="violet" onClick={enterUploadMode} leftSection={<IconUpload size={16} stroke={1.6} />}>
                {t('structuredData.uploadDocument')}
              </Button>
              <Button
                variant="light"
                color="violet"
                disabled={selectedUploadedPaths.length === 0}
                onClick={batchProcessUploaded}
              >
                {t('structuredData.batchProcessUnprocessed', { count: selectedUploadedPaths.length })}
              </Button>
              <Button
                variant="light"
                color="red"
                disabled={selectedDocumentIds.length === 0}
                onClick={batchDeleteAll}
              >
                {t('structuredData.batchDelete', { count: selectedDocumentIds.length })}
              </Button>
            </div>
          </div>

          {/* Document list */}
          <div className={styles['table-wrapper']}>
            {documentList.length === 0 ? (
              <div className={styles['empty-state']}>
                <span className={styles['empty-icon']}>
                  <IconFileSpreadsheet size={24} stroke={1.7} />
                </span>
                <h4>{t('structuredData.emptyFileTitle')}</h4>
                <p>{t('structuredData.emptyFileDesc')}</p>
                <Button color="violet" onClick={enterUploadMode} leftSection={<IconUpload size={16} stroke={1.6} />}>
                  {t('structuredData.uploadDocument')}
                </Button>
              </div>
            ) : (
              <div className={styles['table-shell']}>
                <Table className={styles['document-table']} style={{ width: '100%' }} verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 48 }}>
                        <Checkbox
                          aria-label="select-all"
                          checked={allSelected}
                          indeterminate={someSelected}
                          onChange={(e) => toggleSelectAll(e.currentTarget.checked)}
                        />
                      </Table.Th>
                      <Table.Th style={{ minWidth: 240 }}>{t('structuredData.fileName')}</Table.Th>
                      <Table.Th style={{ width: 100 }}>{t('structuredData.size')}</Table.Th>
                      <Table.Th style={{ width: 140 }}>{t('structuredData.time')}</Table.Th>
                      <Table.Th style={{ width: 190 }}>{t('structuredData.status')}</Table.Th>
                      <Table.Th style={{ width: 124 }}>{t('structuredData.actions')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {documentList.map((row) => {
                      const key = rowKey(row)
                      const documentName = getDocumentName(row)
                      return (
                        <Table.Tr key={key}>
                          <Table.Td>
                            <Checkbox
                              aria-label="select-row"
                              checked={selectedRowKeys.has(key)}
                              onChange={(e) => toggleRowSelection(row, e.currentTarget.checked)}
                            />
                          </Table.Td>
                          <Table.Td>
                            <div className={styles['file-cell']}>
                              <span className={styles['file-icon']}>
                                <IconFileText size={16} stroke={1.7} />
                              </span>
                              <Tooltip label={documentName} withArrow>
                                <span className={styles['file-name']}>{documentName}</span>
                              </Tooltip>
                            </div>
                          </Table.Td>
                          <Table.Td className={styles['muted-cell']}>{formatFileSize(row.size)}</Table.Td>
                          <Table.Td className={styles['muted-cell']}>{formatUploadTime(row.created_at)}</Table.Td>
                          <Table.Td>{renderStatusCell(row)}</Table.Td>
                          <Table.Td>
                            <div className={styles['row-actions']}>
                              {row.id && (
                                <Tooltip label={t('structuredData.openDocumentLocation')} position="top" withArrow={false}>
                                  <Button
                                    variant="subtle"
                                    size="xs"
                                    className={`${styles['action-btn']} ${styles['icon-only-btn']}`}
                                    loading={openingDocumentIds.has(key)}
                                    disabled={openingDocumentIds.has(key)}
                                    onClick={() => openDocumentLocation(row)}
                                  >
                                    <IconFolderOpen className={styles['action-icon']} size={16} stroke={1.6} />
                                  </Button>
                                </Tooltip>
                              )}
                              {row.id && (
                                <Tooltip label={t('structuredData.reprocessDocument')} position="top" withArrow={false}>
                                  <Button
                                    variant="subtle"
                                    size="xs"
                                    className={`${styles['action-btn']} ${styles['icon-only-btn']}`}
                                    onClick={() => reprocessDocument(row)}
                                  >
                                    <IconRefresh className={styles['action-icon']} size={16} stroke={1.6} />
                                  </Button>
                                </Tooltip>
                              )}
                              {row.id && (
                                <Tooltip label={t('structuredData.deleteDocument')} position="top" withArrow={false}>
                                  <Button
                                    variant="subtle"
                                    size="xs"
                                    className={`${styles['action-btn']} ${styles['delete-btn']} ${styles['icon-only-btn']}`}
                                    onClick={() => deleteDocument(row)}
                                  >
                                    <IconTrash className={styles['action-icon']} size={16} stroke={1.6} />
                                  </Button>
                                </Tooltip>
                              )}
                            </div>
                          </Table.Td>
                        </Table.Tr>
                      )
                    })}
                  </Table.Tbody>
                </Table>
              </div>
            )}
            {/* Pagination */}
            {documentList.length > 0 && (
              <div className={styles['page-footer']}>
                <Select
                  size={isMobile ? 'xs' : 'sm'}
                  w={120}
                  value={String(pageSize)}
                  onChange={(v) => {
                    setPageSize(Number(v) || 20)
                    setCurrentPage(1)
                  }}
                  data={[10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} / page` }))}
                  comboboxProps={{ withinPortal: true }}
                />
                <Pagination
                  value={currentPage}
                  onChange={setCurrentPage}
                  total={pageCount}
                  size={isMobile ? 'sm' : 'md'}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Upload document dialog */}
      <Modal
        opened={uploadDialogVisible}
        onClose={handleCloseUploadDialog}
        title={t('structuredData.uploadDocument')}
        size="85%"
        closeOnClickOutside={false}
        className={styles['upload-dialog']}
        styles={{ body: { display: 'flex', flexDirection: 'column' } }}
      >
        <div className={styles['upload-section']}>
          <Dropzone
            className={styles['upload-drop']}
            multiple
            maxFiles={50}
            accept={acceptedExtensions.split(',')}
            onDrop={handleDrop}
          >
            <div className={styles['dropzone-inner']}>
              <IconUpload className={styles['upload-icon']} size={64} stroke={1.6} />
              <div className={styles['upload-text']}>{t('structuredData.uploadDragText')}</div>
              <div className={styles['upload-tip']}>
                <div>{t('structuredData.uploadMultipleHint')}</div>
                <div>{t('structuredData.uploadFormatHint')}</div>
              </div>
            </div>
          </Dropzone>

          {/* Upload list */}
          {uploadedFiles.length > 0 && (
            <div className={styles['file-list']}>
              <div className={styles['list-header']}>
                <span>
                  {t('structuredData.uploadedCount', { success: successUploadCount, total: uploadedFiles.length })}
                </span>
                <Button variant="subtle" color="red" size="xs" onClick={clearUploadedFiles}>
                  {t('structuredData.clear')}
                </Button>
              </div>
              {uploadedFiles.map((file, idx) => (
                <div key={file.uid} className={styles['file-item']}>
                  <IconFileText size={18} stroke={1.6} />
                  <span className={styles['file-name']}>{file.name}</span>
                  <Progress
                    value={file.progress}
                    color={file.success ? 'green' : file.failed ? 'red' : 'violet'}
                    style={{ flex: 1, margin: '0 10px' }}
                  />
                  <span className={styles['file-size']}>{formatFileSize(file.size)}</span>
                  {file.failed && (
                    <Button variant="subtle" color="violet" size="xs" onClick={() => retryFileUpload(idx)}>
                      {t('structuredData.retry')}
                    </Button>
                  )}
                  <Button variant="subtle" color="red" size="xs" onClick={() => removeUploadedFile(idx)}>
                    {t('structuredData.delete')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className={styles['dialog-footer']}>
          <Button
            color="violet"
            loading={submitting}
            disabled={successUploadCount === 0}
            onClick={handleSubmitUpload}
          >
            {t('structuredData.startProcessing')}
          </Button>
          <Button variant="default" onClick={handleCloseUploadDialog}>
            {t('structuredData.cancel')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
