import { useEffect, useRef, useState } from 'react'
import { Badge, Box, Button, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { IconArrowLeft, IconArrowRight, IconCheck } from '@tabler/icons-react'
import DatabaseTypeIcon from '../DatabaseTypeIcon'
import { supportDatabaseReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './GuideStepSelectType.module.scss'

interface GuideStepSelectTypeProps {
  projectId: string
  initialType?: string
  database?: any
  onBack?: () => void
  onTypeSelected?: (payload: {
    db_type: string
    default_port: string
    supports_multiple_schemas: boolean
  }) => void
}

export default function GuideStepSelectType(props: GuideStepSelectTypeProps) {
  const { initialType = '', database = null, onBack, onTypeSelected } = props
  const { t, i18n } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const [loading, setLoading] = useState(false)
  const [dbTypeOptions, setDbTypeOptions] = useState<any[]>([])
  // Prefer type from database, then initialType
  const [selectedType, setSelectedType] = useState<string>(
    database?.db_type || initialType || ''
  )

  // Keep dbTypeOptions in a ref so handleNext can read the latest value
  const dbTypeOptionsRef = useRef<any[]>([])
  dbTypeOptionsRef.current = dbTypeOptions

  // Load database type options
  const fetchDatabaseTypes = async () => {
    setLoading(true)
    try {
      const res = await supportDatabaseReq(currentProjectId)
      if (res.data && res.data.items) {
        const options = res.data.items.map((item: any) => {
          const typeKey = String(item.value || '').toLowerCase()
          const labelKey = `database.form.types.${typeKey}`
          const descKey = `database.type.${typeKey}.desc`
          return {
            ...item,
            label: i18n.exists(labelKey) ? t(labelKey) : item.label || item.value,
            description: i18n.exists(descKey) ? t(descKey) : item.description
          }
        })
        setDbTypeOptions(options)
      }
    } catch (error) {
      console.error('获取数据库类型失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const selectType = (type: string) => {
    // If a database is already configured, prevent changing type
    if (database?.db_type && type !== database.db_type) {
      notifications.show({ color: 'yellow', message: t('database.form.typeImmutableWarning') })
      return
    }
    setSelectedType(type)
  }

  const handleBack = () => {
    onBack?.()
  }

  const handleNext = () => {
    if (selectedType) {
      const typeInfo = dbTypeOptionsRef.current.find((item) => item.value === selectedType)
      onTypeSelected?.({
        db_type: selectedType,
        default_port: typeInfo?.default_port || '',
        supports_multiple_schemas: typeInfo?.multiple_schema === 'True'
      })
    }
  }

  // Watch database changes and sync selected type (equivalent to watch immediate)
  useEffect(() => {
    if (database?.db_type) {
      setSelectedType(database.db_type)
    }
  }, [database])

  useEffect(() => {
    fetchDatabaseTypes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.guideStepSelectType}>
      <div className={styles.stepHeader}>
        <h2 className={styles.stepTitle}>{t('database.form.selectType')}</h2>
        <p className={styles.stepDesc}>
          {database?.db_type && (
            <Badge size="sm" style={{ marginRight: 8 }}>
              {t('database.guide.configured')}
              {database.db_type}
            </Badge>
          )}
          {t('database.form.selectTypeDesc')}
        </p>
      </div>

      <div className={styles.stepContent}>
        <Box pos="relative" className={styles.dbTypeGrid}>
          <LoadingOverlay visible={loading} zIndex={1} overlayProps={{ radius: 'sm', blur: 1 }} />
          {dbTypeOptions.map((item) => (
            <div
              key={item.value}
              className={`${styles.dbTypeCard} ${
                selectedType === item.value ? styles.selected : ''
              }`}
              onClick={() => selectType(item.value)}
            >
              <div className={styles.cardIcon}>
                <DatabaseTypeIcon type={item.value} />
              </div>
              <div className={styles.cardContent}>
                <span className={styles.cardName}>{item.label}</span>
                <span className={styles.cardDesc}>{item.description}</span>
              </div>
              {selectedType === item.value && (
                <div className={styles.selectedBadge}>
                  <IconCheck size={14} />
                </div>
              )}
            </div>
          ))}
        </Box>
      </div>

      <div className={styles.stepFooter}>
        <Button variant="default" onClick={handleBack} leftSection={<IconArrowLeft size={16} />}>
          {t('database.guide.backToList')}
        </Button>
        <div className={styles.footerRight}>
          <Button
            onClick={handleNext}
            disabled={!selectedType}
            rightSection={<IconArrowRight size={16} />}
          >
            {t('database.guide.nextConnection')}
          </Button>
        </div>
      </div>
    </div>
  )
}
