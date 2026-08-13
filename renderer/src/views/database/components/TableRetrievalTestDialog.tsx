import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Accordion, Badge, Button, Center, Modal, Table, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconSearch } from '@tabler/icons-react'
import { searchRelevantTablesReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './TableRetrievalTestDialog.module.scss'

// defineProps → props + interface
// Vue used v-model:modelValue for dialog control. Migrated callers now use opened/onClose.
// Keep both APIs compatible: opened/onClose takes priority, fallback to modelValue/onUpdate:modelValue.
interface TableRetrievalTestDialogProps {
  opened?: boolean
  onClose?: () => void
  modelValue?: boolean
  databaseId: string
  // defineEmits(['update:modelValue']) => callback prop
  'onUpdate:modelValue'?: (v: boolean) => void
}

// Mantine Badge has no EP type concept, so map EP type to color.
const tagColorMap: Record<string, string> = {
  success: 'green',
  warning: 'orange',
  info: 'gray',
  danger: 'red',
  primary: 'blue'
}

export default function TableRetrievalTestDialog(props: TableRetrievalTestDialogProps) {
  const { databaseId } = props
  // opened takes precedence over modelValue; on close, call onClose first, fallback to onUpdate:modelValue(false)
  const isOpen = props.opened ?? props.modelValue ?? false
  const emitUpdate = (v: boolean) => {
    if (props.onClose && !v) {
      props.onClose()
      return
    }
    props['onUpdate:modelValue']?.(v)
  }

  const { t } = useTranslation()
  const { isMobile } = useResponsive()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  // computed => derived constant
  const retrievalDialogWidth = isMobile ? 'calc(100vw - 16px)' : '90%'

  // Retrieval test related state
  const [retrievalResults, setRetrievalResults] = useState<any[]>([])
  const [hasRetrievalResults, setHasRetrievalResults] = useState(false)
  const [testingRetrieval, setTestingRetrieval] = useState(false)
  // Mantine has no native expanded rows, so maintain expanded row id list manually.
  const [expandedRows, setExpandedRows] = useState<any[]>([])
  const [retrievalForm, setRetrievalForm] = useState({
    question: '',
    similarity_threshold: 0.5,
    top_k: 5
  })

  // Calculate retrieval method statistics
  const methodStats = useMemo(() => {
    const stats = {
      vector: 0,
      high_recall: 0,
      mixed: 0
    }

    retrievalResults.forEach((item) => {
      const method = item.retrieval_method
      if (method.includes(',')) {
        stats.mixed++
      } else if (method === 'vector') {
        stats.vector++
      } else if (method === 'high_recall') {
        stats.high_recall++
      }
    })

    return stats
  }, [retrievalResults])

  const toggleExpand = (id: any) => {
    setExpandedRows((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const handleRetrievalTest = async () => {
    if (!databaseId || !retrievalForm.question.trim()) {
      return
    }

    try {
      setTestingRetrieval(true)
      const res: any = await searchRelevantTablesReq(
        currentProjectId,
        databaseId,
        retrievalForm.question,
        retrievalForm.similarity_threshold || 0.5
      )

      if (res.success) {
        setRetrievalResults(res.data.items || [])
        setHasRetrievalResults(true)

        notifications.show({
          color: 'green',
          message: t('database.retrievalTest.testComplete', { count: res.data.count || 0 })
        })
      } else {
        notifications.show({ color: 'red', message: res.message || t('database.retrievalTest.testFailed') })
      }
    } catch (error) {
      console.error('Retrieval test failed:', error)
      notifications.show({ color: 'red', message: t('database.retrievalTest.testFailed') })
    } finally {
      setTestingRetrieval(false)
    }
  }

  // Get retrieval method badge type
  const getMethodTagType = (method: string) => {
    const types: Record<string, string> = {
      vector: 'success',
      high_recall: 'warning'
    }
    return types[method] || 'info'
  }

  // Get retrieval method badge label
  const getMethodLabel = (method: string) => {
    const labels: Record<string, string> = {
      vector: t('database.retrievalTest.vector'),
      high_recall: t('database.retrievalTest.highPriorityLabel')
    }
    return labels[method] || method
  }

  // Sort by similarity (keep the original sort-method behavior)
  const sortBySimilarity = (a: any, b: any) => {
    const simA = a.similarity !== undefined ? a.similarity : -1
    const simB = b.similarity !== undefined ? b.similarity : -1
    return simA - simB
  }

  // Sortable column replacement: keep local sort direction (asc -> desc -> reset)
  const [methodSortDir, setMethodSortDir] = useState<'asc' | 'desc' | null>(null)
  const sortedResults = useMemo(() => {
    if (!methodSortDir) return retrievalResults
    const arr = [...retrievalResults].sort(sortBySimilarity)
    return methodSortDir === 'desc' ? arr.reverse() : arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrievalResults, methodSortDir])

  const toggleMethodSort = () => {
    setMethodSortDir((prev) => (prev === 'asc' ? 'desc' : prev === 'desc' ? null : 'asc'))
  }

  // Expanded row details (table of column details)
  const renderExpandedDetail = (row: any) => (
    <div className={styles['columns-detail']}>
      {/* Table description */}
      {row.description && (
        <div className={styles['table-description-detail']}>
          <div className={styles['detail-label']}>{t('database.retrievalTest.tableDesc')}</div>
          <div className={styles['detail-content']}>{row.description}</div>
        </div>
      )}

      {/* Column details */}
      <div className={styles['columns-header']}>
        <span className={styles['columns-title']}>
          {t('database.retrievalTest.columnDetails')} ({row.columns?.length || 0})
        </span>
      </div>
      {row.columns && row.columns.length > 0 ? (
        <Table className={styles['columns-table']}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('database.retrievalTest.columnName')}</Table.Th>
              <Table.Th>{t('database.retrievalTest.type')}</Table.Th>
              <Table.Th>{t('database.retrievalTest.comment')}</Table.Th>
              <Table.Th>{t('database.retrievalTest.exampleValues')}</Table.Th>
              <Table.Th>{t('database.retrievalTest.tags')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {row.columns.map((col: any, cIdx: number) => (
              <Table.Tr key={cIdx}>
                <Table.Td>
                  <Badge size="sm" variant="light" color="gray">
                    {col.column_name}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <span className={styles['data-type-text']}>{col.data_type}</span>
                </Table.Td>
                <Table.Td>
                  <span className={styles['column-desc']}>{col.description || '-'}</span>
                </Table.Td>
                <Table.Td>
                  {col.example_values && col.example_values.length > 0 ? (
                    <div className={styles['example-values']}>
                      {col.example_values.map((val: any, idx: number) => (
                        <span key={idx} className={styles['example-item']}>
                          {val}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className={styles['no-example']}>-</span>
                  )}
                </Table.Td>
                <Table.Td>
                  <div className={styles['column-badges']}>
                    {col.is_primary_key && (
                      <Badge size="sm" color="red">
                        PK
                      </Badge>
                    )}
                    {col.is_foreign_key && (
                      <Badge size="sm" color="orange">
                        FK
                      </Badge>
                    )}
                    {col.is_high_recall && (
                      <Badge size="sm" color="green">
                        {t('database.retrievalTest.highRecall')}
                      </Badge>
                    )}
                    {!col.nullable && (
                      <Badge size="sm" color="gray">
                        {t('database.retrievalTest.required')}
                      </Badge>
                    )}
                  </div>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Center className={styles['empty-columns']}>
          <span>{t('database.retrievalTest.noColumnInfo')}</span>
        </Center>
      )}
    </div>
  )

  return (
    <Modal
      opened={isOpen}
      onClose={() => emitUpdate(false)}
      title={t('database.retrievalTest.title')}
      size={retrievalDialogWidth}
      closeOnClickOutside={false}
      classNames={{ root: styles['test-retrieval-dialog'], body: styles['dialog-body'] }}
    >
      <div className={styles['test-retrieval-content']}>
        {/* Input area */}
        <div className={styles['input-section']}>
          <Textarea
            label={t('database.retrievalTest.testQuestion')}
            required
            value={retrievalForm.question}
            onChange={(e) => setRetrievalForm((f) => ({ ...f, question: e.currentTarget.value }))}
            autosize
            minRows={3}
            maxRows={3}
            placeholder={t('database.retrievalTest.questionPlaceholder')}
            maxLength={500}
            className={styles['question-input']}
          />
        </div>

        {/* Result display area */}
        {hasRetrievalResults && retrievalResults.length > 0 ? (
          <div className={styles['results-section']}>
            <div className={styles['results-header']}>
              <span className={styles['results-count']}>
                {t('database.retrievalTest.foundTables', { count: retrievalResults.length })}
              </span>
              <div className={styles['method-stats']}>
                {methodStats.vector ? (
                  <Badge color="green" size="sm" variant="outline">
                    {t('database.retrievalTest.vectorRecall')}: {methodStats.vector}
                  </Badge>
                ) : null}
                {methodStats.high_recall ? (
                  <Badge color="orange" size="sm" variant="outline">
                    {t('database.retrievalTest.highPriority')}: {methodStats.high_recall}
                  </Badge>
                ) : null}
                {methodStats.mixed ? (
                  <Badge color="gray" size="sm" variant="outline">
                    {t('database.retrievalTest.mixedRecall')}: {methodStats.mixed}
                  </Badge>
                ) : null}
              </div>
            </div>

            {/* Expandable table for retrieval results */}
            <div className={styles['results-table']}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {/* Expand icon column */}
                    <Table.Th style={{ width: 40 }} />
                    {/* Table name */}
                    <Table.Th>{t('database.retrievalTest.tableName')}</Table.Th>
                    {/* Retrieved columns */}
                    <Table.Th style={{ minWidth: 400 }}>
                      {t('database.retrievalTest.recalledColumns')}
                    </Table.Th>
                    {/* Retrieval method (sortable) */}
                    <Table.Th
                      style={{ width: 140, cursor: 'pointer', userSelect: 'none' }}
                      onClick={toggleMethodSort}
                    >
                      {t('database.retrievalTest.retrievalMethod')}
                      {methodSortDir === 'asc' ? ' ▲' : methodSortDir === 'desc' ? ' ▼' : ''}
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {sortedResults.map((row) => {
                    const expanded = expandedRows.includes(row.id)
                    return (
                      <Fragment key={row.id}>
                        <Table.Tr>
                          {/* Expand icon */}
                          <Table.Td>
                            <span
                              className={styles['expand-icon']}
                              style={{ cursor: 'pointer' }}
                              onClick={() => toggleExpand(row.id)}
                            >
                              {expanded ? '▼' : '▶'}
                            </span>
                          </Table.Td>
                          {/* Table name */}
                          <Table.Td>
                            <div className={styles['table-name-cell']}>
                              <span className={styles['table-name']}>{row.table_name}</span>
                              <span className={styles['column-count']}>
                                {row.columns?.length || 0} {t('database.retrievalTest.cols')}
                              </span>
                            </div>
                          </Table.Td>
                          {/* Retrieved columns (name + comment) */}
                          <Table.Td>
                            <div className={styles['columns-summary']}>
                              {(row.columns || []).map((col: any, idx: number) => (
                                <div key={idx} className={styles['column-item']}>
                                  <span className={styles['col-name']}>{col.column_name}：</span>
                                  {col.description && (
                                    <span className={styles['col-desc']}>{col.description}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </Table.Td>
                          {/* Retrieval method (with similarity) */}
                          <Table.Td>
                            <div className={styles['retrieval-method-tags']}>
                              {row.retrieval_method.split(',').map((method: string) => (
                                <Badge
                                  key={method}
                                  color={tagColorMap[getMethodTagType(method)] || 'gray'}
                                  size="sm"
                                >
                                  {getMethodLabel(method)}
                                  {method === 'vector' && row.similarity !== undefined && (
                                    <span className={styles['similarity-in-tag']}>
                                      {(row.similarity * 100).toFixed(1)}%
                                    </span>
                                  )}
                                </Badge>
                              ))}
                            </div>
                          </Table.Td>
                        </Table.Tr>
                        {expanded && (
                          <Table.Tr className={styles['expanded-row']}>
                            <Table.Td colSpan={4} className={styles['expanded-cell']}>
                              {renderExpandedDetail(row)}
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </Fragment>
                    )
                  })}
                </Table.Tbody>
              </Table>
            </div>

            {/* JSON view (optional) */}
            <div className={styles['results-json']} style={{ marginTop: 20 }}>
              <Accordion variant="contained">
                <Accordion.Item value="json">
                  <Accordion.Control>{t('database.retrievalTest.viewRawJson')}</Accordion.Control>
                  <Accordion.Panel>
                    <pre className={styles['json-display']}>
                      {JSON.stringify(retrievalResults, null, 2)}
                    </pre>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </div>
          </div>
        ) : hasRetrievalResults ? (
          /* No-result hint */
          <div className={styles['no-results']}>
            <Center style={{ flexDirection: 'column' }}>
              <IconSearch size={48} className={styles['empty-icon']} />
              <div className={styles['empty-text']}>
                <p>{t('database.retrievalTest.noRelatedTable')}</p>
                <p className={styles['empty-subtitle']}>{t('database.retrievalTest.tryAdjust')}</p>
              </div>
            </Center>
          </div>
        ) : null}
      </div>

      <div className={styles['dialog-footer']}>
        <Button variant="default" onClick={() => emitUpdate(false)}>
          {t('database.action.close')}
        </Button>
        <Button
          onClick={handleRetrievalTest}
          loading={testingRetrieval}
          disabled={!retrievalForm.question.trim()}
          leftSection={<IconSearch size={16} />}
        >
          {t('database.retrievalTest.startTest')}
        </Button>
      </div>
    </Modal>
  )
}
