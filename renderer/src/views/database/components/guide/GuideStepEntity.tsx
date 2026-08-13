import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { getCachedTablesReq, generateDatasourceEntityEmbeddingsReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import AdvancedEntitySection, {
  type AdvancedEntitySectionHandle,
} from './advanced/AdvancedEntitySection'
import styles from './GuideStepEntity.module.scss'

interface GuideStepEntityProps {
  projectId: string
  database?: any
  databaseId?: string | null
  standalone?: boolean
  // defineEmits(['step-completed', 'prev'])
  onStepCompleted?: () => void
  onPrev?: () => void
}

export default function GuideStepEntity(props: GuideStepEntityProps) {
  const { databaseId = null, standalone = false, onStepCompleted, onPrev } = props
  const { t } = useTranslation()

  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  const entitySectionRef = useRef<AdvancedEntitySectionHandle>(null)
  const [entitySuggesting, setEntitySuggesting] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [entityConfigCount, setEntityConfigCount] = useState(0)
  const [generatingEmbeddings, setGeneratingEmbeddings] = useState(false)
  const [tables, setTables] = useState<any[]>([])

  // Keep the latest projectId in a ref to avoid stale loadTables closures.
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId

  const loadTables = async () => {
    if (!databaseId) return
    try {
      const res: any = await getCachedTablesReq(currentProjectIdRef.current, databaseId)
      if (res.success && res.data) {
        setTables(res.data.items || res.data || [])
      }
    } catch (error) {
      console.error('加载表数据失败:', error)
    }
  }

  const handleEntitySuggest = () => {
    if (entitySectionRef.current) {
      entitySectionRef.current.handleSuggest()
    }
  }

  const handleSearchTest = () => {
    if (entitySectionRef.current) {
      entitySectionRef.current.handleSearchTest()
    }
  }

  const handleEntityAddManually = () => {
    if (entitySectionRef.current) {
      entitySectionRef.current.openAddDialog()
    }
  }

  const handleEntityConfigChanged = (count: number) => {
    setEntityConfigCount(count)
  }

  const handleGenerateEmbeddings = async () => {
    if (!databaseId) return
    setGeneratingEmbeddings(true)
    try {
      const res: any = await generateDatasourceEntityEmbeddingsReq(
        currentProjectIdRef.current,
        databaseId,
        null
      )
      if (res.success) {
        notifications.show({
          color: 'green',
          message: t('database.guide.advanced.entityVectorComplete'),
        })
        if (entitySectionRef.current) {
          await entitySectionRef.current.loadExistingConfigs()
        }
      }
    } catch (error) {
      console.error('Generate entity embeddings failed:', error)
      notifications.show({
        color: 'red',
        message: t('database.guide.advanced.entityVectorError'),
      })
    } finally {
      setGeneratingEmbeddings(false)
    }
  }

  const handlePrev = () => {
    onPrev?.()
  }
  const handleNext = () => {
    onStepCompleted?.()
  }

  // onMounted -> load table data
  useEffect(() => {
    loadTables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // watch(() => props.databaseId)
  useEffect(() => {
    if (databaseId) loadTables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  return (
    <div className={styles.guideStepEntity}>
      {/* Header */}
      <div className={styles.entityHeader}>
        <div className={styles.headerText}>
          <p className={styles.headerSubtitle}>{t('database.guide.entity.desc')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button
            onClick={handleEntitySuggest}
            loading={entitySuggesting}
            disabled={tables.length === 0}
            leftSection={<ElSvgIcon name="MagicStick" />}
          >
            {entitySuggesting
              ? t('database.guide.advanced.suggesting')
              : t('database.guide.advanced.suggestEntity')}
          </Button>
          <Button
            variant="default"
            onClick={handleEntityAddManually}
            disabled={tables.length === 0}
            leftSection={<ElSvgIcon name="Plus" />}
          >
            {t('database.guide.advanced.addEntityManually')}
          </Button>
          <Button
            variant="default"
            onClick={handleGenerateEmbeddings}
            loading={generatingEmbeddings}
            leftSection={<ElSvgIcon name="Promotion" />}
          >
            {generatingEmbeddings
              ? t('database.guide.advanced.generatingEntityVectors')
              : t('database.guide.advanced.generateEntityVectors')}
          </Button>
          <Button
            variant="default"
            onClick={handleSearchTest}
            leftSection={<ElSvgIcon name="Search" />}
          >
            {t('database.guide.entity.recallTest')}
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className={styles.entityBody}>
        <AdvancedEntitySection
          ref={entitySectionRef}
          databaseId={databaseId}
          tables={tables}
          disabled={tables.length === 0}
          onConfigChanged={handleEntityConfigChanged}
          onSuggestingChanged={(v: boolean) => setEntitySuggesting(v)}
        />
      </div>

      {/* Bottom navigation (shown in wizard mode) */}
      {!standalone && (
        <div className={styles.entityFooter}>
          <Button variant="default" onClick={handlePrev} leftSection={<ElSvgIcon name="ArrowLeft" />}>
            {t('database.action.prev')}
          </Button>
          <Button onClick={handleNext} rightSection={<ElSvgIcon name="ArrowRight" />}>
            {t('database.action.next')}
          </Button>
        </div>
      )}
    </div>
  )
}
