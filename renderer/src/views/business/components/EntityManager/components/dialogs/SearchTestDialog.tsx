// Entity search test dialog: vector recall + AI entity recognition/replacement.
import { useMemo } from 'react'
import { Alert, Button, Modal, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './SearchTestDialog.module.scss'

interface AgentEntity {
  original_text?: string
  entity_value?: string
  sql_hint?: string
  entity_type?: string
}

interface AgentResult {
  original_question?: string
  rewritten_question?: string
  entities?: AgentEntity[]
}

interface SearchResultItem {
  id?: string | number
  entity_name?: string
  rule?: string
  similarity?: number
  table_name?: string
  column_name?: string
  meta_data?: Record<string, any>
}

interface SearchTestDialogProps {
  visible?: boolean
  keyword?: string
  searching?: boolean
  agentTesting?: boolean
  searchResults?: SearchResultItem[]
  agentResult?: AgentResult | null
  hasSearched?: boolean
  onUpdateVisible?: (value: boolean) => void
  onUpdateKeyword?: (value: string) => void
  onVectorSearch?: () => void
  onAgentTest?: () => void
  onClearResults?: () => void
  onClearAgentResult?: () => void
}

export default function SearchTestDialog({
  visible = false,
  keyword = '',
  searching = false,
  agentTesting = false,
  searchResults,
  agentResult,
  hasSearched = false,
  onUpdateVisible,
  onUpdateKeyword,
  onVectorSearch,
  onAgentTest,
  onClearResults,
  onClearAgentResult,
}: SearchTestDialogProps) {
  const { t } = useTranslation()

  const localSearchResults = useMemo(() => searchResults || [], [searchResults])
  const localAgentResult = agentResult
  const localKeyword = keyword

  const handleVectorSearch = () => {
    if (!localKeyword.trim()) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseEnterSearchKeyword') })
      return
    }
    onVectorSearch?.()
  }

  const handleAgentTest = () => {
    if (!localKeyword.trim()) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseEnterTestQuestion') })
      return
    }
    onAgentTest?.()
  }

  const handleClearResults = () => {
    onClearResults?.()
  }

  const handleClearAgentResult = () => {
    onClearAgentResult?.()
  }

  const filterMetaData = (metaData?: Record<string, any>): Record<string, any> => {
    if (!metaData) return {}
    const excludeKeys = ['table_name', 'column_name', 'source_value', 'source_type', 'entity_type']
    return Object.fromEntries(Object.entries(metaData).filter(([key]) => !excludeKeys.includes(key)))
  }

  const handleClose = () => {
    onUpdateVisible?.(false)
  }

  return (
    <Modal
      opened={visible}
      onClose={handleClose}
      title={t('business.entity.searchTestTitle')}
      size="80%"
      closeOnClickOutside={false}
      withCloseButton
      yOffset="5vh"
      className={styles.entityTestDialog}
      classNames={{ body: styles.dialogBody }}
    >
      <div className={styles.entitySearchContainer}>
        <div className={styles.searchInputWrapper}>
          <TextInput
            className={styles.searchInput}
            value={localKeyword}
            placeholder={t('business.entity.searchPlaceholder')}
            size="lg"
            onChange={(e) => onUpdateKeyword?.(e.currentTarget.value)}
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleVectorSearch()
            }}
            leftSection={<ElSvgIcon name="Search" size={16} />}
          />
          <Button
            size="lg"
            onClick={handleVectorSearch}
            loading={searching}
            leftSection={<ElSvgIcon name="Search" size={16} />}
          >
            {t('business.entity.vectorRecall')}
          </Button>
          <Button color="green" size="lg" onClick={handleAgentTest} loading={agentTesting}
            leftSection={<ElSvgIcon name="MagicStick" size={16} />}>
            {t('business.entity.aiEntityTest')}
          </Button>
        </div>

        {/* Agent replacement test result */}
        {localAgentResult && (
          <div className={styles.agentResultSection}>
            <div className={styles.resultsHeader}>
              <span className={styles.resultsTitle}>
                <ElSvgIcon name="MagicStick" size={16} />
                {t('business.entity.agentReplaceResult')}
              </span>
              <Button size="xs" variant="subtle" onClick={handleClearAgentResult}>
                {t('business.entity.clearResults')}
              </Button>
            </div>
            <div className={styles.agentResultContent}>
              <div className={styles.originalQuestion}>
                <span className={styles.label}>{t('business.entity.originalQuestion')}</span>
                <span className={styles.value}>{localAgentResult.original_question}</span>
              </div>
              <div className={styles.rewrittenQuestion}>
                <span className={styles.label}>{t('business.entity.rewrittenResult')}</span>
                <span className={`${styles.value} ${styles.highlight}`}>{localAgentResult.rewritten_question}</span>
              </div>
              {localAgentResult.entities && localAgentResult.entities.length > 0 ? (
                <div className={styles.replacementsList}>
                  <div className={styles.replacementsHeader}>
                    {t('business.entity.replacementDetails', { count: localAgentResult.entities.length })}
                  </div>
                  {localAgentResult.entities.map((entity, index) => (
                    <div key={index} className={styles.replacementItem}>
                      <div className={styles.replacementRow}>
                        <span className={styles.warningTag}>{entity.original_text}</span>
                        <ElSvgIcon name="ArrowRight" size={14} color="#909399" />
                        <span className={styles.successTag}>{entity.entity_value}</span>
                      </div>
                      <div className={styles.replacementDetail}>
                        <span className={styles.sqlHint}>{entity.sql_hint}</span>
                        <span className={entity.entity_type === 'column_name' ? styles.warningTag : styles.primaryTag}>
                          {entity.entity_type === 'column_name'
                            ? t('business.entity.columnNameNoun')
                            : t('business.entity.columnValueNoun')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.noReplacements}>
                  <span className={styles.infoTag}>{t('business.entity.noReplacementsFound')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Vector recall results */}
        {localSearchResults.length > 0 ? (
          <div className={styles.searchResults}>
            <div className={styles.resultsHeader}>
              <span className={styles.resultsTitle}>
                <ElSvgIcon name="Search" size={16} />
                {t('business.entity.vectorRecallResults', { count: localSearchResults.length })}
              </span>
              <Button size="xs" variant="subtle" onClick={handleClearResults}>
                {t('business.entity.clearResults')}
              </Button>
            </div>
            <div className={styles.resultsList}>
              {localSearchResults.map((result) => (
                <div key={result.id} className={styles.searchResultItem}>
                  <div className={styles.resultHeader}>
                    <span className={styles.primaryTag}>{result.entity_name}</span>
                    <div>
                      <span style={{ marginRight: 10, color: '#666666', fontSize: 12 }}>{result.rule}</span>
                      {result.similarity ? (
                        <span className={styles.similarityBadge}>
                          {t('business.entity.similarity')} {(result.similarity * 100).toFixed(1)}%
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className={styles.resultLocation}>
                    <ElSvgIcon name="Document" size={14} color="#909399" />
                    <span>
                      {result.table_name}.{result.column_name}
                    </span>
                  </div>
                  {result.meta_data && Object.keys(result.meta_data).length > 0 && (
                    <div className={styles.resultMetadata}>
                      {Object.entries(filterMetaData(result.meta_data)).map(([key, value]) => (
                        <div key={key} className={styles.metadataItem}>
                          <span className={styles.metadataKey}>{key}:</span>
                          <span className={styles.metadataValue}>
                            {Array.isArray(value) ? value.join(', ') : value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : hasSearched && !searching && !localAgentResult ? (
          <div className={styles.noResults}>
            {/* el-empty replacement: custom empty state */}
            <div className={styles.emptyDesc}>{t('business.entity.noSimilarEntities')}</div>
            <p>{t('business.entity.tryDifferentKeywords')}</p>
          </div>
        ) : !hasSearched && !localAgentResult ? (
          <div className={styles.searchHint}>
            <Alert color="blue" title={t('business.entity.searchHintTitle')}>
              <p>
                <strong>{t('business.entity.vectorRecallLabel')}</strong>
                {t('business.entity.vectorRecallDesc')}
              </p>
            </Alert>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
