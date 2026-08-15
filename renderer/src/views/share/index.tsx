// TODO(migration): Vue used global <style>@use imports for session/styles message.scss / markdown.scss /
//   blocks.scss (message bubble/Markdown/content block classes), which are global classes used by MessageItem/ContentBlock.
//   After session styles migrate to app/renderer, a single import here will apply full visual styles on share page.
// TODO(migration): No Mantine equivalent for el-result, so we replaced failure state with Center + custom layout + Tabler warning icon.
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Center, Loader, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
// MessageItem is currently a migration stub (no typed props yet), so this uses any bridge;
// keep the original props contract once migration finishes.
import MessageItemRaw from '@/views/session/components/MessageItem'
const MessageItem = MessageItemRaw as any
import { parseHistoryMessages } from '@/utils/StreamParser'
import { getSharedSession } from '@/api/share'
import { DshLogo } from '@/components/DshLogo'
import styles from './index.module.scss'

/**
 * Table pagination logic (from session/composables/useTablePagination).
 * In read-only share mode, all interactions are disabled and only empty/default data + pagination are needed.
 */
function useTablePagination() {
  // Table pagination state map (key = messageId-blockIndex).
  const tablePagination = useRef(new Map<string, { currentPage: number; pageSize: number }>())

  // Get or initialize table pagination state.
  const getTablePagination = useCallback((messageId: any, blockIndex: any) => {
    const key = `${messageId}-${blockIndex}`
    if (!tablePagination.current.has(key)) {
      tablePagination.current.set(key, { currentPage: 1, pageSize: 10 })
    }
    return tablePagination.current.get(key)
  }, [])

  // Return table data from known formats.
  const getTableData = useCallback((data: any) => {
    if (!data || typeof data !== 'object') {
      return []
    }
    // New format: { data: [...] }
    if (data.data && Array.isArray(data.data)) {
      return data.data
    }
    // Legacy format: { rows: [] }
    if (data.rows && Array.isArray(data.rows)) {
      return data.rows
    }
    return []
  }, [])

  // Return table columns from known formats.
  const getTableColumns = useCallback((data: any) => {
    if (!data || typeof data !== 'object') {
      return []
    }
    // New format: { data: [...], fields: [...] }
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      if (data.fields && Array.isArray(data.fields)) {
        return data.fields.map((f: any) => f.alias || f.expression || f)
      }
      return Object.keys(data.data[0])
    }
    // Legacy format: { headers: [], rows: [] }
    if (data.headers && Array.isArray(data.headers)) {
      return data.headers
    }
    return []
  }, [])

  // Return paginated rows.
  const getPaginatedTableData = useCallback(
    (data: any, messageId: any, blockIndex: any) => {
      const rows = getTableData(data)
      const pagination = getTablePagination(messageId, blockIndex)!
      const start = (pagination.currentPage - 1) * pagination.pageSize
      const end = start + pagination.pageSize
      return rows.slice(start, end)
    },
    [getTableData, getTablePagination]
  )

  // Return table summary if present.
  const getTableSummary = useCallback((data: any) => {
    if (!data || typeof data !== 'object') {
      return null
    }
    return data.summary || null
  }, [])

  return {
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    getTableSummary
  }
}

// Shared read-only context used by content blocks/controls (including future components without explicit readonly prop).
// Corresponds to Vue provide('readonly' / 'feedbackMap' / 'projectId' / 'sessionId' / 'getTable*').
export const ShareReadonlyContext = createContext<any>({
  readonly: true,
  feedbackMap: {},
  projectId: null,
  sessionId: '',
  getTablePagination: undefined,
  getTableData: undefined,
  getTableColumns: undefined,
  getPaginatedTableData: undefined,
  getTableSummary: undefined
})

export default function Share() {
  const { shareToken } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [loaded, setLoaded] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<any>({})
  const [messages, setMessages] = useState<any[]>([])

  // Injection props used by MessageItem/ContentBlock: read-only scene keeps interaction disabled and only provides fallback values/pagination.
  const {
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    getTableSummary
  } = useTablePagination()

  const sessionId = useMemo(() => sessionMeta.id || '', [sessionMeta])

  const goHome = () => {
    navigate('/')
  }

  useEffect(() => {
    const loadShared = async () => {
      const token = shareToken
      if (!token) {
        setInvalid(true)
        setLoaded(true)
        return
      }
      try {
        const res: any = await getSharedSession(token)
        if (!res?.success || !res?.data) {
          setInvalid(true)
          return
        }
        const session = res.data.session || {}
        setSessionMeta(session)
        setMessages(parseHistoryMessages(res.data.messages))
        document.title = `${session.title || t('share.readonlyBadge')} · DeepSeek Harness Desktop App`
      } catch (e) {
        // Link may be invalid/revoked/not found.
        setInvalid(true)
      } finally {
        setLoaded(true)
      }
    }
    loadShared()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken])

  // Global read-only context value.
  const ctxValue = useMemo(
    () => ({
      readonly: true,
      feedbackMap: {},
      businessId: null,
      sessionId,
      getTablePagination,
      getTableData,
      getTableColumns,
      getPaginatedTableData,
      getTableSummary
    }),
    [sessionId, getTablePagination, getTableData, getTableColumns, getPaginatedTableData, getTableSummary]
  )

  return (
    <ShareReadonlyContext.Provider value={ctxValue}>
      <div className={styles.sharePage}>
        {/* Header */}
        <header className={styles.shareHeader}>
          <div className={styles.shareHeaderInner}>
            <div className={styles.shareBrand}>
              <DshLogo title="DeepSeek Harness Desktop App" />
              <span className={styles.shareLogo}>DeepSeek Harness Desktop App</span>
              <span className={styles.shareBadge}>{t('share.readonlyBadge')}</span>
            </div>
            {loaded && !invalid && (
              <div className={styles.shareTitleWrap}>
                <span className={styles.shareTitle}>{sessionMeta.title || t('session.newConversation')}</span>
              </div>
            )}
          </div>
        </header>

        {/* Main content */}
        <main className={styles.shareMain}>
          {/* Loading state */}
          {!loaded ? (
            <div className={styles.shareState}>
              <Stack align="center" gap="sm">
                <Loader />
                <Text size="sm" c="dimmed">
                  {t('share.loading')}
                </Text>
              </Stack>
            </div>
          ) : invalid ? (
            /* Invalid/expired state */
            <div className={styles.shareState}>
              <Center>
                <Stack align="center" gap="md">
                  <IconAlertTriangle size={56} color="var(--mantine-color-yellow-6)" />
                  <Text fw={600} size="lg">
                    {t('share.invalidTitle')}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {t('share.invalidDesc')}
                  </Text>
                  <Button onClick={goHome}>{t('share.goHome')}</Button>
                </Stack>
              </Center>
            </div>
          ) : (
            /* Normal render */
            <div className={styles.shareContent}>
              <div className={styles.messagesContainer}>
                {messages.map((message: any) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    databaseId={null}
                    sessionId={sessionMeta.id || ''}
                    readonly={true}
                  />
                ))}
              </div>

              {/* Read-only notice */}
              <div className={styles.shareReadonlyNote}>{t('share.readonlyNote')}</div>
            </div>
          )}
        </main>

        {/* Footer CTA */}
        {loaded && !invalid && (
          <footer className={styles.shareFooter}>
            <span className={styles.shareFooterText}>{t('share.ctaText')}</span>
            <Button radius="xl" size="xs" onClick={goHome}>
              {t('share.ctaButton')}
            </Button>
          </footer>
        )}
      </div>
    </ShareReadonlyContext.Provider>
  )
}
