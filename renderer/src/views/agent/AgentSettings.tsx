// Agent settings page takes over full screen with its own left nav + main panel, using the same shell theme (--dsh-* tokens).
// "General" settings are fully available: theme/zoom apply immediately.
// Runtime/display/notification/archive/network settings apply through their own flows.
// Other groups are embedded in their management pages. "Back to workspace" uses onBack to return to conversation shell.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconBell,
  IconBook2,
  IconBox,
  IconBrain,
  IconDeviceLaptop,
  IconFolder,
  IconFolderOpen,
  IconHistory,
  IconListCheck,
  IconPalette,
  IconRocket,
  IconRoute,
  IconShieldCheck,
  IconSparkles,
  IconVolume,
  type TablerIcon
} from '@tabler/icons-react'
import ModelsPage from '@/views/models/index'
import PluginCenter from '@/views/plugins/PluginCenter'
import AppSelect from '@/components/AppSelect'
import { useConfigStore } from '@/store/config'
import { useAgentTheme } from './themeContext'
import { SettingsShell, SettingsNavGroup, SettingsNavItem, SettingsNavSep } from './SettingsShell'
import DshOnboarding from './onboarding/DshOnboarding'
import AppInstructions from './AppInstructions'
import GlobalChatMemory from './GlobalChatMemory'
import {
  DshSettingsSection,
  useDshClientHost,
  useHasDshSettingsSection,
  useDshSettingsSections
} from '@/dsh-client/DshClientHost'
import { markAppOnboardingCompleted } from './onboarding/storage'
import { pickFolder } from './folders'
import SkinsManager from './SkinsManager'
import styles from './agentSettings.module.scss'

/* ── Settings persistence: theme via themeContext, zoom applied immediately, and network settings also synced to Electron userData for backend read at main-process startup. ── */
const STORAGE_KEY = 'dsh-settings'

type AgentLanguage = 'zh' | 'en'

interface AgentSettingsData {
  language: AgentLanguage
  zoom: 'small' | 'normal' | 'large'
  inheritProfile: boolean
  terminalFont: string
  httpProxy: string
  noProxy: string
  customCert: string
  netTimeout: '30' | '60' | '120' | '300' | '600'
  taskNotify: boolean
  notifySound: boolean
  interaction: 'steer' | 'queue'
  showThinking: boolean
  showTodo: boolean
  autoArchiveTasks: boolean
  archiveRetention: '7' | '14' | '30' | '90'
  dataRoot: string
  optimizeExperience: boolean
}

type ProxySettings = Pick<AgentSettingsData, 'httpProxy' | 'noProxy' | 'customCert'>
interface WebSearchSettings {
  webSearchApiUrl: string
  webSearchApiKey: string
}
type NetworkSettings = ProxySettings & WebSearchSettings
type NetworkSettingKey = keyof ProxySettings

const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  webSearchApiUrl: '',
  webSearchApiKey: ''
}

const DEFAULTS: AgentSettingsData = {
  language: 'zh',
  zoom: 'normal',
  inheritProfile: true,
  terminalFont: '',
  httpProxy: '',
  noProxy: '',
  customCert: '',
  netTimeout: '60',
  taskNotify: true,
  notifySound: true,
  interaction: 'steer',
  showThinking: true,
  showTodo: true,
  autoArchiveTasks: false,
  archiveRetention: '7',
  dataRoot: '',
  optimizeExperience: false
}

export function loadAgentDisplaySettings(): {
  showThinking: boolean
  showTodo: boolean
  interaction: AgentSettingsData['interaction']
} {
  const s = loadAgentSettings()
  return {
    showThinking: s.showThinking !== false,
    showTodo: s.showTodo !== false,
    interaction: s.interaction === 'queue' ? 'queue' : 'steer'
  }
}

const ZOOM_FACTOR: Record<AgentSettingsData['zoom'], number> = {
  small: 0.9,
  normal: 1,
  large: 1.1
}

export function loadAgentSettings(): AgentSettingsData {
  try {
    return normalizeAgentSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return { ...DEFAULTS }
  }
}

function normalizeLanguage(value: unknown): AgentLanguage {
  return value === 'en' ? 'en' : 'zh'
}

function proxyContainsCredentials(value: unknown): boolean {
  const raw = String(value || '').trim()
  if (!raw) return false
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return Boolean(parsed.username || parsed.password)
  } catch {
    // 无法解析但包含 @ 的旧值也不能继续写入 localStorage。
    return raw.includes('@')
  }
}

function normalizeAgentSettings(raw: unknown): AgentSettingsData {
  const value = raw && typeof raw === 'object' ? (raw as Partial<AgentSettingsData> & Record<string, unknown>) : {}
  const current = { ...value }
  delete current.autoCompact
  const merged = { ...DEFAULTS, ...current }
  return {
    ...merged,
    httpProxy: proxyContainsCredentials(merged.httpProxy) ? '' : String(merged.httpProxy || ''),
    language: normalizeLanguage(current.language),
    zoom: ['small', 'normal', 'large'].includes(String(merged.zoom)) ? merged.zoom : DEFAULTS.zoom,
    interaction: merged.interaction === 'queue' ? 'queue' : 'steer',
    archiveRetention: ['7', '14', '30', '90'].includes(String(merged.archiveRetention))
      ? merged.archiveRetention
      : DEFAULTS.archiveRetention,
    netTimeout: ['30', '60', '120', '300', '600'].includes(String(merged.netTimeout))
      ? merged.netTimeout
      : DEFAULTS.netTimeout
  }
}

function pickNetworkSettings(settings: AgentSettingsData, webSearch: WebSearchSettings): NetworkSettings {
  return {
    httpProxy: settings.httpProxy || '',
    noProxy: settings.noProxy || '',
    customCert: settings.customCert || '',
    ...webSearch
  }
}

function saveDesktopNetworkSettings(settings: AgentSettingsData, webSearch: WebSearchSettings) {
  const api = (window as any).electronAPI
  if (!api?.saveNetworkSettings) return
  api.saveNetworkSettings(pickNetworkSettings(settings, webSearch)).catch((err: any) => {
    console.warn('[AgentSettings] 保存网络设置到主进程失败:', err?.message || err)
  })
}

export function applyAgentZoom(zoom: AgentSettingsData['zoom']) {
  // Zoom only affects .dsh-zoom content; outer .dsh-root padding + title bar stripe stay fixed.
  const el = document.querySelector('.dsh-zoom') as HTMLElement | null
  if (!el) return
  const f = ZOOM_FACTOR[zoom] ?? 1
  // Do not use CSS zoom: it mixes with Electron/Chromium page zoom and can expose background on right/bottom.
  el.style.removeProperty('zoom')
  el.style.setProperty('--dsh-zoom', String(f))
}

export const ZOOM_ORDER: AgentSettingsData['zoom'][] = ['small', 'normal', 'large']

// Global shortcuts: three steps (+1 zoom in / -1 zoom out / 0 reset normal). Persist and apply immediately, then switch to new level.
// Read/write directly to localStorage, sharing the same persistence with settings panel for next open.
export function stepAgentZoom(dir: -1 | 0 | 1): AgentSettingsData['zoom'] {
  const cur = loadAgentSettings()
  const next: AgentSettingsData['zoom'] =
    dir === 0
      ? 'normal'
      : ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, ZOOM_ORDER.indexOf(cur.zoom) + dir))]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, zoom: next }))
  } catch {
    /* ignore */
  }
  applyAgentZoom(next)
  return next
}

/* ── Left navigation groups ── */
interface NavDef {
  key: string
  label: string
  Icon: TablerIcon
  desc?: string
}
const GENERAL_NAV: NavDef[] = [
  { key: 'general', label: '常规', Icon: IconAdjustmentsHorizontal, desc: '聚合入口，集中调整常用设置。' }
]
const GENERAL_GROUP_NAV: NavDef[] = [
  { key: 'display', label: '显示与终端', Icon: IconDeviceLaptop, desc: '语言、缩放和本机终端偏好。' },
  // 皮肤入口在组件中使用 i18n 填入 label/desc。
  { key: 'skins', label: '', Icon: IconPalette, desc: '' },
  { key: 'runtime-network', label: '运行与网络', Icon: IconRoute, desc: '代理、证书、超时和上下文策略。' },
  { key: 'interaction-notify', label: '通知与交互', Icon: IconBell, desc: '桌面通知、提示音、输入处理和过程可见性。' },
  { key: 'tasks-data', label: '任务与数据', Icon: IconArchive, desc: '旧任务归档和本机数据路径偏好。' },
  { key: 'guide-privacy', label: '引导与隐私', Icon: IconShieldCheck, desc: '新手引导和体验优化偏好。' }
]
const MANAGE_NAV: NavDef[] = [
  { key: 'instructions', label: '全局指令', Icon: IconBrain },
  { key: 'memory', label: '记忆', Icon: IconHistory },
  { key: 'models', label: '模型设置', Icon: IconBox },
  { key: 'plugins', label: '插件', Icon: IconSparkles }
]

const DSH_SETTINGS_PREFIX = 'dsh-settings:'

function dshSettingsKey(id: string) {
  return `${DSH_SETTINGS_PREFIX}${id}`
}

function dshSettingsNavId(id: string) {
  return `dsh-settings-nav-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export default function AgentSettings({
  onBack,
  initialActive = 'general'
}: { onBack?: () => void; initialActive?: string }) {
  const { t } = useTranslation()
  const { scheme } = useAgentTheme()
  const dshClientHost = useDshClientHost()
  const hasDshGeneralSection = useHasDshSettingsSection('general')
  const hasDshModelsSection = useHasDshSettingsSection('models')
  const hasDshPluginsSection = useHasDshSettingsSection('plugins')
  const appLanguage = useConfigStore((s) => s.language)
  const setAppLanguage = useConfigStore((s) => s.setLanguage)

  const [active, setActive] = useState(initialActive)
  const [groupsCollapsed, setGroupsCollapsed] = useState(false)
  const [data, setData] = useState<AgentSettingsData>(loadAgentSettings)
  const [webSearch, setWebSearch] = useState<WebSearchSettings>(DEFAULT_WEB_SEARCH_SETTINGS)
  const [defaultDataRoot, setDefaultDataRoot] = useState('')
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const dshSettingsSections = useDshSettingsSections()

  useEffect(() => {
    setActive(initialActive)
  }, [initialActive])

  useEffect(() => {
    setData((prev) => (prev.language === appLanguage ? prev : { ...prev, language: appLanguage }))
  }, [appLanguage])

  useEffect(() => {
    let cancelled = false
    const api = (window as any).electronAPI
    if (api?.loadNetworkSettings) {
      api.loadNetworkSettings()
        .then((settings: Partial<NetworkSettings> | null) => {
          if (cancelled || !settings) return
          setData((prev) => ({
            ...prev,
            httpProxy: String(settings.httpProxy || ''),
            noProxy: String(settings.noProxy || ''),
            customCert: String(settings.customCert || '')
          }))
          setWebSearch({
            webSearchApiUrl: String(settings.webSearchApiUrl || ''),
            webSearchApiKey: String(settings.webSearchApiKey || '')
          })
        })
        .catch((err: any) => console.warn('[AgentSettings] 读取主进程网络设置失败:', err?.message || err))
    }
    if (api?.defaultDataRoot) {
      api.defaultDataRoot()
        .then((root: unknown) => {
          if (!cancelled && typeof root === 'string') setDefaultDataRoot(root)
        })
        .catch((err: any) => console.warn('[AgentSettings] 读取默认数据路径失败:', err?.message || err))
    }
    return () => {
      cancelled = true
    }
  }, [])

  // Persist + apply zoom immediately
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])
  useEffect(() => {
    applyAgentZoom(data.zoom)
  }, [data.zoom])

  const set = <K extends keyof AgentSettingsData>(key: K, value: AgentSettingsData[K]) =>
    setData((d) => ({ ...d, [key]: value }))
  const setLanguage = (value: AgentLanguage) => {
    if (dshClientHost) dshClientHost.setLocale(value)
    else {
      setAppLanguage(value)
      set('language', value)
    }
  }
  const setNetwork = <K extends NetworkSettingKey>(key: K, value: NetworkSettings[K]) => {
    if (key === 'httpProxy' && proxyContainsCredentials(value)) {
      notifications.show({
        color: 'red',
        message: '代理地址不能包含用户名或密码；当前版本不会保存代理凭证'
      })
      return
    }
    const next = { ...data, [key]: value }
    setData(next)
    saveDesktopNetworkSettings(next, webSearch)
  }
  const setWebSearchSetting = <K extends keyof WebSearchSettings>(key: K, value: WebSearchSettings[K]) => {
    const next = { ...webSearch, [key]: value }
    setWebSearch(next)
    saveDesktopNetworkSettings(data, next)
  }

  const generalGroupNav = GENERAL_GROUP_NAV.map((item) => item.key === 'skins'
    ? {
        ...item,
        label: t('agentSkins.settings.navLabel'),
        desc: t('agentSkins.settings.navDesc')
      }
    : item)
  const activeDef = [...GENERAL_NAV, ...generalGroupNav, ...MANAGE_NAV].find((item) => item.key === active)
  const activeDshSection = dshSettingsSections.find((section) => dshSettingsKey(section.id) === active)
  const activeGeneralGroup = generalGroupNav.find((item) => item.key === active)
  const isGeneralOverview = active === 'general'
  // 皮肤页有独立管理 UI，不走通用设置框架。
  const isGeneralPage = (isGeneralOverview || !!activeGeneralGroup) && active !== 'skins'

  const closeOnboarding = () => setOnboardingOpen(false)
  const finishOnboarding = () => {
    markAppOnboardingCompleted()
    setOnboardingOpen(false)
  }
  const chooseDataRoot = async () => pickFolder()
  const closeDshSettingsSection = () => {
    if (onBack) onBack()
    else setActive('general')
  }

  return (
    <SettingsShell
      onBack={onBack}
      nav={
        <>
          {GENERAL_NAV.map(({ key, label, Icon }) => (
            <SettingsNavItem
              key={key}
              active={active === key}
              onClick={() => setActive(key)}
              icon={<Icon size={17} stroke={1.7} />}
            >
              {label}
            </SettingsNavItem>
          ))}

          <SettingsNavGroup
            label="常规分组"
            collapsed={groupsCollapsed}
            onToggle={() => setGroupsCollapsed((v) => !v)}
          >
            {generalGroupNav.map(({ key, label, Icon }) => (
              <SettingsNavItem
                key={key}
                active={active === key}
                onClick={() => setActive(key)}
                icon={<Icon size={17} stroke={1.7} />}
              >
                {label}
              </SettingsNavItem>
            ))}
          </SettingsNavGroup>

          <SettingsNavSep />

          {MANAGE_NAV.map(({ key, label, Icon }) => (
            <SettingsNavItem
              key={key}
              active={active === key}
              onClick={() => setActive(key)}
              icon={<Icon size={17} stroke={1.7} />}
            >
              {label}
            </SettingsNavItem>
          ))}

          {dshSettingsSections.length > 0 && (
            <>
              <SettingsNavSep />
              <SettingsNavGroup label="DSH 扩展" sourceLabel="当前 Profile">
                {dshSettingsSections.map((section) => (
                  <SettingsNavItem
                    key={section.id}
                    id={dshSettingsNavId(section.id)}
                    active={active === dshSettingsKey(section.id)}
                    onClick={() => setActive(dshSettingsKey(section.id))}
                    icon={<IconSparkles size={17} stroke={1.7} />}
                    pluginName={section.registrant}
                    nested
                  >
                    {section.label}
                  </SettingsNavItem>
                ))}
              </SettingsNavGroup>
            </>
          )}

          <SettingsNavSep />

          <button
            type="button"
            className={`${styles.bootBtn} ${onboardingOpen ? styles.bootBtnActive : ''}`}
            onClick={() => setOnboardingOpen(true)}
          >
            <IconRocket size={17} stroke={1.7} />
            <span>引导</span>
          </button>
        </>
      }
    >
      <div className={`${styles.mainInner} ${active === 'plugins' || activeDshSection ? styles.mainInnerFixed : ''}`}>
          {isGeneralPage ? (
            <>
              <h1 className={styles.pageTitle}>{isGeneralOverview ? '常规' : activeGeneralGroup?.label}</h1>
              {isGeneralOverview ? (
                <div className={styles.badges}>
                  <span className={styles.badge}>{scheme === 'dark' ? '深色' : '浅色'}</span>
                  <span className={styles.badge}>{data.language === 'zh' ? '简体中文' : 'English'}</span>
                </div>
              ) : (
                <p className={styles.pageLead}>{activeGeneralGroup?.desc}</p>
              )}

              {(isGeneralOverview || active === 'display') && (
              <SettingsSection title="显示" desc="控制显示语言和窗口内容比例；外观模式在主题页统一设置。">
                <Row label="界面语言" desc="选择应用 UI 的显示语言。">
                  <AppSelect
                    value={data.language}
                    onChange={setLanguage}
                    options={[
                      { value: 'zh', label: '简体中文' },
                      { value: 'en', label: 'English' }
                    ]}
                  />
                </Row>
                <Row label="界面缩放" desc="调整当前窗口中文本和控件的整体显示大小。">
                  <Segmented
                    value={data.zoom}
                    onChange={(v) => set('zoom', v)}
                    options={[
                      { value: 'small', label: '偏小' },
                      { value: 'normal', label: '正常' },
                      { value: 'large', label: '偏大' }
                    ]}
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'display') && (
              <SettingsSection title="终端" desc="保存本机终端偏好，后续内置终端接入后直接消费。">
                <Row
                  label="继承系统终端 Profile"
                  desc="保存为本机偏好；内置终端接入后会用于继承登录 shell 环境、代理和 Kube 变量。"
                >
                  <Toggle value={data.inheritProfile} onChange={(v) => set('inheritProfile', v)} />
                </Row>
                <TextRow
                  label="终端字体"
                  desc="保存为本机偏好；内置终端接入后会作为字体覆盖。留空表示使用默认等宽字体。"
                  placeholder="留空自动继承,例如 MesloLGS NF, monospace"
                  value={data.terminalFont}
                  onSave={(v) => set('terminalFont', v)}
                />
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'runtime-network') && (
              <SettingsSection title="网络" desc="配置模型、检索、MCP 和命令工具的网络出口。">
                <TextRow
                  label="HTTP 代理"
                  desc="模型、Embedding、Web 搜索、MCP 与命令工具的出口流量将经此代理；留空时直连。当前版本不接受带用户名或密码的代理地址。保存后渲染层立即生效，后端请求需重启应用。"
                  placeholder="留空直连,例如 http://127.0.0.1:7890"
                  value={data.httpProxy}
                  onSave={(v) => setNetwork('httpProxy', v)}
                />
                <TextRow
                  label="不走代理"
                  desc="匹配这些主机的请求将直连,不经过 HTTP 代理。localhost、127.0.0.1 和 ::1 会自动加入。保存后后端请求需重启应用。"
                  placeholder="例如 localhost,127.0.0.1,::1,.example.com,*.corp.com"
                  value={data.noProxy}
                  onSave={(v) => setNetwork('noProxy', v)}
                />
                <TextRow
                  label="自定义证书"
                  desc="可选。填写 PEM 根证书路径后,会作为 NODE_EXTRA_CA_CERTS 注入后端、MCP 与命令工具。修改后需重启应用。"
                  placeholder="例如 /Users/name/certs/root-ca.pem"
                  value={data.customCert}
                  onSave={(v) => setNetwork('customCert', v)}
                />
                <Row label="网络超时" desc="模型请求的最长等待时间;超时即中断本次请求并报错(下次对话生效)。">
                  <AppSelect
                    value={data.netTimeout}
                    onChange={(v) => set('netTimeout', v)}
                    options={[
                      { value: '30', label: '30 秒' },
                      { value: '60', label: '60 秒' },
                      { value: '120', label: '2 分钟' },
                      { value: '300', label: '5 分钟' },
                      { value: '600', label: '10 分钟' }
                    ]}
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'runtime-network') && (
              <SettingsSection title="联网搜索" desc="普通用户无需配置；留空时直接使用内置搜索。只有接入自建搜索服务时才需要填写。">
                <TextRow
                  label="搜索 API URL"
                  desc="可选。填写后将改用这个通用搜索接口；保存后需重启应用。"
                  placeholder="留空使用内置搜索，例如 https://search.example.com/v1/search"
                  value={webSearch.webSearchApiUrl}
                  onSave={(value) => setWebSearchSetting('webSearchApiUrl', value)}
                />
                <TextRow
                  label="API Key"
                  desc="可选。请求时通过 Bearer Token 发送，只保存在本机设置文件中。"
                  placeholder="粘贴搜索 API Key"
                  value={webSearch.webSearchApiKey}
                  secret
                  onSave={(value) => setWebSearchSetting('webSearchApiKey', value)}
                />
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'interaction-notify') && (
              <SettingsSection title="通知" desc="任务完成、失败或需要确认时，给出清晰但不打扰的提醒。">
                <Row icon={<IconBell size={17} stroke={1.75} />} label="任务通知" desc="任务完成、失败或需要确认时发送桌面通知。">
                  <Toggle value={data.taskNotify} onChange={(v) => set('taskNotify', v)} ariaLabel="任务通知" />
                </Row>
                <Row
                  icon={<IconVolume size={17} stroke={1.75} />}
                  label="通知声音"
                  desc="通知开启后，可以单独关闭任务通知提示音。"
                  disabled={!data.taskNotify}
                >
                  <Toggle
                    value={data.notifySound}
                    onChange={(v) => set('notifySound', v)}
                    disabled={!data.taskNotify}
                    ariaLabel="通知声音"
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'interaction-notify') && (
              <SettingsSection title="交互与可见性" desc="控制任务运行时的输入处理方式，以及过程信息的展示密度。">
                <Row icon={<IconRoute size={17} stroke={1.75} />} label="运行中继续输入" desc="直接补充到当前任务，或按当前会话排队，等任务完成后再开始下一轮。排队内容由当前 DSH 会话保存。">
                  <AppSelect
                    value={data.interaction}
                    onChange={(v) => set('interaction', v)}
                    options={[
                      { value: 'steer', label: '补充到当前任务' },
                      { value: 'queue', label: '加入下一轮' }
                    ]}
                  />
                </Row>
                <Row icon={<IconBrain size={17} stroke={1.75} />} label="显示思考摘要" desc="在消息流中展示 Runtime 返回的思考摘要；只控制界面显示，不影响模型推理和用量。">
                  <Toggle value={data.showThinking} onChange={(v) => set('showThinking', v)} ariaLabel="显示思考摘要" />
                </Row>
                <Row icon={<IconListCheck size={17} stroke={1.75} />} label="显示待办" desc="在过程摘要中显示计划进度，并在任务执行时显示独立计划浮窗；简单任务没有计划时不会显示。">
                  <Toggle value={data.showTodo} onChange={(v) => set('showTodo', v)} ariaLabel="显示待办" />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'tasks-data') && (
              <SettingsSection title="任务整理" desc="把旧任务收起到更安静的位置，保持项目列表可扫描。">
                <Row icon={<IconArchive size={17} stroke={1.75} />} label="自动归档旧任务" desc="应用启动后每天最多扫描一次最近打开过的项目，将超过保留期、未置顶且当前未运行的对话移入归档区。">
                  <Toggle value={data.autoArchiveTasks} onChange={(v) => set('autoArchiveTasks', v)} ariaLabel="自动归档旧任务" />
                </Row>
                <Row
                  icon={<IconArchive size={17} stroke={1.75} />}
                  label="归档保留时长"
                  desc="对话最后更新时间早于该时长后，才会被自动归档。"
                  disabled={!data.autoArchiveTasks}
                >
                  <AppSelect
                    value={data.archiveRetention}
                    onChange={(v) => set('archiveRetention', v)}
                    disabled={!data.autoArchiveTasks}
                    options={[
                      { value: '7', label: '7 天后归档' },
                      { value: '14', label: '14 天后归档' },
                      { value: '30', label: '30 天后归档' },
                      { value: '90', label: '90 天后归档' }
                    ]}
                  />
                </Row>
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'tasks-data') && (
              <SettingsSection title="本机数据" desc="本地优先保存数据和运行痕迹，路径设置先作为本机偏好保留。">
                <PathRow
                  label="数据存储路径"
                  desc="应用数据的默认根目录；包含本地数据库、附件和运行记录，不包含项目关联的本地文件夹。当前仅展示并保存偏好，迁移执行另接任务。"
                  value={data.dataRoot || defaultDataRoot}
                  placeholder="读取默认路径中..."
                  onSave={(v) => set('dataRoot', v)}
                  onChoose={chooseDataRoot}
                />
              </SettingsSection>
              )}

              {(isGeneralOverview || active === 'guide-privacy') && (
              <SettingsSection title="引导与隐私" desc="重新查看初始化流程，或者调整体验优化偏好。">
                <ActionRow
                  icon={<IconBook2 size={17} stroke={1.75} />}
                  label="新手引导"
                  desc="重新打开 dsh-work 初始引导，查看模型、项目、文件、联网和指令设置。"
                >
                  <button type="button" className={styles.actionBtn} onClick={() => setOnboardingOpen(true)}>
                    打开引导
                  </button>
                </ActionRow>
                <Row icon={<IconShieldCheck size={17} stroke={1.75} />} label="优化体验" desc="当前仅保存本机偏好；后续接入诊断或体验优化链路时，会按这个开关执行。">
                  <Toggle
                    value={data.optimizeExperience}
                    onChange={(v) => set('optimizeExperience', v)}
                    ariaLabel="优化体验"
                  />
                </Row>
              </SettingsSection>
              )}
              {isGeneralOverview && hasDshGeneralSection && (
                <EmbedBoundary>
                  <DshSettingsSection id="general" onClose={closeDshSettingsSection} />
                </EmbedBoundary>
              )}
            </>
          ) : active === 'skins' ? (
            <>
              <h1 className={styles.pageTitle}>{t('agentSkins.settings.pageTitle')}</h1>
              <p className={styles.pageLead}>{t('agentSkins.settings.pageLead')}</p>
              <SkinsManager />
            </>
          ) : active === 'instructions' ? (
            <AppInstructions />
          ) : active === 'memory' ? (
            <GlobalChatMemory />
          ) : active === 'models' ? (
            <>
              <h1 className={styles.pageTitle}>模型设置</h1>
              <div className={styles.embed}>
                <EmbedBoundary>
                  {hasDshModelsSection
                    ? <DshSettingsSection id="models" onClose={closeDshSettingsSection} />
                    : <ModelsPage readonly={false} showHeader={false} />}
                </EmbedBoundary>
              </div>
            </>
          ) : active === 'plugins' ? (
            <div className={`${styles.embed} ${styles.embedFixed}`}>
              <EmbedBoundary>
                <PluginCenter />
                {hasDshPluginsSection && (
                  <DshSettingsSection id="plugins" onClose={closeDshSettingsSection} />
                )}
              </EmbedBoundary>
            </div>
          ) : activeDshSection ? (
            <EmbedBoundary>
              <DshSettingsSection id={activeDshSection.id} onClose={closeDshSettingsSection} />
            </EmbedBoundary>
          ) : (
            <Placeholder title={activeDef?.label || ''} Icon={activeDef?.Icon || IconRocket} />
          )}
      </div>
      {onboardingOpen && (
        <DshOnboarding
          mode="dialog"
          onClose={closeOnboarding}
          onFinish={finishOnboarding}
          onOpenModels={() => {
            markAppOnboardingCompleted()
            setOnboardingOpen(false)
            setActive('models')
          }}
        />
      )}
    </SettingsShell>
  )
}

function SettingsSection({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>{title}</h2>
          <p className={styles.sectionDesc}>{desc}</p>
        </div>
      </div>
      <div className={styles.group}>{children}</div>
    </section>
  )
}

/* ── Row: left label/description + right control ── */
function Row({
  label,
  desc,
  children,
  icon,
  disabled = false
}: {
  label: string
  desc: string
  children: ReactNode
  icon?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className={`${styles.row} ${disabled ? styles.rowDisabled : ''}`}>
      {icon && <div className={styles.rowIcon}>{icon}</div>}
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDesc}>{desc}</div>
      </div>
      <div className={styles.rowCtrl}>{children}</div>
    </div>
  )
}

function ActionRow({
  label,
  desc,
  children,
  icon
}: {
  label: string
  desc: string
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className={styles.row}>
      {icon && <div className={styles.rowIcon}>{icon}</div>}
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDesc}>{desc}</div>
      </div>
      <div className={styles.rowCtrl}>{children}</div>
    </div>
  )
}

/* ── Text input row with "Save" ── */
function TextRow({
  label,
  desc,
  placeholder,
  value,
  onSave,
  secret = false
}: {
  label: string
  desc: string
  placeholder?: string
  value: string
  onSave: (v: string) => void
  secret?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const dirty = draft !== value

  useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <div className={`${styles.row} ${styles.rowStacked}`}>
      <div className={styles.rowText}>
        <div className={styles.rowHeadLine}>
          <div className={styles.rowLabel}>{label}</div>
          <button
            type="button"
            className={styles.saveBtn}
            disabled={!dirty}
            onClick={() => onSave(draft.trim())}
          >
            保存
          </button>
        </div>
        <div className={styles.rowDesc}>{desc}</div>
        <input
          className={styles.textInput}
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          spellCheck={false}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) onSave(draft.trim())
          }}
        />
      </div>
    </div>
  )
}

function PathRow({
  label,
  desc,
  placeholder,
  value,
  onSave,
  onChoose
}: {
  label: string
  desc: string
  placeholder?: string
  value: string
  onSave: (v: string) => void
  onChoose: () => Promise<string | null>
}) {
  const [draft, setDraft] = useState(value)
  const dirty = draft.trim() !== value

  useEffect(() => {
    setDraft(value)
  }, [value])

  const save = () => onSave(draft.trim())
  const choose = async () => {
    const picked = await onChoose()
    if (!picked) return
    setDraft(picked)
    onSave(picked)
  }

  return (
    <div className={`${styles.row} ${styles.pathRow}`}>
      <div className={styles.rowIcon}>
        <IconFolder size={17} stroke={1.75} />
      </div>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        <div className={styles.rowDesc}>{desc}</div>
        <div className={styles.pathEdit}>
          <input
            className={styles.pathInput}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirty) save()
            }}
          />
          <button type="button" className={styles.iconBtn} onClick={choose} aria-label="选择文件夹">
            <IconFolderOpen size={16} stroke={1.8} />
          </button>
          <button type="button" className={styles.saveBtn} disabled={!dirty} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Segmented select ── */
function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className={styles.seg} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`${styles.segBtn} ${value === o.value ? styles.segBtnActive : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── Switch ── */
function Toggle({
  value,
  onChange,
  disabled = false,
  ariaLabel
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${styles.toggle} ${value ? styles.toggleOn : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

/* ── Error boundary: fallback if embedded query page crashes, without breaking settings shell ── */
class EmbedBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: unknown) {
    console.error('[AgentSettings] 内嵌页渲染失败:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className={styles.placeholder}>
          <div className={styles.placeholderText}>该模块加载失败</div>
          <div className={styles.placeholderSub}>{this.state.error.message}</div>
        </div>
      )
    }
    return this.props.children
  }
}

/* ── Placeholder skeleton (feature not wired yet) ── */
function Placeholder({ title, Icon }: { title: string; Icon: TablerIcon }) {
  return (
    <>
      <h1 className={styles.pageTitle}>{title}</h1>
      <div className={styles.placeholder}>
        <Icon size={40} stroke={1.3} />
        <div className={styles.placeholderText}>「{title}」模块即将上线</div>
        <div className={styles.placeholderSub}>该分组的设置项正在接入中。</div>
      </div>
    </>
  )
}
