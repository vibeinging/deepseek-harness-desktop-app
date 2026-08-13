import { useMemo, useRef, useState } from 'react'
import { Badge, Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react'
import DatabaseConnectionForm from '../DatabaseConnectionForm'
import { getDatabaseDetailReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './GuideStepConnection.module.scss'

// DatabaseConnectionForm exposes its methods via forwardRef (same as Vue defineExpose).
interface DatabaseConnectionFormHandle {
  handleSave: () => void
  handleTestConnection: () => Promise<void> | void
  connectionTestPassed: boolean
}

interface GuideStepConnectionProps {
  projectId: string
  database?: any
  selectedDbType?: string
  defaultPort?: string | number
  onPrev?: () => void
  onDatabaseCreated?: (data: any) => void
}

export default function GuideStepConnection(props: GuideStepConnectionProps) {
  const { database = null, selectedDbType = '', defaultPort = '', onPrev, onDatabaseCreated } = props
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const formRef = useRef<DatabaseConnectionFormHandle | null>(null)
  const [saving, setSaving] = useState(false)

  // Build initial form data, including the selected database type.
  const formInitialData = useMemo(() => {
    if (database) {
      return database
    }
    return {
      id: '', // Mark as create mode, with database type already selected.
      db_type: selectedDbType,
      port: defaultPort ? String(defaultPort) : ''
    }
  }, [database, selectedDbType, defaultPort])

  const handlePrev = () => {
    onPrev?.()
  }

  const handleSave = async () => {
    if (!formRef.current) return

    // If the connection has not been tested yet, test it first.
    if (!formRef.current.connectionTestPassed) {
      await formRef.current.handleTestConnection()
      // Pause briefly to let the test result update.
      await new Promise((resolve) => setTimeout(resolve, 500))
      // Re-check after testing.
      if (!formRef.current.connectionTestPassed) {
        // If testing fails, do not continue saving.
        return
      }
    }

    // Trigger form save.
    formRef.current.handleSave()
  }

  const handleSaved = async (databaseId: any) => {
    if (!databaseId) {
      notifications.show({ color: 'red', message: t('database.guide.connection.saveFailedNoId') })
      return
    }

    setSaving(true)

    try {
      // Fetch full database info.
      const res = await getDatabaseDetailReq(currentProjectId, databaseId)
      if (res.success && res.data) {
        onDatabaseCreated?.(res.data)
      } else {
        notifications.show({ color: 'red', message: t('database.guide.connection.fetchDbInfoFailed') })
      }
    } catch (error) {
      console.error('获取数据库信息失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.connection.fetchDbInfoFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.guideStepConnection}>
      <div className={styles.stepHeader}>
        <h2 className={styles.stepTitle}>{t('database.guide.connection.title')}</h2>
        <p className={styles.stepDesc}>
          <Badge size="sm" style={{ marginRight: 8 }}>
            {selectedDbType}
          </Badge>
          {t('database.guide.connection.desc')}
        </p>
      </div>

      <div className={styles.stepContent}>
        <div className={styles.contentCard}>
          <DatabaseConnectionForm
            ref={formRef as any}
            initialData={formInitialData}
            hideSaveButton={true}
            onSaved={handleSaved}
          />
        </div>
      </div>

      <div className={styles.stepFooter}>
        <Button variant="default" onClick={handlePrev} leftSection={<IconArrowLeft size={16} />}>
          {t('database.action.prev')}
        </Button>
        <div className={styles.footerRight}>
          <Button
            onClick={handleSave}
            loading={saving}
            rightSection={<IconArrowRight size={16} />}
          >
            {t('database.guide.connection.saveAndContinue')}
          </Button>
        </div>
      </div>
    </div>
  )
}
