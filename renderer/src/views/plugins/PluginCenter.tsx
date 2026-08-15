import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Loader, Modal, TextInput, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import {
  IconBox,
  IconInfoCircle,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash
} from '@tabler/icons-react'

import {
  getPluginDetailReq,
  installProfileBundleReq,
  listPluginCatalogReq,
  preflightProfileBundleReq,
  uninstallProfileBundleReq
} from '@/api/plugins'
import { subscribeProfileCatalogChanged } from '@/store/profileCatalogEvents'
import styles from './PluginCenter.module.scss'

interface ProfileBundle {
  id: string
  name: string
  display_name?: string
  description?: string
  long_description?: string
  version?: string | null
  profile_order?: number
  profile_name?: string
  managed_by?: 'system' | 'app' | 'user'
  source?: string
  source_details?: {
    label?: string
    package?: string
    version?: string
    spec?: string
    path?: string
  }
  can_uninstall?: boolean
  enabled?: boolean
  blocked_reason?: string | null
  product_plugin?: boolean
  ui_runtime?: {
    kind?: 'dsh_client' | 'dsh_work_descriptor' | 'host_only'
    declares_client?: boolean
    client_graph?: boolean
    isolation?: 'trusted' | 'quarantined' | 'not_required'
    host_supported_slots?: string[]
    host_unmapped_slots?: string[]
  }
  capabilities?: string[]
}

interface PluginCenterProps {
  surface?: 'directory' | 'settings'
  onOpenSettings?: () => void
}

interface ProfileBundlePreflight {
  source: string
  status: 'ready' | 'migration_required' | 'build_approval_required' | 'sdk_unavailable' | 'invalid_source' | 'already_installed' | 'unavailable'
  installable: boolean
  package_name: string | null
  version: string | null
  surface?: 'dsh_work' | 'dsh_web' | 'host'
  blockers: Array<{ code: string; message: string }>
}

function preflightTitle(status: ProfileBundlePreflight['status']) {
  if (status === 'ready') return '可以安装'
  if (status === 'migration_required') return '需要迁移为当前 Profile Bundle'
  if (status === 'build_approval_required') return '需要安装时构建权限'
  if (status === 'sdk_unavailable') return '依赖的 DSH SDK 当前不可用'
  if (status === 'already_installed') return '已经安装'
  if (status === 'invalid_source') return '来源格式不正确'
  return '当前无法完成检查'
}

function preflightColor(status: ProfileBundlePreflight['status']) {
  if (status === 'ready') return 'green'
  if (status === 'build_approval_required' || status === 'migration_required' || status === 'sdk_unavailable') return 'yellow'
  return 'red'
}

function bundleInitial(bundle: ProfileBundle) {
  const label = String(bundle.display_name || bundle.name || 'B').trim()
  return Array.from(label)[0]?.toLocaleUpperCase() || 'B'
}

function managedLabel(value: ProfileBundle['managed_by']) {
  if (value === 'system') return 'DSH 内置'
  if (value === 'app') return 'DeepSeek Harness Desktop App 提供'
  return '用户安装'
}

function sourceLabel(bundle: ProfileBundle) {
  const source = bundle.source_details || {}
  if (source.label) return source.label
  if (source.package) return [source.package, source.version].filter(Boolean).join('@')
  if (source.spec) return source.spec
  if (source.path) return source.path
  return bundle.source || 'DSH Profile'
}

export default function PluginCenter({
  surface = 'settings',
  onOpenSettings
}: PluginCenterProps) {
  const directorySurface = surface === 'directory'
  const [bundles, setBundles] = useState<ProfileBundle[]>([])
  const [profileName, setProfileName] = useState('web')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [installOpen, setInstallOpen] = useState(false)
  const [installSource, setInstallSource] = useState('')
  const [preflight, setPreflight] = useState<ProfileBundlePreflight | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [detail, setDetail] = useState<ProfileBundle | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyId, setBusyId] = useState('')

  const loadCatalog = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const response: any = await listPluginCatalogReq(true)
      const catalog = response?.data || {}
      const next = Array.isArray(catalog.plugins) ? catalog.plugins : []
      setBundles(next)
      setProfileName(String(catalog.marketplaces?.[0]?.name || 'web'))
    } catch (loadError: any) {
      setError(loadError?.message || loadError?.msg || 'DSH Profile 读取失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadCatalog()
    return subscribeProfileCatalogChanged(() => { void loadCatalog(true) })
  }, [loadCatalog])

  const visibleBundles = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return bundles
    return bundles.filter((bundle) => (
      `${bundle.name} ${bundle.display_name || ''} ${bundle.description || ''}`.toLowerCase().includes(keyword)
    ))
  }, [bundles, query])

  const install = async () => {
    const source = installSource.trim()
    if (!source || installing || !preflight?.installable || preflight.source !== source) return
    setInstalling(true)
    try {
      const response: any = await installProfileBundleReq(source)
      notifications.show({
        color: 'green',
        message: response?.message || 'Profile Bundle 已安装，DSH 运行时已重启'
      })
      setInstallOpen(false)
      setInstallSource('')
      setPreflight(null)
      await loadCatalog(true)
    } catch (installError: any) {
      notifications.show({
        color: 'red',
        title: '安装失败',
        message: installError?.message || installError?.msg || '候选 Profile 校验未通过'
      })
    } finally {
      setInstalling(false)
    }
  }

  const checkCompatibility = async () => {
    const source = installSource.trim()
    if (!source || checking || installing) return
    setChecking(true)
    setPreflight(null)
    try {
      const response: any = await preflightProfileBundleReq(source)
      setPreflight(response?.data || null)
    } catch (checkError: any) {
      notifications.show({
        color: 'red',
        title: '检查失败',
        message: checkError?.response?.data?.message || checkError?.message || checkError?.msg || '无法检查候选插件'
      })
    } finally {
      setChecking(false)
    }
  }

  const openDetail = async (bundle: ProfileBundle) => {
    setDetail(bundle)
    setDetailLoading(true)
    try {
      const response: any = await getPluginDetailReq(bundle.id)
      setDetail(response?.data?.plugin || bundle)
    } catch (detailError: any) {
      notifications.show({ color: 'red', message: detailError?.message || 'Bundle 详情读取失败' })
    } finally {
      setDetailLoading(false)
    }
  }

  const uninstall = (bundle: ProfileBundle) => {
    if (!bundle.can_uninstall || busyId) return
    modals.openConfirmModal({
      title: '卸载 Profile Bundle',
      children: `从 ${profileName} Profile 移除「${bundle.display_name || bundle.name}」？DSH 运行时会重启。`,
      labels: { confirm: '卸载', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        setBusyId(bundle.id)
        try {
          const response: any = await uninstallProfileBundleReq(bundle.id)
          notifications.show({ color: 'green', message: response?.message || 'Profile Bundle 已卸载' })
          if (detail?.id === bundle.id) setDetail(null)
          await loadCatalog(true)
        } catch (uninstallError: any) {
          notifications.show({ color: 'red', message: uninstallError?.message || '卸载失败' })
        } finally {
          setBusyId('')
        }
      }
    })
  }

  return (
    <div className={`${styles.pluginCenter} ${directorySurface ? styles.directorySurface : ''}`}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          <h1>DSH Profile Bundle</h1>
          <p>当前运行层来自 {profileName} Profile。Bundle 按这里显示的顺序组成 DSH 运行环境。</p>
        </div>
        <div className={styles.headerActions}>
          {directorySurface && onOpenSettings && (
            <Tooltip label="打开设置">
              <Button variant="default" leftSection={<IconSettings size={15} />} onClick={onOpenSettings}>
                设置
              </Button>
            </Tooltip>
          )}
          <Button variant="default" leftSection={<IconRefresh size={15} />} loading={refreshing} onClick={() => void loadCatalog(true)}>
            刷新
          </Button>
          <Button leftSection={<IconPlus size={15} />} onClick={() => setInstallOpen(true)}>
            安装 Bundle
          </Button>
        </div>
      </header>

      <div className={`${styles.toolbar} ${directorySurface ? styles.directoryToolbar : ''}`}>
        <TextInput
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索 Profile Bundle"
        />
        <span className={styles.directoryResultCount}>{visibleBundles.length} 个运行层</span>
      </div>

      {error && (
        <Alert color="red" icon={<IconInfoCircle size={16} />} title="Profile 不可用">
          <div className={styles.inlineErrorAction}>
            <span>{error}</span>
            <Button size="xs" variant="light" onClick={() => void loadCatalog()}>重试</Button>
          </div>
        </Alert>
      )}

      <div className={`${styles.list} ${directorySurface ? styles.directoryList : ''}`}>
        {loading ? (
          <div className={styles.emptyState}><Loader size="sm" /><span>正在读取 DSH Profile…</span></div>
        ) : visibleBundles.length === 0 ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyGlyph}><IconBox size={20} /></span>
            <strong>{query ? '没有匹配的 Bundle' : '当前 Profile 没有 Bundle'}</strong>
            <span>安装时必须提供精确版本或 dsh-external 的完整 commit。</span>
          </div>
        ) : visibleBundles.map((bundle) => (
          <div
            key={bundle.id}
            className={`${styles.itemRow} ${directorySurface ? styles.directoryItemRow : ''}`}
            data-profile-bundle={bundle.id}
          >
            <div className={styles.itemIcon}><span className={styles.pluginInitial}>{bundleInitial(bundle)}</span></div>
            <div className={styles.itemMain}>
              <div className={styles.itemTitleLine}>
                <strong>{bundle.display_name || bundle.name}</strong>
                <Badge size="xs" variant="light">{managedLabel(bundle.managed_by)}</Badge>
                {bundle.product_plugin && <Badge size="xs" color="violet" variant="light">产品扩展</Badge>}
                {bundle.ui_runtime?.client_graph && <Badge size="xs" color="blue" variant="light">DSH Client</Badge>}
                {bundle.ui_runtime?.isolation === 'quarantined' && <Badge size="xs" color="yellow" variant="light">已隔离</Badge>}
              </div>
              <p>{bundle.description || 'DSH Profile Bundle'}</p>
              {bundle.blocked_reason && <p data-profile-bundle-blocked>{bundle.blocked_reason}</p>}
              <div className={styles.itemMeta}>
                <span>{bundle.enabled === false ? '未加载' : `顺序 ${Number(bundle.profile_order || 0) + 1}`}</span>
                <span>{bundle.version ? `v${bundle.version}` : '未声明版本'}</span>
                <span>{sourceLabel(bundle)}</span>
              </div>
            </div>
            <div className={styles.itemActions}>
              <Button size="xs" variant="subtle" onClick={() => void openDetail(bundle)}>详情</Button>
              {bundle.can_uninstall && (
                <Tooltip label="从当前 Profile 卸载">
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    loading={busyId === bundle.id}
                    leftSection={<IconTrash size={14} />}
                    onClick={() => uninstall(bundle)}
                  >
                    卸载
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        ))}
      </div>

      <Modal
        opened={installOpen}
        onClose={() => {
          if (installing || checking) return
          setInstallOpen(false)
          setPreflight(null)
        }}
        title="安装 DSH Profile Bundle"
        centered
      >
        <div className={styles.marketplaceForm}>
          <Alert color="blue" icon={<IconInfoCircle size={16} />}>
            社区插件会先在隔离的候选 Profile 中检查。只接受固定 npm 版本或 dsh-external 的完整 commit，不接受 latest 和分支名。
          </Alert>
          <TextInput
            label="固定来源"
            placeholder="github:dsh-external/DSH-better-sidebar#40位commit"
            value={installSource}
            onChange={(event) => {
              setInstallSource(event.currentTarget.value)
              setPreflight(null)
            }}
            disabled={installing || checking}
          />
          {preflight && (
            <Alert color={preflightColor(preflight.status)} title={preflightTitle(preflight.status)}>
              <div className={styles.preflightResult} data-profile-preflight={preflight.status}>
                {preflight.package_name && (
                  <strong>{preflight.package_name}{preflight.version ? ` v${preflight.version}` : ''}</strong>
                )}
                {preflight.blockers.length > 0 && (
                  <ul>
                    {preflight.blockers.map((blocker) => (
                      <li key={`${blocker.code}:${blocker.message}`}>{blocker.message}</li>
                    ))}
                  </ul>
                )}
                {preflight.status === 'build_approval_required' && (
                  <span>DeepSeek Harness Desktop App 不会自动放开社区仓库的主机代码执行权限。插件作者应提交已构建产物，或先完成单独安全审查。</span>
                )}
                {preflight.status === 'migration_required' && (
                  <span>需要补齐 dsh.bundle.patch、当前 dsh.client / ./client 清单和正式 SDK 版本后再安装。</span>
                )}
                {preflight.status === 'sdk_unavailable' && (
                  <span>请确认公开 npm registry 可读取插件声明的 SDK 版本；DeepSeek Harness Desktop App 不会改为链接 DSH 源码。</span>
                )}
                {preflight.status === 'ready' && preflight.surface === 'dsh_web' && (
                  <span>这个 Bundle 会进入当前主窗口的 DSH Client 图。设置页、全局浮层和侧栏底部加法位置使用标准 Slot；整列侧栏、会话和详情仍需按插件实际贡献检查。</span>
                )}
              </div>
            </Alert>
          )}
          <div className={styles.installActions}>
            <Button
              variant="default"
              loading={checking}
              disabled={!installSource.trim() || installing}
              onClick={() => void checkCompatibility()}
            >
              检查兼容性
            </Button>
            <Button
              loading={installing}
              disabled={!preflight?.installable || preflight.source !== installSource.trim() || checking}
              onClick={() => void install()}
            >
              安装到当前 Profile
            </Button>
          </div>
        </div>
      </Modal>

      <Modal opened={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.display_name || detail?.name || 'Bundle 详情'} centered>
        {detailLoading || !detail ? (
          <div className={styles.detailLoading}><Loader size="sm" /></div>
        ) : (
          <div className={styles.pluginDetail}>
            <div className={styles.detailSummary}>
              <p>{detail.long_description || detail.description || 'DSH Profile Bundle'}</p>
              <div className={styles.detailBadges}>
                <Badge variant="light">{managedLabel(detail.managed_by)}</Badge>
                <Badge variant="light">{detail.profile_name || profileName}</Badge>
                {detail.version && <Badge variant="light">v{detail.version}</Badge>}
              </div>
            </div>
            <div className={styles.detailGrid}>
              <div><span>包名</span><strong>{detail.name}</strong></div>
              <div><span>加载顺序</span><strong>{detail.enabled === false ? '未加载' : Number(detail.profile_order || 0) + 1}</strong></div>
              <div><span>来源</span><strong>{sourceLabel(detail)}</strong></div>
              <div><span>卸载权限</span><strong>{detail.can_uninstall ? '可以卸载' : '由系统管理'}</strong></div>
            </div>
            {Array.isArray(detail.capabilities) && detail.capabilities.length > 0 && (
              <div className={styles.detailSection}>
                <h3>产品能力</h3>
                <p>{detail.capabilities.join('、')}</p>
              </div>
            )}
            {(detail.ui_runtime?.declares_client || detail.ui_runtime?.client_graph) && (
              <div className={styles.detailSection} data-dsh-client-surface-status>
                <h3>浏览器表层</h3>
                {detail.ui_runtime.isolation === 'quarantined' ? (
                  <p>{detail.blocked_reason || '这个社区 Client Bundle 已从主窗口运行图隔离。'}</p>
                ) : (
                  <>
                    <p>已进入当前主窗口的 DSH Client 图。</p>
                    <p>主窗口已支持：{detail.ui_runtime.host_supported_slots?.join('、') || '无'}</p>
                    <p>主窗口尚未映射：{detail.ui_runtime.host_unmapped_slots?.join('、') || '无'}</p>
                    <p>这里说明宿主能力，不代表这个插件实际注册了这些位置。</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
