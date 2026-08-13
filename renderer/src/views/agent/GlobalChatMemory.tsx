import { useCallback, useEffect, useState } from 'react'
import { Button, Switch } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconHistory,
  IconMessage,
  IconPencil,
  IconPlus,
  IconShieldLock,
  IconTrash
} from '@tabler/icons-react'

import {
  createGlobalChatMemoryEntry,
  deleteGlobalChatMemoryEntry,
  excludeGlobalChatMemoryConversation,
  getGlobalChatMemory,
  includeGlobalChatMemoryConversation,
  updateGlobalChatMemory,
  updateGlobalChatMemoryEntry,
  type GlobalChatMemoryEntry,
  type GlobalChatMemorySettings,
  type GlobalChatMemoryState
} from '@/api/agent'
import styles from './GlobalChatMemory.module.scss'

function responseData<T>(response: any): T | null {
  const data = response?.data !== undefined ? response.data : response
  return data && typeof data === 'object' ? data as T : null
}

function formatDate(value?: string | null) {
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

const AUDIT_LABELS: Record<string, string> = {
  'settings.updated': '更新了记忆开关',
  'entry.created': '添加了一条记忆',
  'entry.updated': '修改了一条记忆',
  'entry.deleted': '删除了一条记忆',
  'conversation.excluded': '排除了一个来源对话',
  'conversation.included': '恢复了一个来源对话'
}

export default function GlobalChatMemory() {
  const [state, setState] = useState<GlobalChatMemoryState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editingDraft, setEditingDraft] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setState(responseData<GlobalChatMemoryState>(await getGlobalChatMemory()))
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || '读取记忆设置失败' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setSetting = async (key: keyof GlobalChatMemorySettings, enabled: boolean) => {
    if (!state || busy) return
    const previous = state.settings[key]
    setState({ ...state, settings: { ...state.settings, [key]: enabled } })
    setBusy(key)
    try {
      await updateGlobalChatMemory({ [key]: enabled })
      await load()
    } catch (error: any) {
      setState((current) => current ? { ...current, settings: { ...current.settings, [key]: previous } } : current)
      notifications.show({ color: 'red', message: error?.message || '保存记忆开关失败' })
    } finally {
      setBusy('')
    }
  }

  const addEntry = async () => {
    const content = draft.trim()
    if (!content || busy) return
    setBusy('create')
    try {
      await createGlobalChatMemoryEntry(content)
      setDraft('')
      await load()
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || '添加记忆失败' })
    } finally {
      setBusy('')
    }
  }

  const beginEdit = (entry: GlobalChatMemoryEntry) => {
    setEditingId(entry.id)
    setEditingDraft(entry.content)
  }

  const saveEdit = async () => {
    const content = editingDraft.trim()
    if (!editingId || !content || busy) return
    setBusy(`entry:${editingId}`)
    try {
      await updateGlobalChatMemoryEntry(editingId, content)
      setEditingId('')
      setEditingDraft('')
      await load()
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || '修改记忆失败' })
    } finally {
      setBusy('')
    }
  }

  const removeEntry = async (entry: GlobalChatMemoryEntry) => {
    if (busy || !window.confirm('删除这条记忆？删除后不会再用于回答。')) return
    setBusy(`entry:${entry.id}`)
    try {
      await deleteGlobalChatMemoryEntry(entry.id)
      await load()
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || '删除记忆失败' })
    } finally {
      setBusy('')
    }
  }

  const setConversationExcluded = async (sessionId: string, excluded: boolean) => {
    if (busy) return
    setBusy(`conversation:${sessionId}`)
    try {
      if (excluded) await excludeGlobalChatMemoryConversation(sessionId)
      else await includeGlobalChatMemoryConversation(sessionId)
      await load()
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.message || '保存来源设置失败' })
    } finally {
      setBusy('')
    }
  }

  return (
    <section className={styles.page} data-global-memory-settings>
      <header className={styles.header}>
        <div className={styles.headerIcon}><IconHistory size={22} stroke={1.6} /></div>
        <div>
          <h1>记忆</h1>
          <p>让普通聊天在本机记住你明确保存的内容，并按需参考其他普通聊天。</p>
        </div>
      </header>

      <div className={styles.switches}>
        <div className={styles.switchRow} data-memory-setting="saved">
          <div>
            <strong>使用已保存记忆</strong>
            <span>把下面由你管理的短文本作为普通聊天的个性化参考。</span>
          </div>
          <Switch
            data-testid="saved-memory-toggle"
            checked={state?.settings.saved_memory_enabled ?? true}
            disabled={loading || Boolean(busy) || !state}
            aria-label="使用已保存记忆"
            onChange={(event) => void setSetting('saved_memory_enabled', event.currentTarget.checked)}
          />
        </div>
        <div className={styles.switchRow} data-memory-setting="history">
          <div>
            <strong>参考聊天历史</strong>
            <span>只从本机其他普通聊天中选择与当前问题有关的可见内容。</span>
          </div>
          <Switch
            data-testid="chat-history-toggle"
            checked={state?.settings.chat_history_enabled ?? true}
            disabled={loading || Boolean(busy) || !state}
            aria-label="参考聊天历史"
            onChange={(event) => void setSetting('chat_history_enabled', event.currentTarget.checked)}
          />
        </div>
      </div>

      <div className={styles.privacy}>
        <IconShieldLock size={16} stroke={1.7} />
        <span>记忆只保存在本机，不会同步到云端账户。临时对话和项目聊天不会使用这里的内容。</span>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <h2>已保存记忆</h2>
            <p>你可以随时添加、修改或删除。每条最多 1000 个字。</p>
          </div>
          <span>{state?.entries.length || 0} 条</span>
        </div>
        <div className={styles.composer}>
          <textarea
            data-testid="memory-entry-input"
            value={draft}
            maxLength={1000}
            rows={3}
            placeholder="例如：我偏好简短、结论优先的回答。"
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div>
            <span>{draft.length}/1000</span>
            <Button
              data-testid="memory-entry-add"
              size="compact-sm"
              leftSection={<IconPlus size={14} />}
              loading={busy === 'create'}
              disabled={!draft.trim() || Boolean(busy && busy !== 'create')}
              onClick={() => void addEntry()}
            >
              添加
            </Button>
          </div>
        </div>
        <div className={styles.list} data-testid="memory-entry-list">
          {loading ? (
            <div className={styles.empty}>正在读取…</div>
          ) : !state?.entries.length ? (
            <div className={styles.empty}>还没有保存记忆。</div>
          ) : state.entries.map((entry) => (
            <div className={styles.memoryRow} key={entry.id} data-memory-entry-id={entry.id}>
              {editingId === entry.id ? (
                <>
                  <textarea
                    data-testid="memory-entry-edit-input"
                    value={editingDraft}
                    maxLength={1000}
                    rows={3}
                    onChange={(event) => setEditingDraft(event.currentTarget.value)}
                  />
                  <div className={styles.editActions}>
                    <Button size="compact-xs" variant="default" onClick={() => setEditingId('')}>取消</Button>
                    <Button
                      data-testid="memory-entry-save"
                      size="compact-xs"
                      loading={busy === `entry:${entry.id}`}
                      disabled={!editingDraft.trim()}
                      onClick={() => void saveEdit()}
                    >保存</Button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.memoryCopy}>
                    <p>{entry.content}</p>
                    {entry.updated_at && <span>{formatDate(entry.updated_at)}</span>}
                  </div>
                  <div className={styles.rowActions}>
                    <button type="button" aria-label="修改记忆" data-testid="memory-entry-edit" onClick={() => beginEdit(entry)}>
                      <IconPencil size={15} stroke={1.7} />
                    </button>
                    <button type="button" aria-label="删除记忆" data-testid="memory-entry-delete" onClick={() => void removeEntry(entry)}>
                      <IconTrash size={15} stroke={1.7} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <h2>聊天历史来源</h2>
            <p>按对话排除或恢复；被排除的对话不会进入后续回答。</p>
          </div>
        </div>
        <div className={styles.list} data-testid="memory-source-list">
          {loading ? (
            <div className={styles.empty}>正在读取…</div>
          ) : !state?.source_conversations.length ? (
            <div className={styles.empty}>还没有可作为来源的普通聊天。</div>
          ) : state.source_conversations.map((conversation) => (
            <div
              className={styles.sourceRow}
              data-memory-source-id={conversation.id}
              data-excluded={conversation.excluded ? 'true' : undefined}
              key={conversation.id}
            >
              <IconMessage size={16} stroke={1.7} />
              <div>
                <strong>{conversation.title || '新对话'}</strong>
                <span>
                  {conversation.message_count || 0} 条消息
                  {conversation.updated_at ? ` · ${formatDate(conversation.updated_at)}` : ''}
                  {conversation.status === 'archived' ? ' · 已归档' : ''}
                </span>
              </div>
              <Button
                data-testid="memory-source-toggle"
                size="compact-xs"
                variant="subtle"
                color={conversation.excluded ? 'gray' : 'red'}
                loading={busy === `conversation:${conversation.id}`}
                disabled={Boolean(busy && busy !== `conversation:${conversation.id}`)}
                onClick={() => void setConversationExcluded(conversation.id, !conversation.excluded)}
              >
                {conversation.excluded ? '恢复' : '排除'}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <h2>最近操作</h2>
            <p>这里只记录开关和管理动作，不保存模型密钥或隐藏运行内容。</p>
          </div>
        </div>
        <div className={styles.auditList} data-testid="memory-audit-list">
          {!state?.audit.length ? (
            <div className={styles.empty}>还没有操作记录。</div>
          ) : state.audit.slice(0, 20).map((item) => (
            <div key={item.id}>
              <strong>{AUDIT_LABELS[item.action] || item.action}</strong>
              <span>{formatDate(item.created_at)}</span>
            </div>
          ))}
        </div>
      </section>
    </section>
  )
}
