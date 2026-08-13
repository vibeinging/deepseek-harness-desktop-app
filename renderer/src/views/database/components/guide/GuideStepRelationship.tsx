import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import { getCachedTablesReq, getRelationshipsReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import RelationshipERDiagram from '@/views/database/components/RelationshipERDiagram'
import styles from './GuideStepRelationship.module.scss'

export interface GuideStepRelationshipProps {
  projectId: string
  database?: any
  databaseId?: string | null
  onPrev?: () => void
  onFinish?: () => void
}

export default function GuideStepRelationship({
  databaseId = null,
  onPrev,
  onFinish
}: GuideStepRelationshipProps) {
  const { t } = useTranslation()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const [tables, setTables] = useState<any[]>([])
  const [relationshipCount, setRelationshipCount] = useState(0)
  const [showRelationshipDialog, setShowRelationshipDialog] = useState(false)

  // Keep the latest currentProjectId in a ref to avoid stale callback closures
  const projectIdRef = useRef(currentProjectId)
  projectIdRef.current = currentProjectId

  const loadTables = async () => {
    if (!databaseId) return
    try {
      const res = await getCachedTablesReq(projectIdRef.current, databaseId)
      if (res.success && res.data) {
        setTables(res.data.items || res.data || [])
      }
    } catch (error) {
      console.error('加载表数据失败:', error)
    }
  }

  const loadRelationshipCount = async () => {
    if (!databaseId) return
    try {
      const res = await getRelationshipsReq(projectIdRef.current, databaseId)
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : res.data.items || []
        setRelationshipCount(items.length)
      }
    } catch (error) {
      console.error('加载关系数据失败:', error)
    }
  }

  const handleOpenRelationship = () => {
    setShowRelationshipDialog(true)
  }
  const handleRelationshipDialogClosed = () => {
    loadRelationshipCount()
  }
  const handlePrev = () => {
    onPrev?.()
  }
  const handleFinish = () => {
    onFinish?.()
  }

  // On mount: load tables first, then relationship count
  // watch(databaseId): reload when databaseId changes
  useEffect(() => {
    if (!databaseId) return
    ;(async () => {
      await loadTables()
      loadRelationshipCount()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  return (
    <div className={styles['guide-step-relationship']}>
      {/* Header */}
      <div className={styles['rel-header']}>
        <div className={styles['header-text']}>
          <h2 className={styles['header-title']}>{t('database.guide.relationship.title')}</h2>
          <p className={styles['header-subtitle']}>{t('database.guide.relationship.desc')}</p>
        </div>
        <div className={styles['header-actions']}>
          <Button
            color={relationshipCount > 0 ? 'green' : undefined}
            onClick={handleOpenRelationship}
            disabled={tables.length === 0}
            leftSection={<ElSvgIcon name="Connection" size={16} />}
          >
            {relationshipCount > 0
              ? t('database.guide.advanced.viewEdit')
              : t('database.guide.advanced.configure')}
          </Button>
        </div>
      </div>

      {/* Main body */}
      <div className={styles['rel-body']}>
        {relationshipCount > 0 ? (
          /* Configured state */
          <div className={styles['rel-configured']}>
            <div className={styles['configured-card']}>
              <div className={styles['configured-icon']}>
                <ElSvgIcon name="Connection" size={28} />
              </div>
              <div className={styles['configured-info']}>
                <span className={styles['configured-count']}>
                  {t('database.guide.advanced.relationshipCountLabel', { count: relationshipCount })}
                </span>
                <span className={styles['configured-hint']}>
                  {t('database.guide.advanced.relationshipDesc')}
                </span>
              </div>
            </div>
          </div>
        ) : (
          /* Empty state */
          <div className={styles['empty-state']}>
            <div className={styles['concept-demo']}>
              <div className={styles['demo-flow']}>
                {/* User query */}
                <div className={`${styles['flow-node']} ${styles['flow-input']}`}>
                  <span className={styles['flow-label']}>
                    {t('database.guide.entity.flowUserQuery')}
                  </span>
                  <div className={styles['query-bubble']}>
                    <span className={styles['query-prefix']}>Q</span>
                    <span className={styles['query-text']}>
                      {t('database.guide.advanced.relFlowQuery')}
                    </span>
                  </div>
                </div>

                {/* Connector */}
                <div className={styles['flow-connector']}>
                  <svg width="40" height="2" viewBox="0 0 40 2">
                    <line
                      x1="0"
                      y1="1"
                      x2="32"
                      y2="1"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeDasharray="4 3"
                    />
                    <polygon points="32,0 40,1 32,2" fill="currentColor" />
                  </svg>
                </div>

                {/* Multi-table relationship detection */}
                <div className={`${styles['flow-node']} ${styles['flow-recognize']}`}>
                  <span className={styles['flow-label']}>
                    {t('database.guide.advanced.relFlowParse')}
                  </span>
                  <div className={styles['recognize-box']}>
                    <div className={styles['join-tables']}>
                      <code className={styles['table-name']}>
                        {t('database.guide.advanced.relFlowTableA')}
                      </code>
                      <div className={styles['join-badge']}>
                        <svg width="14" height="14" viewBox="0 0 14 14">
                          <path
                            d="M2 7h10M7 2v10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                      <code className={styles['table-name']}>
                        {t('database.guide.advanced.relFlowTableB')}
                      </code>
                    </div>
                    <span className={styles['join-key']}>
                      ON {t('database.guide.advanced.relFlowJoinKey')}
                    </span>
                  </div>
                </div>

                {/* Connector */}
                <div className={styles['flow-connector']}>
                  <svg width="40" height="2" viewBox="0 0 40 2">
                    <line
                      x1="0"
                      y1="1"
                      x2="32"
                      y2="1"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeDasharray="4 3"
                    />
                    <polygon points="32,0 40,1 32,2" fill="currentColor" />
                  </svg>
                </div>

                {/* Generated JOIN */}
                <div className={`${styles['flow-node']} ${styles['flow-output']}`}>
                  <span className={styles['flow-label']}>
                    {t('database.guide.advanced.relFlowResult')}
                  </span>
                  <div className={styles['sql-box']}>
                    <code>
                      <span className={styles['sql-kw']}>JOIN</span>{' '}
                      {t('database.guide.advanced.relFlowTableB')}{' '}
                      <span className={styles['sql-kw']}>ON</span>{' '}
                      <span className={styles['sql-col']}>
                        a.{t('database.guide.advanced.relFlowJoinKey')}
                      </span>{' '}
                      = <span className={styles['sql-col']}>b.id</span>
                    </code>
                  </div>
                </div>
              </div>
            </div>

            {/* Description text */}
            <div className={styles['empty-explain']}>
              <p className={styles['explain-main']}>
                {t('database.guide.advanced.relEmptyDesc')}
              </p>
              <p className={styles['explain-hint']}>
                {t('database.guide.advanced.relEmptyHint')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Relationship diagram modal */}
      <Modal
        opened={showRelationshipDialog}
        onClose={() => setShowRelationshipDialog(false)}
        title={t('database.guide.advanced.configRelationship')}
        size="90%"
        yOffset="5vh"
        // Equivalent to destroy-on-close: unmount content when modal closes (rendered only when showRelationshipDialog is true)
        // @closed → onExitTransitionEnd
        onExitTransitionEnd={handleRelationshipDialogClosed}
        className={styles['relationship-dialog']}
      >
        <div className={styles['relationship-dialog-body']}>
          <button
            className={styles['floating-close-btn']}
            onClick={() => setShowRelationshipDialog(false)}
          >
            {t('common.cancel')}
          </button>
          {showRelationshipDialog && (
            <RelationshipERDiagram
              key={`er-guide-${databaseId}`}
              databaseId={databaseId || ''}
            />
          )}
        </div>
      </Modal>

      {/* Bottom navigation */}
      <div className={styles['rel-footer']}>
        <Button
          variant="default"
          onClick={handlePrev}
          leftSection={<ElSvgIcon name="ArrowLeft" size={16} />}
        >
          {t('database.action.prev')}
        </Button>
        <Button
          onClick={handleFinish}
          rightSection={<ElSvgIcon name="Check" size={16} />}
        >
          {t('database.guide.advanced.finishConfig')}
        </Button>
      </div>
    </div>
  )
}
