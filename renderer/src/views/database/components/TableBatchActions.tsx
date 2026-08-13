import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, Alert, Checkbox } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { IconTrash, IconAlertTriangle } from '@tabler/icons-react'
import { deleteCachedTableReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './TableBatchActions.module.scss'

// Table item shape aligned with fields in source props.tables.
interface TableItem {
  id: string
  table_name?: string
  schema_name?: string
  [key: string]: any
}

export interface TableBatchActionsProps {
  databaseId: string
  tables?: TableItem[]
  isFromGuide?: boolean
  // defineEmits(['refresh', 'open-retrieval-test', 'load-columns']) -> callback props.
  onRefresh?: () => void
  onOpenRetrievalTest?: () => void
  onLoadColumns?: (tableId?: any) => void | Promise<void>
}

export default function TableBatchActions({
  databaseId,
  tables = [],
  isFromGuide = false,
  onRefresh,
  onOpenRetrievalTest,
  onLoadColumns: _onLoadColumns
}: TableBatchActionsProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // Loading state.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_testingRetrieval, _setTestingRetrieval] = useState(false)
  const [batchDeleteDialogVisible, setBatchDeleteDialogVisible] = useState(false)
  const [deletingTables, setDeletingTables] = useState(false)
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([])

  // Derived state.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _canTestRetrieval = useMemo(() => tables.length > 0, [tables])

  // Wrap modals.openConfirmModal in Promise to keep the original async try/catch flow.
  const confirmAsync = (options: {
    title: string
    message: string
    confirmLabel: string
    cancelLabel: string
  }): Promise<'confirm'> =>
    new Promise((resolve, reject) => {
      modals.openConfirmModal({
        title: options.title,
        children: options.message,
        labels: { confirm: options.confirmLabel, cancel: options.cancelLabel },
        confirmProps: { color: 'orange' },
        onConfirm: () => resolve('confirm'),
        onCancel: () => reject('cancel')
      })
    })

  // Batch delete tables.
  const handleBatchDeleteTables = () => {
    if (!databaseId) {
      notifications.show({ color: 'yellow', message: t('database.batch.selectDbFirst') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('database.batch.noTableData') })
      return
    }

    setSelectedTableIds([])
    setBatchDeleteDialogVisible(true)
  }

  const confirmBatchDelete = async () => {
    if (selectedTableIds.length === 0) {
      notifications.show({ color: 'yellow', message: t('database.batch.selectAtLeastOne') })
      return
    }

    try {
      const confirmResult = await confirmAsync({
        title: t('database.batch.confirmDeleteTitle'),
        message: t('database.batch.confirmDeleteMsg', { count: selectedTableIds.length }),
        confirmLabel: t('database.batch.confirmDelete'),
        cancelLabel: t('database.action.cancel')
      })

      if (confirmResult === 'confirm') {
        setDeletingTables(true)
        let successCount = 0
        let failCount = 0

        for (const tableId of selectedTableIds) {
          try {
            const res: any = await deleteCachedTableReq(currentProjectId, databaseId, tableId)
            if (res.success) {
              successCount++
              const table = tables.find((tb) => tb.id === tableId)
              console.log(`表 ${table?.table_name} 删除成功`)
            } else {
              failCount++
            }
          } catch (error) {
            failCount++
            console.error('删除表失败:', error)
          }
        }

        setBatchDeleteDialogVisible(false)
        setSelectedTableIds([])

        if (failCount === 0) {
          notifications.show({
            color: 'green',
            message: t('database.batch.deleteSuccess', { count: successCount })
          })
        } else {
          notifications.show({
            color: 'yellow',
            message: t('database.batch.deletePartial', { success: successCount, fail: failCount })
          })
        }

        onRefresh?.()
      }
    } catch (error) {
      if (error !== 'cancel') {
        console.error('批量删除表失败:', error)
        notifications.show({ color: 'red', message: t('database.batch.deleteFailed') })
      }
    } finally {
      setDeletingTables(false)
    }
  }

  const cancelBatchDelete = () => {
    setBatchDeleteDialogVisible(false)
    setSelectedTableIds([])
  }

  const selectAllTables = () => {
    setSelectedTableIds(tables.map((table) => table.id))
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleTestRetrieval = () => {
    onOpenRetrievalTest?.()
  }

  return (
    <>
      {!isFromGuide && (
        <div className={`${styles.actionGroup} ${styles.rightActions} batch-actions`}>
          <Button
            variant="default"
            size="xs"
            onClick={() => handleBatchDeleteTables()}
            disabled={tables.length === 0}
            leftSection={<IconTrash size={16} stroke={1.6} />}
            className="batch-action-btn"
          >
            {t('database.batch.batchDelete')}
          </Button>
        </div>
      )}

      {/* Batch delete table modal */}
      <Modal
        opened={batchDeleteDialogVisible}
        onClose={cancelBatchDelete}
        title={t('database.batch.batchDelete')}
        size="60%"
        closeOnClickOutside={false}
      >
        <div className={styles.batchDeleteContent}>
          <Alert
            color="yellow"
            icon={<IconAlertTriangle size={18} />}
            withCloseButton={false}
            title={t('database.batch.deleteWarning')}
            style={{ marginBottom: 16 }}
          />
          <div className={styles.tableSelection}>
            <div className={styles.selectionHeader}>
              <span>{t('database.batch.selectToDelete', { count: tables.length })}</span>
              <Button
                variant="light"
                size="xs"
                onClick={selectAllTables}
                className={styles.selectAllBtn}
              >
                {t('database.batch.selectAll')}
              </Button>
            </div>
            <Checkbox.Group value={selectedTableIds} onChange={setSelectedTableIds}>
              <div className={styles.tableCheckboxGroup}>
                {tables.map((table) => (
                  <Checkbox
                    key={table.id}
                    value={table.id}
                    className={styles.tableCheckbox}
                    label={
                      table.schema_name && table.schema_name !== 'default'
                        ? `${table.schema_name}.${table.table_name}`
                        : table.table_name
                    }
                  />
                ))}
              </div>
            </Checkbox.Group>
          </div>
        </div>
        <div className={styles.dialogFooter}>
          <Button variant="default" onClick={cancelBatchDelete}>
            {t('database.action.cancel')}
          </Button>
          <Button
            color="red"
            onClick={confirmBatchDelete}
            loading={deletingTables}
            disabled={selectedTableIds.length === 0}
          >
            {t('database.batch.deleteSelected', { count: selectedTableIds.length })}
          </Button>
        </div>
      </Modal>
    </>
  )
}
