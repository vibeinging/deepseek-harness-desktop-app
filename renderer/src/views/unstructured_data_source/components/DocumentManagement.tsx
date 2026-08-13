import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  Badge,
  Button,
  Center,
  Checkbox,
  Modal,
  NumberInput,
  Pagination,
  Progress,
  Stepper,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconAlertTriangleFilled,
  IconEdit,
  IconEye,
  IconFileText,
  IconFolderOpen,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import {
  listDocumentsReq,
  deleteDocumentReq,
  processDocumentsReq,
  deleteDocumentsBatchReq,
  createDocumentsReq,
  uploadDocumentsReq,
  getDocumentChunksReq,
  generateDocumentDescriptionsReq,
  updateDocumentDescriptionReq,
} from '@/api/unstructured_data_source/document'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './DocumentManagement.module.scss'

interface DocumentManagementProps {
  dataSourceId: string
}

// Upload file item (frontend temporary state)
interface UploadFileItem {
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

export default function DocumentManagement({ dataSourceId }: DocumentManagementProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh'

  const projectId = useProjectStore((s) => projectGetters.currentProjectId(s))
  const { isMobile } = useResponsive()

  // ============ List mode state ============
  const [loading, setLoading] = useState(false)
  const [documentList, setDocumentList] = useState<any[]>([])
  const [openingDocumentIds, setOpeningDocumentIds] = useState<Set<any>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalCount, setTotalCount] = useState(0)
  const pollingTimer = useRef<any>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<any>>(new Set())

  // ============ Upload mode state ============
  const [uploadDialogVisible, setUploadDialogVisible] = useState(false)
  const [uploadStep, setUploadStep] = useState(0)
  const [uploadedFiles, setUploadedFiles] = useState<UploadFileItem[]>([])
  const [chunkSize, setChunkSize] = useState<number | string>(512)
  const [delimiter, setDelimiter] = useState('')
  const [delimiterError, setDelimiterError] = useState('')
  const [splitStrategy, setSplitStrategy] = useState('smart')
  const [breakpointThresholdType, setBreakpointThresholdType] = useState('percentile')
  const [submitting, setSubmitting] = useState(false)

  // ============ Description generation state ============
  const [generatingDescriptions, setGeneratingDescriptions] = useState(false)
  const [descDialogVisible, setDescDialogVisible] = useState(false)
  const [descDialogDoc, setDescDialogDoc] = useState<any>(null)
  const [descDialogText, setDescDialogText] = useState('')
  const [descSaving, setDescSaving] = useState(false)
  const [descGenerating, setDescGenerating] = useState(false)

  // ============ Chunk preview state ============
  const [chunksDialogVisible, setChunksDialogVisible] = useState(false)
  const [currentChunks, setCurrentChunks] = useState<any[]>([])
  const [chunksLoading, setChunksLoading] = useState(false)
  const [chunksCurrentPage, setChunksCurrentPage] = useState(1)
  const [chunksPageSize, setChunksPageSize] = useState(20)
  const [chunksTotal, setChunksTotal] = useState(0)
  const currentChunksDocumentId = useRef<any>(null)

  const acceptedExtensions = '.pdf,.doc,.docx,.txt,.md,.markdown,.html,.htm,.rtf,.ofd'

  // Keep latest list data in a ref for polling and dep-free callbacks
  const documentListRef = useRef<any[]>([])
  documentListRef.current = documentList

  const successUploadCount = useMemo(() => uploadedFiles.filter((f) => f.success).length, [uploadedFiles])

  const strategyOptions = useMemo(
    () => [
      { value: 'smart', label: t('unstructuredData.strategySmart'), desc: t('unstructuredData.strategySmartDesc') },
      {
        value: 'table_aware',
        label: t('unstructuredData.strategyTableAware'),
        desc: t('unstructuredData.strategyTableAwareDesc'),
      },
      {
        value: 'recursive',
        label: t('unstructuredData.strategyRecursive'),
        desc: t('unstructuredData.strategyRecursiveDesc'),
      },
    ],
    [t]
  )

  const thresholdOptions = useMemo(
    () => [
      { value: 'percentile', label: t('unstructuredData.thresholdPercentile') },
      { value: 'standard_deviation', label: t('unstructuredData.thresholdStdDev') },
      { value: 'interquartile', label: t('unstructuredData.thresholdIQR') },
      { value: 'gradient', label: t('unstructuredData.thresholdGradient') },
    ],
    [t]
  )

  // Validate delimiter
  useEffect(() => {
    if (delimiter && (delimiter.length < 1 || delimiter.length > 10 || /\s/.test(delimiter))) {
      setDelimiterError(t('unstructuredData.delimiterError'))
    } else {
      setDelimiterError('')
    }
  }, [delimiter, t])

  // onMounted + reload on page/size changes (first mount also goes through this effect to avoid duplicate calls)
  useEffect(() => {
    getDocuments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize])

  // onBeforeUnmount: stop polling
  useEffect(() => {
    return () => {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Generate unique table row key to avoid rendering issues from duplicate keys
  const rowKey = (row: any) => row._rowKey || row.id || row.file_path || row.file_name

  // Normalize list data and add _rowKey
  const normalizeDocumentList = (items: any) => {
    if (!Array.isArray(items)) return []
    return items.map((item: any, index: number) => ({
      ...item,
      _rowKey:
        item.id || item.document_id || `${item.file_path || item.relative_path || item.file_name || 'row'}-${index}`,
    }))
  }

  // ============ List mode logic ============

  // Fetch document list
  // silent: silent refresh used during polling, without showing loading
  const getDocuments = async (silent = false) => {
    if (!silent) {
      setLoading(true)
    }
    try {
      const res: any = await listDocumentsReq(projectId, dataSourceId, currentPage, pageSize)
      setTotalCount(res?.data?.total || 0)
      // Ensure documentList is always an array
      const items = res?.data?.items
      const newList = normalizeDocumentList(items)

      // During silent refresh, update only changed rows to avoid full-table flicker
      const prev = documentListRef.current
      let nextList: any[]
      if (silent && prev.length === newList.length) {
        // Compare rows one by one before updating
        nextList = prev.map((oldItem: any, index: number) => {
          const newItem = newList[index]
          if (oldItem && newItem && oldItem.id === newItem.id) {
            // Only update fields that changed
            if (
              oldItem.status !== newItem.status ||
              oldItem.progress !== newItem.progress ||
              oldItem.chunk_count !== newItem.chunk_count
            ) {
              return { ...oldItem, ...newItem }
            }
            return oldItem
          }
          // Replace directly when IDs do not match
          return newItem
        })
      } else {
        // Replace directly on first load or when list length changes
        nextList = newList
      }
      documentListRef.current = nextList
      setDocumentList(nextList)

      checkAndManagePolling(nextList)
    } catch (error) {
      if (!silent) {
        notifications.show({ color: 'red', message: t('unstructuredData.getDocumentListFailed') })
      }
      // Ensure documentList is an empty array when an error happens
      documentListRef.current = []
      setDocumentList([])
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }

  // Check in-progress documents and control polling
  const checkAndManagePolling = (list: any[]) => {
    const hasProcessing = list.some((item: any) => {
      return item.status === 'pending' || item.status === 'processing'
    })

    if (hasProcessing) {
      startPolling()
    } else {
      stopPolling()
    }
  }

  // Start polling (silent refresh, no loading state)
  const startPolling = () => {
    if (pollingTimer.current) return
    pollingTimer.current = setInterval(() => {
      getDocuments(true)
    }, 3000)
  }

  // Stop polling
  const stopPolling = () => {
    if (pollingTimer.current) {
      clearInterval(pollingTimer.current)
      pollingTimer.current = null
    }
  }

  // Selected rows derived from the _rowKey set
  const selectedRows = useMemo(
    () => documentList.filter((row) => selectedRowKeys.has(rowKey(row))),
    [documentList, selectedRowKeys]
  )

  // Handle selection changes (derive ids and uploads)
  const { selectedDocumentIds, selectedUploadedPaths } = useMemo(() => {
    const ids: any[] = []
    const uploads: any[] = []
    selectedRows.forEach((r: any) => {
      if (r.status === 'uploaded' && !r.id && r.file_path) {
        uploads.push(r.file_path)
      }
      if (r.id) {
        ids.push(r.id)
      }
    })
    return { selectedDocumentIds: ids, selectedUploadedPaths: uploads }
  }, [selectedRows])

  const allSelected = documentList.length > 0 && selectedRowKeys.size === documentList.length
  const someSelected = selectedRowKeys.size > 0 && !allSelected

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedRowKeys(new Set())
    } else {
      setSelectedRowKeys(new Set(documentList.map((row) => rowKey(row))))
    }
  }

  const toggleSelectRow = (row: any) => {
    const key = rowKey(row)
    setSelectedRowKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const clearSelection = () => setSelectedRowKeys(new Set())

  // Batch process uploaded files
  const batchProcessUploaded = async () => {
    if (selectedUploadedPaths.length === 0) return

    try {
      // Create document records
      const createFormData = new FormData()
      createFormData.append('data_source_id', dataSourceId)
      createFormData.append('file_paths', JSON.stringify(selectedUploadedPaths))

      const createRes: any = await createDocumentsReq(projectId, createFormData)
      if (!createRes.success) {
        notifications.show({ color: 'red', message: t('unstructuredData.createDocumentFailed') })
        return
      }

      const createdDocs = createRes.data?.created_documents || []
      const documentIds = createdDocs.map((doc: any) => doc.document_id).filter((id: any) => id)

      if (documentIds.length === 0) {
        notifications.show({ color: 'yellow', message: t('unstructuredData.noDocumentCreated') })
        return
      }

      // Submit processing task
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))
      processFormData.append('chunk_size', '512')

      const res: any = await processDocumentsReq(projectId, processFormData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('unstructuredData.batchProcessSubmitted') })
        clearSelection()
        setTimeout(() => getDocuments(), 500)
      } else {
        notifications.show({ color: 'red', message: t('unstructuredData.batchProcessFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.batchProcessFailed') })
    }
  }

  // ==================== Description generation ====================

  const handleGenerateDescriptions = async () => {
    if (selectedDocumentIds.length === 0) return
    setGeneratingDescriptions(true)
    try {
      const res: any = await generateDocumentDescriptionsReq(projectId, {
        data_source_id: dataSourceId,
        document_ids: selectedDocumentIds,
        language: locale || 'zh',
      })
      if (res?.data) {
        const { documents_generated, documents_processed } = res.data
        notifications.show({
          color: 'green',
          message: t('unstructuredData.descriptionGenerated', {
            success: documents_generated,
            total: documents_processed,
          }),
        })
        await getDocuments()
      }
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('unstructuredData.descriptionGenerateFailed', { error: e.message || e }),
      })
    } finally {
      setGeneratingDescriptions(false)
    }
  }

  const openDescriptionDialog = (row: any) => {
    setDescDialogDoc(row)
    setDescDialogText(row.description || '')
    setDescDialogVisible(true)
  }

  const handleGenerateSingleDesc = async () => {
    if (!descDialogDoc) return
    setDescGenerating(true)
    try {
      const res: any = await generateDocumentDescriptionsReq(projectId, {
        data_source_id: dataSourceId,
        document_ids: [descDialogDoc.id],
        language: locale || 'zh',
      })
      const detail = res?.data?.details?.[0]
      if (detail?.success) {
        setDescDialogText(detail.description)
        notifications.show({ color: 'green', message: t('unstructuredData.aiGenerateComplete') })
      } else {
        notifications.show({
          color: 'red',
          message: t('unstructuredData.generateFailed', {
            error: detail?.error || t('unstructuredData.unknownError'),
          }),
        })
      }
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('unstructuredData.generateFailed', { error: e.message || e }),
      })
    } finally {
      setDescGenerating(false)
    }
  }

  const saveDescriptionFromDialog = async () => {
    if (!descDialogDoc) return
    setDescSaving(true)
    try {
      await updateDocumentDescriptionReq(projectId, descDialogDoc.id, descDialogText)
      // Sync description updates to the corresponding row
      setDocumentList((prev) =>
        prev.map((row) => (row.id === descDialogDoc.id ? { ...row, description: descDialogText } : row))
      )
      setDescDialogVisible(false)
      notifications.show({ color: 'green', message: t('unstructuredData.descriptionSaved') })
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('unstructuredData.saveFailed', { error: e.message || e }) })
    } finally {
      setDescSaving(false)
    }
  }

  // Batch delete
  const batchDeleteAll = () => {
    if (selectedDocumentIds.length === 0) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.pleaseSelectDocuments') })
      return
    }

    modals.openConfirmModal({
      title: t('unstructuredData.confirmBatchDeleteTitle'),
      children: t('unstructuredData.confirmBatchDelete', { count: selectedDocumentIds.length }),
      labels: { confirm: t('common.confirm') || '确定', cancel: t('common.cancel') || '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const formData = new FormData()
          formData.append('document_ids', JSON.stringify(selectedDocumentIds))

          const res: any = await deleteDocumentsBatchReq(projectId, dataSourceId, formData)
          if (res?.success) {
            const deletedIds = res?.data?.deleted_ids || []
            notifications.show({
              color: 'green',
              message: t('unstructuredData.deleteSuccessCount', { count: deletedIds.length }),
            })
          } else {
            notifications.show({ color: 'red', message: t('unstructuredData.batchDeleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('unstructuredData.batchDeleteFailed') })
        } finally {
          clearSelection()
          getDocuments()
        }
      },
    })
  }

  // Reprocess document
  const reprocessDocument = async (row: any) => {
    try {
      const formData = new FormData()
      formData.append('data_source_id', dataSourceId)
      formData.append('document_ids', JSON.stringify([row.id]))
      formData.append('chunk_size', '512')

      const res: any = await processDocumentsReq(projectId, formData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('unstructuredData.reprocessSubmitted') })
        setTimeout(() => getDocuments(), 500)
      } else {
        notifications.show({ color: 'red', message: t('unstructuredData.submitFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.reprocessFailed') })
    }
  }

  const openDocumentLocation = async (row: any) => {
    if (!row?.id || openingDocumentIds.has(row.id)) {
      return
    }

    const filePath = row.file_path || row.path || row.source_path
    if (!filePath) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.openDocumentMissing') })
      return
    }

    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.revealInFinder) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.openDocumentDesktopOnly') })
      return
    }

    setOpeningDocumentIds((prev) => {
      const next = new Set(prev)
      next.add(row.id)
      return next
    })
    try {
      const ok = await electronAPI.revealInFinder(filePath)
      if (!ok) {
        notifications.show({ color: 'red', message: t('unstructuredData.openDocumentFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.openDocumentFailed') })
    } finally {
      setOpeningDocumentIds((prev) => {
        const next = new Set(prev)
        next.delete(row.id)
        return next
      })
    }
  }

  // Delete document
  const deleteDocument = (row: any) => {
    modals.openConfirmModal({
      title: t('unstructuredData.confirmDeleteTitle'),
      children: t('unstructuredData.confirmDeleteDocument', { name: row.file_name }),
      labels: { confirm: t('common.confirm') || '确定', cancel: t('common.cancel') || '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await deleteDocumentReq(projectId, dataSourceId, row.id)
          if (res?.success) {
            notifications.show({ color: 'green', message: t('unstructuredData.deleteSuccess') })
            getDocuments()
          } else {
            notifications.show({ color: 'red', message: t('unstructuredData.deleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('unstructuredData.deleteFailed') })
        }
      },
    })
  }

  // Utility helpers
  const formatFileSize = (bytes: number) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const getStatusText = (status: string) => {
    const statusMap: Record<string, string> = {
      pending: t('unstructuredData.statusPending'),
      processing: t('unstructuredData.statusProcessing'),
      completed: t('unstructuredData.statusCompleted'),
      failed: t('unstructuredData.statusFailed'),
      cancelled: t('unstructuredData.statusCancelled'),
      uploaded: t('unstructuredData.statusUnprocessed'),
    }
    return statusMap[status] || status
  }

  // ============ Upload mode logic ============

  // Open upload dialog
  const enterUploadMode = () => {
    setUploadDialogVisible(true)
    setUploadStep(0)
    setUploadedFiles([])
    setChunkSize(512)
    setDelimiter('')
    setDelimiterError('')
  }

  // Close upload dialog
  const handleCloseUploadDialog = () => {
    setUploadDialogVisible(false)
    setUploadStep(0)
    setUploadedFiles([])
  }

  // Exit upload mode after processing finishes
  const exitUploadMode = () => {
    setUploadDialogVisible(false)
    setUploadStep(0)
    setUploadedFiles([])
    getDocuments()
  }

  // Upload one file (custom upload, aligned with original customUploadRequest)
  const uploadSingleFile = async (file: File) => {
    const item: UploadFileItem = {
      uid: ((file as any).uid || Date.now() + Math.random()).toString(),
      name: file.name,
      size: file.size || 0,
      progress: 1,
      success: false,
      failed: false,
      error: '',
      source: file,
      relative_path: '',
      timer: null,
    }

    const uid = item.uid
    setUploadedFiles((prev) => [...prev, item])

    const form = new FormData()
    form.append('data_source_id', dataSourceId)
    form.append('files', file)

    // Simulate progress
    const timer = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((f) => {
          if (f.uid !== uid) return f
          if (f.success || f.failed) return f
          if (f.progress < 90) {
            return { ...f, progress: Math.min(90, f.progress + Math.max(1, Math.round(Math.random() * 5))) }
          }
          return f
        })
      )
    }, 200)

    setUploadedFiles((prev) => prev.map((f) => (f.uid === uid ? { ...f, timer } : f)))

    try {
      const res: any = await uploadDocumentsReq(projectId, form)
      if (res.success && res.data) {
        clearInterval(timer)

        // Save file paths; backend returns an array of file names
        const uploadedFileNames = res.data.uploaded_files || []
        const relativePath = uploadedFileNames.length > 0 ? uploadedFileNames[0] : file.name

        setUploadedFiles((prev) =>
          prev.map((f) =>
            f.uid === uid
              ? { ...f, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
              : f
          )
        )

        console.log('文件上传成功:', {
          fileName: file.name,
          relativePath: relativePath,
          response: res.data,
        })
      } else {
        const errMessage = res.message || t('unstructuredData.uploadFailed')
        clearInterval(timer)
        setUploadedFiles((prev) =>
          prev.map((f) => (f.uid === uid ? { ...f, failed: true, error: errMessage, progress: 0 } : f))
        )
      }
    } catch (e: any) {
      clearInterval(timer)
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.uid === uid
            ? { ...f, failed: true, error: e?.message || t('unstructuredData.uploadFailed'), progress: 0 }
            : f
        )
      )
    }
  }

  // Dropzone file selection (supports multi-file and auto upload)
  const handleDrop = (files: File[]) => {
    files.forEach((file) => {
      uploadSingleFile(file)
    })
  }

  // Retry upload
  const retryFileUpload = async (idx: number) => {
    const uf = uploadedFiles[idx]
    if (!uf || !uf.source) return
    const uid = uf.uid

    // Reset state
    setUploadedFiles((prev) =>
      prev.map((f) => (f.uid === uid ? { ...f, failed: false, error: '', success: false, progress: 1 } : f))
    )

    const form = new FormData()
    form.append('data_source_id', dataSourceId)
    form.append('files', uf.source)

    const timer = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((f) => {
          if (f.uid !== uid) return f
          if (f.success || f.failed) return f
          if (f.progress < 90) {
            return { ...f, progress: Math.min(90, f.progress + Math.max(1, Math.round(Math.random() * 5))) }
          }
          return f
        })
      )
    }, 200)

    setUploadedFiles((prev) => prev.map((f) => (f.uid === uid ? { ...f, timer } : f)))

    try {
      const res: any = await uploadDocumentsReq(projectId, form)
      if (res.success && res.data) {
        clearInterval(timer)

        // Save file paths; backend returns an array of file names
        const uploadedFileNames = res.data.uploaded_files || []
        const relativePath = uploadedFileNames.length > 0 ? uploadedFileNames[0] : uf.name

        setUploadedFiles((prev) =>
          prev.map((f) =>
            f.uid === uid
              ? { ...f, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
              : f
          )
        )
      } else {
        clearInterval(timer)
        setUploadedFiles((prev) =>
          prev.map((f) =>
            f.uid === uid
              ? { ...f, failed: true, error: res.message || t('unstructuredData.uploadFailed'), progress: 0 }
              : f
          )
        )
      }
    } catch (e: any) {
      clearInterval(timer)
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.uid === uid
            ? { ...f, failed: true, error: e?.message || t('unstructuredData.uploadFailed'), progress: 0 }
            : f
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

  // Submit processing
  const handleSubmitUpload = async () => {
    // Validate delimiter
    if (delimiterError) {
      notifications.show({ color: 'yellow', message: delimiterError })
      return
    }

    const uploadedFileList = uploadedFiles.filter((f) => f.success && f.relative_path)
    const filePaths = uploadedFileList.map((f) => f.relative_path)

    console.log('准备提交处理:', {
      totalFiles: uploadedFiles.length,
      successFiles: uploadedFiles.filter((f) => f.success).length,
      filesWithPath: uploadedFileList.length,
      filePaths: filePaths,
    })

    if (filePaths.length === 0) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.noProcessableFiles') })
      return
    }

    setSubmitting(true)
    try {
      // 1. Create document records
      const createFormData = new FormData()
      createFormData.append('data_source_id', dataSourceId)
      createFormData.append('file_paths', JSON.stringify(filePaths))

      const createRes: any = await createDocumentsReq(projectId, createFormData)
      if (!createRes.success) {
        notifications.show({ color: 'red', message: createRes.message || t('unstructuredData.createDocumentFailed') })
        return
      }

      // 2. Extract document_ids
      const documentIds =
        createRes.data?.created_documents?.map((doc: any) => doc.document_id)?.filter((id: any) => id != null) || []

      if (documentIds.length === 0) {
        notifications.show({ color: 'red', message: t('unstructuredData.noDocumentCreated') })
        return
      }

      // 3. Process documents (vectorization)
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))
      processFormData.append('chunk_size', String(chunkSize))
      if (delimiter) {
        processFormData.append('delimiter', delimiter)
      }
      processFormData.append('split_strategy', splitStrategy)
      if (splitStrategy === 'smart') {
        processFormData.append('breakpoint_threshold_type', breakpointThresholdType)
      }

      const processRes: any = await processDocumentsReq(projectId, processFormData)
      if (processRes.success) {
        notifications.show({ color: 'green', message: t('unstructuredData.addedToQueue') })
        exitUploadMode()
      } else {
        notifications.show({ color: 'red', message: processRes.message || t('unstructuredData.addToQueueFailed') })
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('unstructuredData.processFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  // ============ Chunk preview logic ============

  // Show chunk details
  const showChunks = (row: any) => {
    if (!row.id) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.documentNotProcessed') })
      return
    }

    if (row.chunk_count === 0) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.noChunkInfo') })
      return
    }

    setChunksDialogVisible(true)
    setChunksCurrentPage(1)
    setChunksPageSize(20)
    currentChunksDocumentId.current = row.id

    loadChunksData(1, 20)
  }

  // Load chunk data
  const loadChunksData = async (page = chunksCurrentPage, size = chunksPageSize) => {
    if (!currentChunksDocumentId.current) return

    setChunksLoading(true)
    setCurrentChunks([])

    try {
      const res: any = await getDocumentChunksReq(projectId, dataSourceId, currentChunksDocumentId.current, page, size)
      if (res.success && res.data) {
        const chunks = res.data.chunks || []
        setCurrentChunks(chunks)
        setChunksTotal(res.data.total || 0)
        if (chunks.length === 0) {
          notifications.show({ color: 'blue', message: t('unstructuredData.noChunkInfo') })
        }
      } else {
        notifications.show({ color: 'red', message: res.message || t('unstructuredData.getChunksFailed') })
      }
    } catch (error) {
      console.error('获取分块信息失败:', error)
      notifications.show({ color: 'red', message: t('unstructuredData.getChunksFailed') })
    } finally {
      setChunksLoading(false)
    }
  }

  // Chunk pagination
  const handleChunksPageChange = (page: number) => {
    setChunksCurrentPage(page)
    loadChunksData(page, chunksPageSize)
  }

  // Render status column
  const renderStatus = (row: any) => {
    if (row.status === 'completed') {
      return (
        <Badge color="green" size="sm" variant="light">
          {t('unstructuredData.statusCompleted')}
        </Badge>
      )
    }
    if (row.status === 'failed') {
      return (
        <Tooltip
          multiline
          w={360}
          withArrow
          openDelay={300}
          label={
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: '#f56c6c' }}>
                {t('unstructuredData.processFailed')}
              </div>
              <div style={{ color: '#fff', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {row.error_msg || t('unstructuredData.unknownError')}
              </div>
            </div>
          }
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <Badge color="red" size="sm" variant="light">
              {t('unstructuredData.statusFailed')}
            </Badge>
            <IconAlertTriangleFilled size={14} color="#f56c6c" />
          </span>
        </Tooltip>
      )
    }
    if (row.status === 'cancelled') {
      return (
        <Badge color="yellow" size="sm" variant="light">
          {t('unstructuredData.statusCancelled')}
        </Badge>
      )
    }
    if (row.status === 'uploaded') {
      return (
        <Badge color="gray" size="sm" variant="light">
          {t('unstructuredData.statusUnprocessed')}
        </Badge>
      )
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Progress
          value={row.progress || 0}
          color={row.status === 'failed' ? 'red' : undefined}
          size={6}
          style={{ width: 80 }}
        />
        <span style={{ fontSize: 12 }}>{getStatusText(row.status)}</span>
      </div>
    )
  }

  return (
    <div className={styles.documentManagement}>
      {/* List mode */}
      <div className={styles.listMode}>
        <div className={`${styles.contentCard} ${styles.documentCard}`} style={{ position: 'relative' }}>
          <div className={styles.operationsHeader}>
            <div className={styles.headerLeft}>
              <h3 className={styles.cardTitle}>
                <span className={styles.cardTitleIcon} style={{ display: 'inline-flex' }}>
                  <IconFileText size={20} />
                </span>
                {t('unstructuredData.documentManagement')}
              </h3>
              <div className={styles.selectionActions}>
                <Button
                  size="xs"
                  variant="default"
                  loading={generatingDescriptions}
                  disabled={selectedDocumentIds.length === 0}
                  leftSection={<IconSparkles size={14} />}
                  onClick={handleGenerateDescriptions}
                >
                  {generatingDescriptions
                    ? t('unstructuredData.generating')
                    : t('unstructuredData.aiGenerateDescription')}
                </Button>
                <Button
                  size="xs"
                  color="red"
                  variant="outline"
                  disabled={selectedDocumentIds.length === 0}
                  onClick={batchDeleteAll}
                >
                  {t('unstructuredData.batchDelete', { count: selectedDocumentIds.length })}
                </Button>
                {selectedUploadedPaths.length > 0 && (
                  <Button size="xs" variant="outline" onClick={batchProcessUploaded}>
                    {t('unstructuredData.batchProcessUnprocessed', { count: selectedUploadedPaths.length })}
                  </Button>
                )}
              </div>
            </div>
            <div className={styles.headerActions}>
              <Button leftSection={<IconUpload size={16} />} onClick={enterUploadMode}>
                {t('unstructuredData.uploadDocument')}
              </Button>
            </div>
          </div>

          <div className={styles.tableWrapper}>
            <div className={styles.tableScroll}>
              <Table className={styles.documentTable} verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 48 }}>
                      <Checkbox
                        aria-label="select-all"
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={toggleSelectAll}
                      />
                    </Table.Th>
                    <Table.Th style={{ minWidth: 80 }}>{t('unstructuredData.fileName')}</Table.Th>
                    <Table.Th style={{ width: 60 }}>{t('unstructuredData.size')}</Table.Th>
                    <Table.Th style={{ width: 140 }}>{t('unstructuredData.time')}</Table.Th>
                    <Table.Th style={{ minWidth: 200 }}>{t('unstructuredData.description')}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t('unstructuredData.chunks')}</Table.Th>
                    <Table.Th>{t('unstructuredData.status')}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t('unstructuredData.actions')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {documentList.map((row) => (
                    <Table.Tr key={rowKey(row)} style={{ height: 56 }}>
                      <Table.Td>
                        <Checkbox
                          aria-label="select-row"
                          checked={selectedRowKeys.has(rowKey(row))}
                          onChange={() => toggleSelectRow(row)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={row.file_name} disabled={!row.file_name} withArrow>
                          <span>{row.file_name}</span>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td>{formatFileSize(row.size)}</Table.Td>
                      <Table.Td>{row.created_at}</Table.Td>
                      <Table.Td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {row.description ? (
                            <span className={styles.descriptionText}>{row.description}</span>
                          ) : (
                            <span style={{ color: '#c0c4cc', fontSize: 12 }}>—</span>
                          )}
                          {row.status === 'completed' && (
                            <Button
                              size="xs"
                              variant="subtle"
                              className={styles.inlineIconBtn}
                              p={0}
                              onClick={() => openDescriptionDialog(row)}
                            >
                              <IconEdit size={14} />
                            </Button>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        {row.chunk_count > 0 ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 13 }}>
                              {row.chunk_count} {t('unstructuredData.chunkUnit')}
                            </span>
                            <Button
                              size="xs"
                              variant="subtle"
                              className={styles.inlineIconBtn}
                              p={0}
                              onClick={() => showChunks(row)}
                            >
                              <IconEye size={14} />
                            </Button>
                          </div>
                        ) : (
                          <span style={{ color: '#c0c4cc', fontSize: 12 }}>—</span>
                        )}
                      </Table.Td>
                      <Table.Td>{renderStatus(row)}</Table.Td>
                      <Table.Td>
                        <div className={styles.rowActions}>
                          {row.id && (
                            <Tooltip label={t('unstructuredData.openDocumentLocation')} position="top" withArrow={false}>
                              <Button
                                variant="subtle"
                                size="xs"
                                className={styles.actionBtn}
                                loading={openingDocumentIds.has(row.id)}
                                disabled={openingDocumentIds.has(row.id)}
                                p={0}
                                onClick={() => openDocumentLocation(row)}
                              >
                                <IconFolderOpen size={16} className={styles.actionIcon} />
                              </Button>
                            </Tooltip>
                          )}
                          {row.id && (
                            <Tooltip label={t('unstructuredData.reprocessDocument')} position="top" withArrow={false}>
                              <Button
                                variant="subtle"
                                size="xs"
                                className={styles.actionBtn}
                                p={0}
                                onClick={() => reprocessDocument(row)}
                              >
                                <IconRefresh size={16} className={styles.actionIcon} />
                              </Button>
                            </Tooltip>
                          )}
                          {row.id && (
                            <Tooltip label={t('unstructuredData.deleteDocument')} position="top" withArrow={false}>
                              <Button
                                variant="subtle"
                                size="xs"
                                className={`${styles.actionBtn} ${styles.deleteBtn}`}
                                p={0}
                                onClick={() => deleteDocument(row)}
                              >
                                <IconTrash size={16} className={styles.actionIcon} />
                              </Button>
                            </Tooltip>
                          )}
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            {/* Pagination */}
            <div className={styles.pageFooter}>
              <Pagination
                value={currentPage}
                total={Math.max(1, Math.ceil(totalCount / pageSize))}
                onChange={setCurrentPage}
                size={isMobile ? 'sm' : 'md'}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Document description edit dialog */}
      <Modal
        opened={descDialogVisible}
        onClose={() => setDescDialogVisible(false)}
        title={descDialogDoc?.file_name || t('unstructuredData.description')}
        size="1200px"
        closeOnClickOutside={false}
      >
        <Textarea
          value={descDialogText}
          onChange={(e) => setDescDialogText(e.currentTarget.value)}
          autosize
          minRows={8}
          maxRows={20}
          placeholder={t('unstructuredData.descriptionPlaceholder')}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
            marginTop: 16,
          }}
        >
          <Button
            className={styles.aiGenerateBtn}
            variant="light"
            loading={descGenerating}
            leftSection={<IconSparkles size={16} />}
            onClick={handleGenerateSingleDesc}
          >
            {descGenerating ? t('unstructuredData.aiGenerating') : t('unstructuredData.aiGenerate')}
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="default" onClick={() => setDescDialogVisible(false)}>
              {t('common.cancel') || '取消'}
            </Button>
            <Button loading={descSaving} onClick={saveDescriptionFromDialog}>
              {t('common.save') || '保存'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Upload document dialog */}
      <Modal
        opened={uploadDialogVisible}
        onClose={handleCloseUploadDialog}
        title={t('unstructuredData.uploadDocument')}
        size="85%"
        closeOnClickOutside={false}
      >
        <Stepper active={uploadStep} onStepClick={setUploadStep} className={styles.steps} allowNextStepsSelect={false}>
          <Stepper.Step label={t('unstructuredData.stepSelectFiles')} />
          <Stepper.Step label={t('unstructuredData.stepConfigParams')} />
        </Stepper>

        {/* Step 1: Upload files */}
        {uploadStep === 0 && (
          <div className={styles.uploadSection}>
            <Dropzone
              className={styles.uploadDrop}
              multiple
              maxFiles={50}
              accept={acceptedExtensions.split(',')}
              onDrop={handleDrop}
            >
              <span className={styles.uploadIcon} style={{ display: 'inline-flex' }}>
                <IconUpload size={64} />
              </span>
              <div className={styles.uploadText}>{t('unstructuredData.uploadDragText')}</div>
              <div className={styles.uploadTip}>
                <div>{t('unstructuredData.uploadMultipleHint')}</div>
                <div>{t('unstructuredData.uploadFormatHint')}</div>
              </div>
            </Dropzone>

            {/* Upload list */}
            {uploadedFiles.length > 0 && (
              <div className={styles.fileList}>
                <div className={styles.listHeader}>
                  <span>
                    {t('unstructuredData.uploadedCount', {
                      success: successUploadCount,
                      total: uploadedFiles.length,
                    })}
                  </span>
                  <Button color="red" variant="subtle" size="compact-sm" onClick={clearUploadedFiles}>
                    {t('unstructuredData.clear')}
                  </Button>
                </div>
                {uploadedFiles.map((file, idx) => (
                  <div key={file.uid} className={styles.fileItem}>
                    <IconFileText size={18} />
                    <span className={styles.fileName}>{file.name}</span>
                    <Progress
                      value={file.progress}
                      color={file.success ? 'green' : file.failed ? 'red' : undefined}
                      className={styles.fileProgress}
                    />
                    <span className={styles.fileSize}>{formatFileSize(file.size)}</span>
                    {file.failed && (
                      <Button variant="subtle" size="compact-sm" onClick={() => retryFileUpload(idx)}>
                        {t('unstructuredData.retry')}
                      </Button>
                    )}
                    <Button color="red" variant="subtle" size="compact-sm" onClick={() => removeUploadedFile(idx)}>
                      {t('unstructuredData.delete')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Configure parameters */}
        {uploadStep === 1 && (
          <div className={styles.configSection}>
            <div className={styles.configGrid}>
              {/* Left: Chunking config */}
              <div className={styles.configColumn}>
                {/* Chunking strategy card */}
                <div className={styles.configCard}>
                  <div className={styles.configCardHeader}>
                    <svg
                      className={styles.configCardIcon}
                      viewBox="0 0 20 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M3 4h14M3 8h14M3 12h8M3 16h6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span>{t('unstructuredData.splitStrategy')}</span>
                  </div>
                  <div className={styles.strategyCards}>
                    {strategyOptions.map((s) => (
                      <div
                        key={s.value}
                        className={`${styles.strategyCard} ${splitStrategy === s.value ? styles.active : ''}`}
                        onClick={() => setSplitStrategy(s.value)}
                      >
                        <div className={styles.strategyCardInner}>
                          {s.value === 'smart' ? (
                            <svg className={styles.strategyIcon} viewBox="0 0 24 24" fill="none">
                              <path
                                d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"
                                stroke="currentColor"
                                strokeWidth="1.5"
                              />
                              <path
                                d="M10 21h4M12 17v4"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          ) : s.value === 'table_aware' ? (
                            <svg className={styles.strategyIcon} viewBox="0 0 24 24" fill="none">
                              <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                              <path d="M3 9h18M3 15h18M9 3v18" stroke="currentColor" strokeWidth="1.5" />
                            </svg>
                          ) : (
                            <svg className={styles.strategyIcon} viewBox="0 0 24 24" fill="none">
                              <path
                                d="M4 6h16M4 12h12M4 18h8"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          )}
                          <div className={styles.strategyText}>
                            <span className={styles.strategyName}>{s.label}</span>
                            <span className={styles.strategyDesc}>{s.desc}</span>
                          </div>
                        </div>
                        <div className={styles.strategyCheck}>
                          {splitStrategy === s.value && (
                            <svg viewBox="0 0 20 20" fill="currentColor">
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Semantic breakpoint strategy (smart mode only) */}
                  {splitStrategy === 'smart' && (
                    <div className={styles.thresholdSection}>
                      <div className={styles.thresholdLabel}>{t('unstructuredData.breakpointThreshold')}</div>
                      <div className={styles.thresholdTags}>
                        {thresholdOptions.map((th) => (
                          <span
                            key={th.value}
                            className={`${styles.thresholdTag} ${
                              breakpointThresholdType === th.value ? styles.active : ''
                            }`}
                            onClick={() => setBreakpointThresholdType(th.value)}
                          >
                            {th.label}
                          </span>
                        ))}
                      </div>
                      <div className={styles.thresholdTip}>{t('unstructuredData.breakpointThresholdTip')}</div>
                    </div>
                  )}
                </div>

                {/* Basic parameters card */}
                <div className={styles.configCard}>
                  <div className={styles.configCardHeader}>
                    <svg
                      className={styles.configCardIcon}
                      viewBox="0 0 20 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M10 3v4M6.5 5L8 7.5M13.5 5L12 7.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                      <rect x="3" y="9" width="14" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                    <span>{t('unstructuredData.chunkLength')}</span>
                  </div>
                  <div className={styles.paramRow}>
                    <div className={styles.paramItem}>
                      <div className={styles.paramLabel}>{t('unstructuredData.chunkLength')}</div>
                      <NumberInput
                        value={chunkSize}
                        onChange={setChunkSize}
                        min={64}
                        max={4096}
                        step={64}
                        w="100%"
                      />
                      <div className={styles.paramTip}>{t('unstructuredData.chunkLengthTip')}</div>
                    </div>
                    <div className={styles.paramItem}>
                      <div className={styles.paramLabel}>{t('unstructuredData.delimiter')}</div>
                      <TextInput
                        value={delimiter}
                        onChange={(e) => setDelimiter(e.currentTarget.value)}
                        placeholder={t('unstructuredData.delimiterPlaceholder')}
                        w="100%"
                      />
                      <div className={styles.paramTip}>{t('unstructuredData.delimiterTip')}</div>
                      {delimiterError && <div className={styles.paramError}>{delimiterError}</div>}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: File list */}
              <div className={`${styles.configColumn} ${styles.filesColumn}`}>
                <div className={`${styles.configCard} ${styles.filesCard}`}>
                  <div className={styles.configCardHeader}>
                    <svg
                      className={styles.configCardIcon}
                      viewBox="0 0 20 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M4 4a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                    <span>{t('unstructuredData.fileList')}</span>
                    <span className={styles.fileCountBadge}>{successUploadCount}</span>
                  </div>
                  <div className={styles.filesScroll}>
                    {uploadedFiles
                      .filter((f) => f.success)
                      .map((file, idx) => (
                        <div key={idx} className={styles.fileChip}>
                          <svg className={styles.fileChipIcon} viewBox="0 0 16 16" fill="none">
                            <path
                              d="M4 1h5.5L13 4.5V13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z"
                              stroke="currentColor"
                              strokeWidth="1.2"
                            />
                            <path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                          </svg>
                          <span className={styles.fileChipName} title={file.name}>
                            {file.name}
                          </span>
                          <button
                            className={styles.fileChipClose}
                            onClick={() => removeUploadedFile(uploadedFiles.indexOf(file))}
                          >
                            <svg viewBox="0 0 12 12" fill="none">
                              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    {successUploadCount === 0 && (
                      <div className={styles.filesEmpty}>
                        <svg
                          viewBox="0 0 48 48"
                          fill="none"
                          style={{ width: 48, height: 48, opacity: 0.3, marginBottom: 8 }}
                        >
                          <path
                            d="M8 8a4 4 0 0 1 4-4h14l10 10v26a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V8z"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                          <path d="M26 4v10h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        <span>{t('unstructuredData.noUploadedFiles')}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

          {/* Footer buttons */}
        <div className={styles.dialogFooter}>
          {uploadStep > 0 && (
            <Button variant="default" onClick={() => setUploadStep((s) => s - 1)}>
              {t('unstructuredData.previousStep')}
            </Button>
          )}
          {uploadStep === 0 && (
            <Button disabled={successUploadCount === 0} onClick={() => setUploadStep((s) => s + 1)}>
              {t('unstructuredData.nextStep')}
            </Button>
          )}
          {uploadStep === 1 && (
            <Button loading={submitting} disabled={successUploadCount === 0} onClick={handleSubmitUpload}>
              {t('unstructuredData.startProcessing')}
            </Button>
          )}
          <Button variant="default" onClick={handleCloseUploadDialog}>
            {t('unstructuredData.cancel')}
          </Button>
        </div>
      </Modal>

      {/* Chunk view dialog */}
      <Modal
        opened={chunksDialogVisible}
        onClose={() => setChunksDialogVisible(false)}
        title={t('unstructuredData.chunkDetails')}
        size="80%"
      >
        {currentChunks.length > 0 ? (
          <Accordion className={styles.chunksCollapse} variant="separated">
            {currentChunks.map((chunk, index) => (
              <Accordion.Item key={index} value={String(index)}>
                <Accordion.Control>
                  <div className={styles.chunkAccordionTitle}>
                    <Badge size="sm" variant="light" style={{ marginRight: 10 }}>
                      {t('unstructuredData.chunk')}: {chunk.content_info.content_index + 1}
                    </Badge>
                    {chunk.is_embedding && (
                      <Badge color="green" size="sm" variant="light" style={{ marginRight: 10 }}>
                        {t('unstructuredData.vectorized')}
                      </Badge>
                    )}
                    <span className={styles.chunkPreview}>{chunk.chunk_content}</span>
                  </div>
                </Accordion.Control>
                <Accordion.Panel>
                  <div className={styles.chunkContent}>
                    <p>{chunk.content_info.content}</p>
                  </div>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        ) : (
          <Center mih={200}>
            <Text c="dimmed">{t('unstructuredData.noChunkInfo')}</Text>
          </Center>
        )}

        <div className={styles.dialogFooter}>
          {chunksTotal > chunksPageSize && (
            <Pagination
              value={chunksCurrentPage}
              total={Math.max(1, Math.ceil(chunksTotal / chunksPageSize))}
              onChange={handleChunksPageChange}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}
