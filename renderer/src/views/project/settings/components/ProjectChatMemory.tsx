import { useCallback, useEffect, useState } from 'react'
import { Button, Switch } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconHistory, IconMessage, IconShieldLock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import {
  excludeProjectChatMemoryConversation,
  getProjectChatMemory,
  includeProjectChatMemoryConversation,
  updateProjectChatMemory,
  type ProjectChatMemoryState
} from '@/api/agent'
import styles from './ProjectChatMemory.module.scss'

function responseData(response: any): ProjectChatMemoryState | null {
  const data = response?.data !== undefined ? response.data : response
  return data && typeof data === 'object' ? data : null
}

function formatUpdatedAt(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default function ProjectChatMemory({ projectId }: { projectId?: string }) {
  const { t } = useTranslation()
  const [state, setState] = useState<ProjectChatMemoryState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [updatingSessionId, setUpdatingSessionId] = useState('')

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      setState(responseData(await getProjectChatMemory(projectId)))
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || t('project.chatMemory.loadFailed') })
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    void load()
  }, [load])

  const setEnabled = async (enabled: boolean) => {
    if (!projectId || !state || saving) return
    const previous = state.enabled
    setState({ ...state, enabled })
    setSaving(true)
    try {
      await updateProjectChatMemory(projectId, enabled)
      notifications.show({ color: 'green', message: enabled ? t('project.chatMemory.enabled') : t('project.chatMemory.disabled') })
    } catch (error: any) {
      setState((current) => current ? { ...current, enabled: previous } : current)
      notifications.show({ color: 'red', message: error?.message || t('project.chatMemory.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const setExcluded = async (sessionId: string, excluded: boolean) => {
    if (!projectId || !state || updatingSessionId) return
    setUpdatingSessionId(sessionId)
    try {
      if (excluded) await excludeProjectChatMemoryConversation(projectId, sessionId)
      else await includeProjectChatMemoryConversation(projectId, sessionId)
      setState((current) => {
        if (!current) return current
        const source_conversations = current.source_conversations.map((conversation) => (
          conversation.id === sessionId ? { ...conversation, excluded } : conversation
        ))
        return {
          ...current,
          source_conversations,
          eligible_count: source_conversations.filter((conversation) => !conversation.excluded).length,
          excluded_count: source_conversations.filter((conversation) => conversation.excluded).length
        }
      })
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || t('project.chatMemory.saveFailed') })
    } finally {
      setUpdatingSessionId('')
    }
  }

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerIcon}><IconHistory size={22} stroke={1.6} /></div>
        <div>
          <h2>{t('project.chatMemory.title')}</h2>
          <p>{t('project.chatMemory.description')}</p>
        </div>
      </header>

      <div className={styles.switchCard}>
        <div>
          <strong>{t('project.chatMemory.switchLabel')}</strong>
          <span>{t('project.chatMemory.switchDescription')}</span>
        </div>
        <Switch
          checked={state?.enabled ?? true}
          disabled={loading || saving || !state}
          aria-label={t('project.chatMemory.switchLabel')}
          onChange={(event) => void setEnabled(event.currentTarget.checked)}
        />
      </div>

      <div className={styles.privacyNote}>
        <IconShieldLock size={16} stroke={1.7} />
        <span>{t('project.chatMemory.privacy')}</span>
      </div>

      <div className={styles.listHead}>
        <div>
          <h3>{t('project.chatMemory.sourcesTitle')}</h3>
          <p>{t('project.chatMemory.sourcesDescription')}</p>
        </div>
        {state && <span>{state.eligible_count} {t('project.chatMemory.available')}</span>}
      </div>

      <div className={styles.list}>
        {loading ? (
          <div className={styles.empty}>{t('project.chatMemory.loading')}</div>
        ) : !state?.source_conversations?.length ? (
          <div className={styles.empty}>{t('project.chatMemory.empty')}</div>
        ) : state.source_conversations.map((conversation) => (
          <div className={styles.row} data-excluded={conversation.excluded ? 'true' : undefined} key={conversation.id}>
            <div className={styles.rowIcon}><IconMessage size={16} stroke={1.7} /></div>
            <div className={styles.rowCopy}>
              <strong>{conversation.title || t('project.chatMemory.untitled')}</strong>
              <span>
                {conversation.message_count || 0} {t('project.chatMemory.messages')}
                {conversation.updated_at ? ` · ${formatUpdatedAt(conversation.updated_at)}` : ''}
                {conversation.status === 'archived' ? ` · ${t('project.chatMemory.archived')}` : ''}
              </span>
            </div>
            <Button
              size="compact-xs"
              variant="subtle"
              color={conversation.excluded ? 'gray' : 'red'}
              loading={updatingSessionId === conversation.id}
              disabled={Boolean(updatingSessionId)}
              onClick={() => void setExcluded(conversation.id, !conversation.excluded)}
            >
              {conversation.excluded ? t('project.chatMemory.include') : t('project.chatMemory.exclude')}
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
