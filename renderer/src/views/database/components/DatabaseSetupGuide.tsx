import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconCheck, IconX } from '@tabler/icons-react'

import GuideStepSelectType from './guide/GuideStepSelectType'
import GuideStepConnection from './guide/GuideStepConnection'
import GuideStepSync from './guide/GuideStepSync'
import GuideStepMetadata from './guide/GuideStepMetadata'
import GuideStepEntity from './guide/GuideStepEntity'
import GuideStepRelationship from './guide/GuideStepRelationship'

import { getCachedTablesReq, getDatabaseDetailReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'

import styles from './DatabaseSetupGuide.module.scss'

export interface DatabaseSetupGuideProps {
  projectId: string
  database?: any
  // Initial step, used to start from a specific step
  initialStep?: string
  // Optional list of visible steps; if not provided, all steps are shown
  visibleStepKeys?: string[] | null
  // defineEmits(['finish', 'back', 'database-created', 'database-updated'])
  onFinish?: (database: any) => void
  onBack?: () => void
  onDatabaseCreated?: (database: any) => void
  onDatabaseUpdated?: (database: any) => void
}

interface StepDef {
  key: string
  label: string
  component: React.ComponentType<any>
}

export default function DatabaseSetupGuide({
  projectId,
  database = null,
  initialStep = 'select-type',
  visibleStepKeys = null,
  onFinish,
  onBack,
  onDatabaseCreated
}: DatabaseSetupGuideProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // All step definitions
  const allSteps = useMemo<StepDef[]>(
    () => [
      { key: 'select-type', label: t('database.guide.steps.selectType'), component: GuideStepSelectType },
      { key: 'connection', label: t('database.guide.steps.connection'), component: GuideStepConnection },
      { key: 'sync', label: t('database.guide.steps.sync'), component: GuideStepSync },
      { key: 'metadata', label: t('database.guide.steps.metadata'), component: GuideStepMetadata },
      { key: 'entity', label: t('database.guide.steps.entity'), component: GuideStepEntity },
      { key: 'relationship', label: t('database.guide.steps.relationship'), component: GuideStepRelationship }
    ],
    [t]
  )

  // Current database info
  const [currentDatabase, setCurrentDatabase] = useState<any>(null)
  const [currentDatabaseId, setCurrentDatabaseId] = useState<any>(null)

  // Selected database type info
  const [selectedDbType, setSelectedDbType] = useState('')
  const [selectedDefaultPort, setSelectedDefaultPort] = useState<any>('')

  // Visible steps (filtered by configured step list)
  const visibleSteps = useMemo<StepDef[]>(() => {
    return allSteps.filter((step) => {
      // If a visible step list is provided, only show steps in that list
      if (visibleStepKeys && visibleStepKeys.length > 0) {
        if (!visibleStepKeys.includes(step.key)) {
          return false
        }
      }
      return true
    })
  }, [allSteps, visibleStepKeys])

  // Current step index (based on visibleSteps)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)

  // Current step (from visibleSteps)
  const currentStep = useMemo(() => visibleSteps[currentStepIndex], [visibleSteps, currentStepIndex])

  // Current step component
  const CurrentStepComponent = currentStep?.component

  // Whether this is the first step
  const isFirstStep = currentStepIndex === 0

  // Step completion status (used by step indicator for click navigation)
  const [stepCompletionStatus, setStepCompletionStatus] = useState<{ sync: boolean; metadata: boolean }>({
    sync: false,
    metadata: false
  })

  // Check step completion status
  const checkStepCompletion = async (dbId: any = currentDatabaseId) => {
    if (!dbId) {
      setStepCompletionStatus({ sync: false, metadata: false })
      return
    }

    try {
      const res: any = await getCachedTablesReq(currentProjectId, dbId)
      if (res.success && res.data) {
        const tableList = res.data.items || res.data || []
        const syncDone = tableList.length > 0

        let metadataDone = false

        if (tableList.length > 0) {
          let columnsWithDescription = 0
          let tablesWithDescription = 0
          let totalColumns = 0
          let databaseWithDescription = false

          for (const table of tableList) {
            if (table.description && table.description.trim()) {
              tablesWithDescription++
            }
            if (table.column_count !== undefined) {
              totalColumns += table.column_count || 0
            }
            if (table.columns_with_description !== undefined) {
              columnsWithDescription += table.columns_with_description || 0
            }
          }

          try {
            const dbRes: any = await getDatabaseDetailReq(currentProjectId, dbId)
            if (dbRes.success && dbRes.data) {
              databaseWithDescription = !!(dbRes.data.description && dbRes.data.description.trim())
            }
          } catch (error) {
            console.error('获取数据库详情失败:', error)
          }

          const columnDescCompleted = columnsWithDescription === totalColumns && totalColumns > 0
          const tableDescCompleted = tablesWithDescription === tableList.length && tableList.length > 0

          metadataDone = columnDescCompleted && tableDescCompleted && databaseWithDescription
        }

        setStepCompletionStatus({ sync: syncDone, metadata: metadataDone })
      } else {
        setStepCompletionStatus({ sync: false, metadata: false })
      }
    } catch (error) {
      console.error('检查步骤完成状态失败:', error)
      setStepCompletionStatus({ sync: false, metadata: false })
    }
  }

  // Get index of a step in visibleSteps
  const getVisibleStepIndex = (stepKey: string) => {
    return visibleSteps.findIndex((s) => s.key === stepKey)
  }

  // Whether navigation to a step is allowed when clicking a step indicator
  const canGoToStep = (stepKey: string) => {
    const targetIndex = getVisibleStepIndex(stepKey)

    // Allow navigation to the current step or any earlier step
    if (targetIndex <= currentStepIndex) {
      return true
    }

    // Sync and later steps require a database to exist
    if (['sync', 'metadata', 'entity', 'relationship'].includes(stepKey)) {
      if (!currentDatabaseId) {
        return false
      }
    }

    // Metadata and later steps require sync completion
    if (['metadata', 'entity', 'relationship'].includes(stepKey)) {
      return stepCompletionStatus.sync
    }

    return true
  }

  // Determine whether a step is locked
  const isStepLocked = (stepKey: string) => {
    return !canGoToStep(stepKey)
  }

  // Navigate to a specific step
  const goToStep = (stepKey: string) => {
    const targetIndex = getVisibleStepIndex(stepKey)
    if (targetIndex >= 0) {
      setCurrentStepIndex(targetIndex)
    }
  }

  // Go to next step
  const handleNext = () => {
    setCurrentStepIndex((idx) => (idx < visibleSteps.length - 1 ? idx + 1 : idx))
  }

  // Go to previous step
  const handlePrev = () => {
    setCurrentStepIndex((idx) => (idx > 0 ? idx - 1 : idx))
  }

  // Finish the guide
  const handleFinish = () => {
    onFinish?.(currentDatabase)
  }

  // Return to list (go back from first step)
  const handleBack = () => {
    onBack?.()
  }

  // Database type selected
  const handleTypeSelected = (typeInfo: any) => {
    setSelectedDbType(typeInfo.db_type)
    setSelectedDefaultPort(typeInfo.default_port)
    handleNext()
  }

  // Database created
  const handleDatabaseCreated = async (db: any) => {
    setCurrentDatabase(db)
    setCurrentDatabaseId(db.id)
    onDatabaseCreated?.(db)
    // Equivalent to original await nextTick() then handleNext()
    handleNext()
  }

  // Sync completed
  const handleSyncCompleted = (_result?: any) => {
    checkStepCompletion()
  }

  // Initialization (equivalent to onMounted)
  useEffect(() => {
    if (database) {
      setCurrentDatabase(database)
      setCurrentDatabaseId(database.id)

      // Set current step based on initialStep (found in visibleSteps)
      const initialIndex = getVisibleStepIndex(initialStep)
      if (initialIndex >= 0) {
        setCurrentStepIndex(initialIndex)
      }

      checkStepCompletion(database.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Watch database prop changes (skip first mount to avoid duplicating onMounted logic)
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (database) {
      setCurrentDatabase(database)
      setCurrentDatabaseId(database.id)
      checkStepCompletion(database.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database])

  // Recheck completion when current step changes
  useEffect(() => {
    checkStepCompletion()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStepIndex])

  // Recheck completion when database ID changes
  useEffect(() => {
    checkStepCompletion()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDatabaseId])

  // Props passed to step component (equivalent to computed stepProps)
  const stepProps = useMemo(() => {
    const baseProps: any = {
      projectId,
      database: currentDatabase,
      databaseId: currentDatabaseId,
      isFirstStep
    }

    // Add database type info for the connection step
    if (currentStep?.key === 'connection') {
      return {
        ...baseProps,
        selectedDbType,
        defaultPort: selectedDefaultPort
      }
    }

    return baseProps
  }, [projectId, currentDatabase, currentDatabaseId, isFirstStep, currentStep, selectedDbType, selectedDefaultPort])

  return (
    <div className={styles['setup-guide']}>
      {/* Close button */}
      <div className={styles['guide-close-header']}>
        <button type="button" className={styles['close-button']} onClick={handleBack}>
          <IconX size={18} />
        </button>
      </div>
      {/* Step indicator */}
      <div className={styles['guide-header']}>
        <div className={styles['guide-steps']}>
          {visibleSteps.map((step, index) => {
            const clickable = canGoToStep(step.key)
            const itemClass = [
              styles['step-item'],
              index === currentStepIndex ? styles.active : '',
              index < currentStepIndex ? styles.completed : '',
              isStepLocked(step.key) ? styles.locked : '',
              clickable ? styles.clickable : ''
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <div key={step.key} style={{ display: 'contents' }}>
                <div className={itemClass} onClick={() => clickable && goToStep(step.key)}>
                  <div className={styles['step-number']}>
                    {index < currentStepIndex ? <IconCheck size={16} /> : <span>{index + 1}</span>}
                  </div>
                  <div className={styles['step-label']}>{step.label}</div>
                </div>
                {index < visibleSteps.length - 1 && <div className={styles['step-connector']} />}
              </div>
            )
          })}
        </div>
      </div>

      {/* Step content */}
      <div className={styles['guide-content']}>
        {CurrentStepComponent && (
          <CurrentStepComponent
            {...stepProps}
            onStepCompleted={handleNext}
            onPrev={handlePrev}
            onFinish={handleFinish}
            onBack={handleBack}
            onTypeSelected={handleTypeSelected}
            onDatabaseCreated={handleDatabaseCreated}
            onSyncCompleted={handleSyncCompleted}
          />
        )}
      </div>
    </div>
  )
}
