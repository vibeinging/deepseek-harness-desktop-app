import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActionIcon,
  Badge,
  Center,
  LoadingOverlay,
  NumberInput,
  Text,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { searchDataSourceReq } from '@/api/unstructured_data_source'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './DocumentSearch.module.scss'

export interface DocumentSearchProps {
  dataSourceId: string
}

interface SearchResultItem {
  score: number
  content: string
  document?: { file_name?: string }
  [k: string]: any
}

export default function DocumentSearch({ dataSourceId }: DocumentSearchProps) {
  const { t } = useTranslation()
  const projectId = useProjectStore(projectGetters.currentProjectId)

  const [searchValue, setSearchValue] = useState('')
  const [topK, setTopK] = useState<number>(5)
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResultItem[]>([])

  const handleSearch = async () => {
    if (!searchValue.trim()) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.search.inputRequired') })
      return
    }

    setSearching(true)
    try {
      const res: any = await searchDataSourceReq(projectId, dataSourceId, searchValue, topK)
      if (res.success) {
        // Ensure searchResult is always an array
        const data = res.data
        const list: SearchResultItem[] = Array.isArray(data) ? data : []
        setSearchResult(list)
        if (list.length === 0) {
          notifications.show({ color: 'blue', message: t('unstructuredData.search.noResults') })
        }
      } else {
        notifications.show({ color: 'red', message: t('unstructuredData.search.failed') })
        setSearchResult([])
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.search.failed') })
      setSearchResult([])
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className={styles['document-search']}>
      <div className={`${styles['content-card']} ${styles['search-card']}`}>
        <div className={styles['operations-header']}>
          <div className={`${styles['header-actions']} ${styles['search-actions']}`}>
            <div className={styles['topk-control']}>
              <span className={styles['topk-label']}>Top K</span>
              <NumberInput
                value={topK}
                onChange={(val) => setTopK(typeof val === 'number' ? val : Number(val) || 1)}
                min={1}
                max={100}
                size="md"
                className={styles['topk-input']}
              />
            </div>
            <TextInput
              value={searchValue}
              onChange={(e) => setSearchValue(e.currentTarget.value)}
              placeholder={t('unstructuredData.search.placeholder')}
              size="md"
              className={styles['search-input']}
              onKeyUp={(e) => {
                if (e.key === 'Enter') handleSearch()
              }}
              rightSection={
                <ActionIcon
                  variant="subtle"
                  loading={searching}
                  className={styles['search-button']}
                  onClick={handleSearch}
                >
                  <ElSvgIcon name="Search" />
                </ActionIcon>
              }
            />
          </div>
        </div>

        <div className={styles['search-result-wrapper']} style={{ position: 'relative' }}>
          <LoadingOverlay visible={searching} />
          <div className={styles['search-result-table']} style={{ width: '100%' }}>
            {searchResult.map((row, index) => (
              <div key={index} className={styles['search-result-item']}>
                <div className={styles['result-header']}>
                  <Badge size="sm" color="violet">
                    结果 {index + 1} · 相似度 {(row.score * 100).toFixed(2)}%
                  </Badge>
                  <span className={styles['document-name']}>
                    {row.document?.file_name || t('unstructuredData.search.unknownDoc')}
                  </span>
                </div>
                <div className={styles['result-content']}>{row.content}</div>
              </div>
            ))}
          </div>

          {!searching && searchResult.length === 0 && (
            <Center className={styles['search-empty']}>
              <Text c="dimmed">{t('unstructuredData.search.emptyHint')}</Text>
            </Center>
          )}
        </div>
      </div>
    </div>
  )
}
