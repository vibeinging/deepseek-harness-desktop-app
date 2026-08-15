import { useEffect, useState, type ReactNode } from 'react'
import {
  IconArrowLeft,
  IconArrowRight,
  IconBrain,
  IconCheck,
  IconFile,
  IconFolder,
  IconMessage,
  IconPhoto,
  IconSettings,
  IconWorldSearch,
  IconX
} from '@tabler/icons-react'
import {
  getDshModelSettingsReq,
  subscribeDshModelSettingsEvents,
  type DshModelSettingsSnapshot
} from '@/api/dsh-models'
import styles from './DshOnboarding.module.scss'

interface DshOnboardingProps {
  mode?: 'dialog'
  onClose?: (meta?: { requiredModelsReady: boolean }) => void
  onFinish?: (meta?: { requiredModelsReady: boolean }) => void
  onOpenModels?: () => void
}

const STEPS = [
  {
    id: 'welcome',
    label: '欢迎',
    title: '欢迎使用 DeepSeek Harness Desktop App',
    summary: '在本机聊天、处理文件、查看图片，并在需要时联网核对信息。'
  },
  {
    id: 'model',
    label: '模型',
    title: '先配置一个主模型',
    summary: 'DeepSeek Harness Desktop App 使用你在本机设置的模型，不依赖云端账户或订阅。'
  },
  {
    id: 'projects',
    label: '项目与指令',
    title: '把长期工作放进项目',
    summary: '项目保存对话、关联文件夹和项目指令；普通聊天不使用项目上下文。'
  }
] as const

function valueAt(source: unknown, path: string[]) {
  let value: any = source
  for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined
  return value
}

function dshModelReady(snapshot: DshModelSettingsSnapshot) {
  return snapshot.groups.some((group) => {
    if (!group.models.length) return false
    const provider = snapshot.providers.find((candidate) => candidate.provider === group.id)
    if (!provider?.active) return false
    const namespace = snapshot.namespaces.find((candidate) => candidate.ns === provider.settingsNs)
    const profile = valueAt(namespace?.value, provider.settingsPath)
    const ref = typeof profile?.apiKeyEnv === 'string' ? profile.apiKeyEnv : ''
    return ref ? snapshot.credentials[ref]?.configured === true : true
  })
}

export default function DshOnboarding({
  onClose,
  onFinish,
  onOpenModels
}: DshOnboardingProps) {
  const [active, setActive] = useState(0)
  const [modelReady, setModelReady] = useState(false)
  const [modelLoading, setModelLoading] = useState(true)
  const step = STEPS[active]

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    const load = () => getDshModelSettingsReq()
      .then((response: any) => {
        if (alive) setModelReady(dshModelReady(response?.data || response))
      })
      .catch(() => { if (alive) setModelReady(false) })
      .finally(() => { if (alive) setModelLoading(false) })
    void load()
    void subscribeDshModelSettingsEvents((event) => {
      if (event.type === 'dsh_models.changed') void load()
    }, controller.signal).catch(() => undefined)
    return () => {
      alive = false
      controller.abort()
    }
  }, [])

  const meta = { requiredModelsReady: modelReady }
  const next = () => {
    if (active === STEPS.length - 1) onFinish?.(meta)
    else setActive((value) => value + 1)
  }

  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-labelledby="dsh-onboarding-title">
      <div className={styles.backdrop} />
      <section className={styles.panel}>
        <header className={styles.header}>
          <div>
            <span className={styles.kicker}>DeepSeek Harness Desktop App 初始引导</span>
            <h2 id="dsh-onboarding-title">{step.title}</h2>
            <p>{step.summary}</p>
          </div>
          <button type="button" className={styles.close} onClick={() => onClose?.(meta)} aria-label="关闭引导">
            <IconX size={18} stroke={1.8} />
          </button>
        </header>

        <main className={styles.content}>
          {step.id === 'welcome' && (
            <div className={styles.capabilityGrid}>
              <Capability icon={<IconMessage size={20} />} title="自然对话" desc="问问题、写内容、做计划，复杂任务会显示执行过程。" />
              <Capability icon={<IconFile size={20} />} title="本地文件" desc="添加文件或文件夹，在允许的工作区内读取和修改。" />
              <Capability icon={<IconPhoto size={20} />} title="图片理解" desc="粘贴或拖入图片，让支持视觉的主模型直接查看。" />
              <Capability icon={<IconWorldSearch size={20} />} title="联网与引用" desc="搜索真实网页、打开正文，并把采用的来源带回回答。" />
            </div>
          )}

          {step.id === 'model' && (
            <div className={styles.modelCard} data-ready={modelReady ? 'true' : undefined}>
              <div className={styles.modelIcon}>{modelReady ? <IconCheck size={22} /> : <IconSettings size={22} />}</div>
              <div>
                <strong>{modelLoading ? '正在检查模型…' : modelReady ? '主模型已配置' : '还没有主模型'}</strong>
                <p>{modelReady ? '现在可以直接开始聊天。模型选择和图片输入能力由 DSH 在请求时校验。' : '在 DSH Profile 中配置提供方、密钥和模型目录后，就可以开始聊天。'}</p>
              </div>
              <button type="button" onClick={onOpenModels}>打开模型设置</button>
            </div>
          )}

          {step.id === 'projects' && (
            <div className={styles.projectGrid}>
              <div>
                <IconBrain size={22} />
                <strong>全局指令</strong>
                <p>语言、回答风格和通用工作习惯，对所有聊天生效。</p>
              </div>
              <div>
                <IconFolder size={22} />
                <strong>项目指令</strong>
                <p>只在当前项目生效，并可关联本地文件夹作为长期上下文。</p>
              </div>
              <div className={styles.projectNote}>
                普通聊天适合一次性问题；项目适合持续任务。两者的草稿和对话记录都只保存在本机。
              </div>
            </div>
          )}
        </main>

        <footer className={styles.footer}>
          <div className={styles.progress}>
            {STEPS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                data-active={active === index ? 'true' : undefined}
                onClick={() => setActive(index)}
                aria-label={`切换到${item.label}`}
              />
            ))}
            <span>{active + 1} / {STEPS.length} · {step.label}</span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.skip} onClick={() => onClose?.(meta)}>跳过</button>
            {active > 0 && (
              <button type="button" className={styles.secondary} onClick={() => setActive((value) => value - 1)}>
                <IconArrowLeft size={15} />上一步
              </button>
            )}
            <button type="button" className={styles.primary} onClick={next}>
              {active === STEPS.length - 1 ? '进入 DeepSeek Harness Desktop App' : '下一步'}
              {active < STEPS.length - 1 && <IconArrowRight size={15} />}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function Capability({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className={styles.capability}>
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{desc}</p>
    </div>
  )
}
