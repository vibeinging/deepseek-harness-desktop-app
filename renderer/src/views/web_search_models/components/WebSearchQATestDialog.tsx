import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Accordion, Badge, Button, Modal, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { qaTestWebSearchModelReq } from '@/api/web_search_models'
import styles from './WebSearchQATestDialog.module.scss'

export interface WebSearchQATestDialogProps {
  modelValue?: boolean
  projectId: string
  modelId: string
  // defineEmits(['update:modelValue']) equivalent callback prop.
  onUpdateModelValue?: (value: boolean) => void
}

export default function WebSearchQATestDialog({
  modelValue = false,
  projectId,
  modelId,
  onUpdateModelValue,
}: WebSearchQATestDialogProps) {
  const { t } = useTranslation()

  // QA testing states
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [hasResults, setHasResults] = useState(false)
  const [testing, setTesting] = useState(false)
  const [searchEngine, setSearchEngine] = useState('')
  const [query, setQuery] = useState('')

  // Reset state when dialog opens.
  useEffect(() => {
    if (modelValue) {
      setQuery('')
      setSearchResults([])
      setHasResults(false)
      setSearchEngine('')
    }
  }, [modelValue])

  const handleQATest = async () => {
    if (!modelId || !query.trim()) {
      return
    }

    try {
      setTesting(true)
      const res: any = await qaTestWebSearchModelReq(projectId, {
        model_id: modelId,
        query: query.trim(),
      })

      if (res.success) {
        const results = res.data.results || []
        setSearchResults(results)
        setSearchEngine(res.data.model || '')
        setHasResults(true)
        notifications.show({
          color: 'green',
          message: t('webSearch.msg.qaTestComplete', { count: results.length }),
        })
      } else {
        notifications.show({
          color: 'red',
          message: res.msg || t('webSearch.msg.qaTestFailed'),
        })
      }
    } catch (error) {
      console.error('QA test failed:', error)
      notifications.show({
        color: 'red',
        message: t('webSearch.msg.qaTestFailed'),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      opened={modelValue}
      onClose={() => onUpdateModelValue?.(false)}
      title={t('webSearch.testQA')}
      size="90%"
      closeOnClickOutside={false}
      classNames={{ root: styles.qaTestDialog }}
    >
      <div className={styles.qaTestContent}>
        {/* Input section */}
        <div className={styles.inputSection}>
          <Textarea
            label={t('webSearch.qaTestQuestion')}
            withAsterisk
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            rows={3}
            placeholder={t('webSearch.qaTestQuestionPlaceholder')}
            maxLength={500}
            className={styles.questionInput}
          />
        </div>

        {/* Result display area */}
        {hasResults && searchResults.length > 0 ? (
          <div className={styles.resultsSection}>
            <div className={styles.resultsHeader}>
              <span className={styles.resultsCount}>
                {t('webSearch.qaResultsFound', { count: searchResults.length })}
              </span>
              <Badge color="gray" size="sm" variant="light">
                {t('webSearch.searchEngine')}: {searchEngine}
              </Badge>
            </div>

            {/* Search result list */}
            <div className={styles.resultsList}>
              {searchResults.map((result, index) => (
                <div key={index} className={styles.resultItem}>
                  <div className={styles.resultHeader}>
                    <span className={styles.resultIndex}>{index + 1}</span>
                    {result.url ? (
                      <a
                        href={result.url}
                        target="_blank"
                        className={styles.resultTitle}
                        rel="noopener noreferrer"
                      >
                        {result.title || t('webSearch.qaNoTitle')}
                        <span className={styles.externalLinkIcon}>
                          <ElSvgIcon name="Link" size={14} />
                        </span>
                      </a>
                    ) : (
                      <span className={styles.resultTitle}>
                        {result.title || t('webSearch.qaNoTitle')}
                      </span>
                    )}
                  </div>

                  {result.url && (
                    <div className={styles.resultUrl}>
                      <Badge color="gray" size="sm" variant="light" className={styles.urlTag}>
                        {result.url}
                      </Badge>
                    </div>
                  )}

                  {result.content && (
                    <div className={styles.resultContent}>{result.content}</div>
                  )}

                  {result.published_date && (
                    <div className={styles.resultMeta}>
                      <ElSvgIcon name="Calendar" size={14} />
                      <span>
                        {t('webSearch.qaPublishedDate')}: {result.published_date}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* JSON preview (optional) */}
            <div className={styles.resultsJson} style={{ marginTop: 20 }}>
              <Accordion variant="contained">
                <Accordion.Item value="raw-json">
                  <Accordion.Control>{t('webSearch.qaViewRawJson')}</Accordion.Control>
                  <Accordion.Panel>
                    <pre className={styles.jsonDisplay}>
                      {JSON.stringify(searchResults, null, 2)}
                    </pre>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </div>
          </div>
        ) : hasResults ? (
          /* No-result placeholder */
          <div className={styles.noResults}>
            <div className={styles.emptyInner}>
              <span className={styles.emptyIcon}>
                <ElSvgIcon name="Search" size={48} />
              </span>
              <div className={styles.emptyText}>
                <p>{t('webSearch.qaNoResultsDesc')}</p>
                <p className={styles.emptySubtitle}>{t('webSearch.qaNoResultsSubtitle')}</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* footer */}
      <div className={styles.dialogFooter}>
        <Button variant="default" onClick={() => onUpdateModelValue?.(false)}>
          {t('common.close')}
        </Button>
        <Button
          color="blue"
          onClick={handleQATest}
          loading={testing}
          disabled={!query.trim()}
          leftSection={<ElSvgIcon name="Search" size={16} />}
        >
          {t('webSearch.qaStartTest')}
        </Button>
      </div>
    </Modal>
  )
}
