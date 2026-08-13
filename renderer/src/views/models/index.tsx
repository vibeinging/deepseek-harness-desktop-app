import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Loader, Modal, PasswordInput, Select, TextInput } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import {
  IconAlertTriangle,
  IconCheck,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react'

import {
  discoverDshModelsReq,
  getDshModelSettingsReq,
  mutateDshModelSettingsReq,
  setDshModelCredentialReq,
  subscribeDshModelSettingsEvents,
  unsetDshModelCredentialReq,
  type DshModelEntry,
  type DshModelSettingsSnapshot,
  type DshProviderEntry,
  type DshSettingsNamespace,
  type DshSettingsOp,
} from '@/api/dsh-models'
import styles from './index.module.scss'

interface ModelsProps {
  readonly?: boolean
  showHeader?: boolean
  projectId?: string | null
}

type JsonRecord = Record<string, any>

const PROTOCOLS = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]

const REASONING = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '最少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

const DEEPSEEK_REASONING = REASONING.filter((item) => ['off', 'high', 'max'].includes(item.value))

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function valueAt(source: unknown, path: string[]): unknown {
  let value: unknown = source
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as JsonRecord)[key]
  }
  return value
}

function hasAt(source: unknown, path: string[]): boolean {
  if (path.length === 0) return source !== undefined
  let value: unknown = source
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.prototype.hasOwnProperty.call(value, key)) return false
    value = (value as JsonRecord)[key]
  }
  return true
}

function cloneModels(value: unknown): DshModelEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((model) => ({ ...objectValue(model) })) as DshModelEntry[]
}

function deriveCredentialRef(provider: string) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function providerNamespace(snapshot: DshModelSettingsSnapshot, provider: DshProviderEntry) {
  return snapshot.namespaces.find((item) => item.ns === provider.settingsNs)
}

function providerProfile(snapshot: DshModelSettingsSnapshot, provider: DshProviderEntry) {
  const namespace = providerNamespace(snapshot, provider)
  return objectValue(valueAt(namespace?.value, provider.settingsPath))
}

function providerConfigured(snapshot: DshModelSettingsSnapshot, provider: DshProviderEntry) {
  const namespace = providerNamespace(snapshot, provider)
  return Boolean(namespace && (provider.settingsPath.length === 0 || valueAt(namespace.value, provider.settingsPath) !== undefined))
}

function literalKeyConfigured(namespace: DshSettingsNamespace | undefined, settingsPath: string[]) {
  const path = [...settingsPath, 'apiKey']
  return Boolean(namespace?.secrets.some((secret) => secret.set
    && secret.path.length === path.length
    && secret.path.every((part, index) => part === path[index])))
}

function responseData<T>(response: any): T {
  return (response?.data ?? response) as T
}

function messageOf(error: any, fallback: string) {
  return error?.message || error?.msg || fallback
}

interface EditorProps {
  snapshot: DshModelSettingsSnapshot
  provider: DshProviderEntry | null
  custom: boolean
  readOnly: boolean
  onClose: (changed: boolean) => void
}

function ProviderEditor({ snapshot, provider, custom, readOnly, onClose }: EditorProps) {
  const namespace = provider ? providerNamespace(snapshot, provider) : snapshot.namespaces.find((item) => item.ns === 'llm-pi-ai')
  const [route, setRoute] = useState(provider?.provider || '')
  const settingsPath = custom ? ['providers', route] : provider?.settingsPath || []
  const layout = (custom || namespace?.ns === 'llm-pi-ai') ? 'pi-ai' : 'deepseek'
  const effective = provider ? providerProfile(snapshot, provider) : {}
  const stored = provider ? objectValue(valueAt(namespace?.user, provider.settingsPath)) : {}
  const field = (key: string) => Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : effective[key]
  const initialDisplayName = String(field('displayName') || provider?.displayName || '')
  const initialBaseURL = String(field('baseURL') || '')
  const initialApi = String(field('api') || (custom ? 'openai-completions' : ''))
  const initialReasoning = String(field(layout === 'pi-ai' ? 'reasoning' : 'reasoningEffort') || '')
  const initialThinking = String(field('thinking') || '')
  const initialModels = cloneModels(
    field('models') ?? snapshot.groups.find((group) => group.id === provider?.provider)?.models
  )
  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [baseURL, setBaseURL] = useState(initialBaseURL)
  const [api, setApi] = useState(initialApi)
  const [reasoning, setReasoning] = useState(initialReasoning)
  const [thinking, setThinking] = useState(initialThinking)
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<DshModelEntry[]>(initialModels)
  const [modelsChanged, setModelsChanged] = useState(false)
  const [modelsReset, setModelsReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [failure, setFailure] = useState('')

  const credentialRef = String(effective.apiKeyEnv || deriveCredentialRef(route || provider?.provider || 'MODEL'))
  const credential = snapshot.credentials[credentialRef]
  const literalKey = literalKeyConfigured(namespace, settingsPath)
  const credentialConfigured = credential?.configured === true || literalKey
  const modelsOverridden = Boolean(provider && hasAt(namespace?.user, [...provider.settingsPath, 'models']))
  const routeValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)
  const routeTaken = custom && snapshot.providers.some((item) => item.provider === route)
  const duplicateModels = models.some((model, index) => (
    !String(model.id || '').trim()
    || models.findIndex((candidate) => String(candidate.id || '').trim() === String(model.id || '').trim()) !== index
  ))
  const canSave = Boolean(namespace && (custom ? routeValid : route.length > 0) && !routeTaken && (modelsReset || !duplicateModels)
    && (layout !== 'pi-ai' || !custom || (baseURL.trim() && api && models.length > 0)))

  const updateModel = (index: number, patch: Partial<DshModelEntry>) => {
    setModelsReset(false)
    setModelsChanged(true)
    setModels((current) => current.map((model, at) => at === index ? { ...model, ...patch } : model))
  }

  const discover = async () => {
    if (!namespace || discovering) return
    setDiscovering(true)
    setFailure('')
    try {
      const response = await discoverDshModelsReq({
        settingsNs: namespace.ns,
        provider: custom ? undefined : provider?.provider,
        baseURL: baseURL.trim() || undefined,
        api: layout === 'pi-ai' ? api : undefined,
        apiKey: keyDraft || undefined,
      })
      const discovered = responseData<{ models?: DshModelEntry[] }>(response)?.models || []
      if (!discovered.length) throw new Error('这个端点没有公布模型，请手动添加')
      const existing = new Set(models.map((model) => model.id))
      setModels((current) => [
        ...current,
        ...discovered.filter((model) => !existing.has(model.id)).map((model) => ({ ...model })),
      ])
      setModelsReset(false)
      setModelsChanged(true)
    } catch (error) {
      setFailure(messageOf(error, 'DSH 模型发现失败'))
    } finally {
      setDiscovering(false)
    }
  }

  const save = async () => {
    if (!namespace || !canSave || busy) return
    setBusy(true)
    setFailure('')
    try {
      const ops: DshSettingsOp[] = []
      if (custom) {
        ops.push({
          op: 'set',
          path: settingsPath,
          value: {
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            apiKeyEnv: credentialRef,
            api,
            baseURL: baseURL.trim(),
            models,
            ...(reasoning ? { reasoning } : {}),
          },
        })
      } else {
        const prefix = settingsPath
        const stringChange = (key: string, value: string, initialValue: string) => {
          if (value === initialValue) return
          if (!value) ops.push({ op: 'unset', path: [...prefix, key] })
          else ops.push({ op: 'set', path: [...prefix, key], value })
        }
        if (layout === 'pi-ai') {
          stringChange('displayName', displayName.trim(), initialDisplayName)
          stringChange('api', api, initialApi)
          stringChange('reasoning', reasoning, initialReasoning)
          if (keyDraft && !effective.apiKeyEnv) {
            ops.push({ op: 'set', path: [...prefix, 'apiKeyEnv'], value: credentialRef })
          }
        } else {
          stringChange('reasoningEffort', reasoning, initialReasoning)
          stringChange('thinking', thinking, initialThinking)
        }
        stringChange('baseURL', baseURL.trim(), initialBaseURL)
        if (modelsReset) ops.push({ op: 'unset', path: [...prefix, 'models'] })
        else if (modelsChanged) ops.push({ op: 'set', path: [...prefix, 'models'], value: models })
      }
      if (ops.length) await mutateDshModelSettingsReq(namespace.ns, ops, namespace.revision)
      if (keyDraft) await setDshModelCredentialReq(credentialRef, keyDraft)
      notifications.show({ color: 'green', message: 'DSH 模型设置已保存，下一次请求直接生效' })
      onClose(true)
    } catch (error) {
      setFailure(messageOf(error, 'DSH 模型设置保存失败'))
    } finally {
      setBusy(false)
    }
  }

  const removeCredential = () => {
    modals.openConfirmModal({
      title: '删除模型密钥',
      children: `删除 ${credentialRef}？依赖这个引用的模型请求会停止工作。`,
      labels: { confirm: '删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        setBusy(true)
        try {
          await unsetDshModelCredentialReq(credentialRef)
          notifications.show({ color: 'green', message: 'DSH 模型密钥已删除' })
          onClose(true)
        } catch (error) {
          setFailure(messageOf(error, 'DSH 模型密钥删除失败'))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  if (!namespace) return <Alert color="red">当前 DSH Profile 没有可写的模型设置空间。</Alert>

  return (
    <div className={styles.editor}>
      {failure && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{failure}</Alert>}
      {custom && (
        <TextInput
          data-testid="dsh-provider-id"
          label="Provider ID"
          description={routeTaken ? '这个 ID 已存在' : '小写字母、数字和连字符，例如 acme-gateway'}
          value={route}
          error={route && (!routeValid || routeTaken) ? 'Provider ID 无效或已存在' : undefined}
          onChange={(event) => setRoute(event.currentTarget.value)}
          disabled={busy || readOnly}
        />
      )}
      <div className={styles.twoColumns}>
        {layout === 'pi-ai' && (
          <TextInput data-testid="dsh-provider-display-name" label="显示名称" value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} disabled={busy || readOnly} />
        )}
        <TextInput
          data-testid="dsh-provider-base-url"
          label="API 地址"
          placeholder={layout === 'deepseek' ? 'https://api.deepseek.com' : 'https://gateway.example/v1'}
          value={baseURL}
          onChange={(event) => setBaseURL(event.currentTarget.value)}
          disabled={busy || readOnly}
        />
        {layout === 'pi-ai' && (
          <Select
            data-testid="dsh-provider-api"
            label="协议"
            data={custom ? PROTOCOLS : [{ value: '', label: '由提供方决定' }, ...PROTOCOLS]}
            value={api}
            onChange={(value) => setApi(value || '')}
            allowDeselect={false}
            disabled={busy || readOnly}
          />
        )}
        <Select
          label="默认推理强度"
          data={[{ value: '', label: '由模型决定' }, ...(layout === 'deepseek' ? DEEPSEEK_REASONING : REASONING)]}
          value={reasoning}
          onChange={(value) => setReasoning(value || '')}
          disabled={busy || readOnly}
        />
        {layout === 'deepseek' && (
          <Select
            label="思考策略"
            data={[{ value: '', label: '由模型决定' }, { value: 'enabled', label: '允许思考' }, { value: 'disabled', label: '关闭思考' }]}
            value={thinking}
            onChange={(value) => {
              const next = value || ''
              setThinking(next)
              if (next === 'disabled') setReasoning('off')
            }}
            disabled={busy || readOnly}
          />
        )}
      </div>

      <div className={styles.credentialBox}>
        <div>
          <strong>API 密钥</strong>
          <span>{credentialConfigured
            ? `已配置，来源：${literalKey ? 'DSH Settings' : credential?.source || 'DSH Credentials'}`
            : `未配置，将写入 ${credentialRef}`}</span>
        </div>
        <PasswordInput
          data-testid="dsh-provider-api-key"
          className={styles.credentialInput}
          value={keyDraft}
          placeholder={credentialConfigured ? '留空保持不变' : '输入密钥'}
          onChange={(event) => setKeyDraft(event.currentTarget.value)}
          disabled={busy || readOnly || credential?.writable === false}
        />
        {credential?.configured && credential.writable && !readOnly && (
          <Button color="red" variant="subtle" onClick={removeCredential} disabled={busy}>删除密钥</Button>
        )}
      </div>

      <section className={styles.modelsEditor}>
        <div className={styles.modelsHeader}>
          <div><strong>模型目录</strong><span>这些模型会进入 DSH 的模型选择器。</span></div>
          <div>
            {!custom && modelsOverridden && (
              <Button variant="subtle" size="xs" onClick={() => {
                setModelsReset(true)
                setModelsChanged(false)
              }} disabled={busy || readOnly}>恢复 DSH 默认目录</Button>
            )}
            <Button variant="default" size="xs" loading={discovering} onClick={() => void discover()} disabled={busy || readOnly}>获取可用模型</Button>
            <Button data-testid="dsh-add-model" size="xs" leftSection={<IconPlus size={13} />} onClick={() => {
              setModelsReset(false)
              setModelsChanged(true)
              setModels((current) => [...current, { id: '', name: '' }])
            }} disabled={busy || readOnly}>添加</Button>
          </div>
        </div>
        {modelsReset ? (
          <div className={styles.emptyModels}>保存后将删除用户覆盖，并恢复 Profile Bundle 或 adapter 的默认模型目录。</div>
        ) : models.length === 0 ? (
          <div className={styles.emptyModels}>还没有模型。可以从端点获取，或手动添加。</div>
        ) : models.map((model, index) => (
          <div className={styles.modelRow} key={`${model.id || 'new'}:${index}`}>
            <TextInput data-testid={`dsh-model-id-${index}`} label="模型 ID" value={model.id || ''} onChange={(event) => updateModel(index, { id: event.currentTarget.value })} disabled={busy || readOnly} />
            <TextInput data-testid={`dsh-model-name-${index}`} label="显示名称" value={model.name || ''} onChange={(event) => updateModel(index, { name: event.currentTarget.value })} disabled={busy || readOnly} />
            <TextInput label="上下文" type="number" value={model.contextWindow || ''} onChange={(event) => updateModel(index, { contextWindow: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} disabled={busy || readOnly} />
            <TextInput label="最大输出" type="number" value={model.maxTokens || ''} onChange={(event) => updateModel(index, { maxTokens: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} disabled={busy || readOnly} />
            <Button color="red" variant="subtle" className={styles.removeModel} onClick={() => {
              setModelsReset(false)
              setModelsChanged(true)
              setModels((current) => current.filter((_item, at) => at !== index))
            }} disabled={busy || readOnly}><IconTrash size={15} /></Button>
          </div>
        ))}
        {!modelsReset && duplicateModels && <span className={styles.validation}>模型 ID 不能为空，也不能重复。</span>}
      </section>

      <div className={styles.editorFooter}>
        <span>保存会带上 DSH revision，外部修改不会被静默覆盖。</span>
        <div>
          <Button variant="default" onClick={() => onClose(false)} disabled={busy}>取消</Button>
          <Button data-testid="dsh-save-provider" onClick={() => void save()} loading={busy} disabled={!canSave || readOnly}>保存到 DSH</Button>
        </div>
      </div>
    </div>
  )
}

export default function Models({ readonly = false, showHeader = true }: ModelsProps) {
  const [snapshot, setSnapshot] = useState<DshModelSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<DshProviderEntry | null>(null)
  const [customOpen, setCustomOpen] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const response = await getDshModelSettingsReq()
      setSnapshot(responseData<DshModelSettingsSnapshot>(response))
    } catch (loadError) {
      setError(messageOf(loadError, 'DSH 模型设置读取失败'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let disposed = false
    let retryTimer: number | null = null
    let controller: AbortController | null = null
    let retryMs = 500

    const connect = () => {
      if (disposed) return
      controller = new AbortController()
      void subscribeDshModelSettingsEvents((event) => {
        if (event.type !== 'dsh_models.changed') return
        retryMs = 500
        void load(true)
      }, controller.signal).catch(() => undefined).finally(() => {
        controller = null
        if (disposed) return
        retryTimer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 5_000)
      })
    }

    connect()
    return () => {
      disposed = true
      controller?.abort()
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [load])

  const rows = useMemo(() => snapshot?.providers.filter((provider) => provider.settingsNs) || [], [snapshot])
  const closeEditor = (changed: boolean) => {
    setSelected(null)
    setCustomOpen(false)
    if (changed) void load(true)
  }

  const removeProvider = (provider: DshProviderEntry) => {
    if (!snapshot) return
    const namespace = providerNamespace(snapshot, provider)
    const removable = Boolean(namespace && provider.settingsPath.length > 0
      && hasAt(namespace.user, provider.settingsPath) && !hasAt(namespace.base, provider.settingsPath))
    if (!namespace || !removable) return
    modals.openConfirmModal({
      title: '删除 DSH 提供方',
      children: `删除 ${provider.displayName || provider.provider} 的用户配置？`,
      labels: { confirm: '删除', cancel: '取消' },
      confirmProps: { color: 'red', 'data-testid': `dsh-confirm-remove-provider-${provider.provider}` },
      onConfirm: async () => {
        try {
          await mutateDshModelSettingsReq(namespace.ns, [{ op: 'unset', path: provider.settingsPath }], namespace.revision)
          notifications.show({ color: 'green', message: 'DSH 提供方配置已删除' })
          await load(true)
        } catch (removeError) {
          notifications.show({ color: 'red', message: messageOf(removeError, '删除失败') })
        }
      },
    })
  }

  if (loading) return <div className={styles.loading}><Loader size="sm" /><span>正在读取 DSH 模型设置…</span></div>

  return (
    <div className={styles.modelManagement} data-testid="dsh-model-settings">
      {showHeader && (
        <header className={styles.pageHeader}>
          <div><h1>模型设置</h1><p>提供方、模型和密钥都由当前 DSH Profile 管理。</p></div>
        </header>
      )}
      <div className={styles.toolbar}>
        <div>
          <strong>DSH 模型提供方</strong>
          <span>{snapshot?.writable ? '修改会写入 DSH Settings，并对下一次请求生效。' : '当前 DSH Settings 只读。'}</span>
        </div>
        <div>
          <Button data-testid="dsh-refresh-models" variant="default" leftSection={<IconRefresh size={15} />} loading={refreshing} onClick={() => void load(true)}>刷新</Button>
          {!readonly && snapshot?.writable && snapshot.namespaces.some((item) => item.ns === 'llm-pi-ai') && (
            <Button data-testid="dsh-add-provider" leftSection={<IconPlus size={15} />} onClick={() => setCustomOpen(true)}>自定义提供方</Button>
          )}
        </div>
      </div>

      {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
      {snapshot?.credential_error && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
          DSH 凭据状态暂时不可用：{snapshot.credential_error}。提供方设置仍可查看。
        </Alert>
      )}
      {snapshot?.failures.map((failure) => (
        <Alert key={failure.id} color="yellow" icon={<IconAlertTriangle size={16} />}>
          {failure.name || failure.id} 的模型目录读取失败：{failure.message}
        </Alert>
      ))}

      <div className={styles.providerList}>
        {rows.map((provider) => {
          const profile = snapshot ? providerProfile(snapshot, provider) : {}
          const configured = snapshot ? providerConfigured(snapshot, provider) : false
          const namespace = snapshot ? providerNamespace(snapshot, provider) : undefined
          const ref = String(profile.apiKeyEnv || deriveCredentialRef(provider.provider))
          const credential = snapshot?.credentials[ref]
          const literalKey = literalKeyConfigured(namespace, provider.settingsPath)
          const group = snapshot?.groups.find((item) => item.id === provider.provider)
          const removable = Boolean(namespace && provider.settingsPath.length > 0
            && hasAt(namespace.user, provider.settingsPath) && !hasAt(namespace.base, provider.settingsPath))
          return (
            <article className={styles.providerRow} key={provider.provider} data-dsh-provider={provider.provider}>
              <div className={styles.providerIcon}><IconRobot size={19} /></div>
              <div className={styles.providerMain}>
                <div className={styles.providerTitle}>
                  <strong>{provider.displayName || provider.provider}</strong>
                  <Badge size="xs" variant="light" color={provider.active ? 'green' : 'gray'}>{provider.active ? '运行中' : '未加载'}</Badge>
                  <Badge size="xs" variant="light">{configured ? '已配置' : '待配置'}</Badge>
                  {(credential?.configured || literalKey) && <Badge size="xs" variant="light" color="blue" leftSection={<IconCheck size={10} />}>密钥已配置</Badge>}
                </div>
                <p>{provider.provider}</p>
                <div className={styles.providerMeta}>
                  <span>{group?.models.length || 0} 个模型</span>
                  <span>{provider.settingsNs}</span>
                  <span>{namespace?.applies === 'restart' ? '重启后生效' : '立即生效'}</span>
                </div>
              </div>
              <div className={styles.providerActions}>
                <Button size="xs" variant="default" onClick={() => setSelected(provider)}>配置</Button>
                {removable && !readonly && <Button data-testid={`dsh-remove-provider-${provider.provider}`} size="xs" color="red" variant="subtle" onClick={() => removeProvider(provider)}>删除</Button>}
              </div>
            </article>
          )
        })}
        {rows.length === 0 && <div className={styles.emptyProviders}>当前 DSH Profile 没有公布可配置的模型提供方。</div>}
      </div>

      <Modal
        opened={Boolean(selected) || customOpen}
        onClose={() => closeEditor(false)}
        title={customOpen ? '添加自定义 DSH 提供方' : `配置 ${selected?.displayName || selected?.provider || ''}`}
        size="xl"
        centered
      >
        {snapshot && (selected || customOpen) && (
          <ProviderEditor
            key={customOpen ? 'custom' : selected?.provider}
            snapshot={snapshot}
            provider={selected}
            custom={customOpen}
            readOnly={readonly || !snapshot.writable}
            onClose={closeEditor}
          />
        )}
      </Modal>
    </div>
  )
}
