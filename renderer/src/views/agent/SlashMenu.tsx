import { useEffect, useMemo, useRef } from 'react'
import {
  IconActivityHeartbeat,
  IconAdjustmentsHorizontal,
  IconArchive,
  IconBox,
  IconListCheck,
  IconMessagePlus,
  type Icon as TablerIcon
} from '@tabler/icons-react'
import { isSkillRunnable, skillAvailabilityReason } from '../skills/skillAvailability'
import styles from './agent.module.scss'

export interface SlashCommand {
  name: string
  label: string
  desc: string
  keywords: string
  icon: TablerIcon
  requiresSession?: boolean
  requiresIdle?: boolean
  requiresProject?: boolean
}

export interface SlashSkill {
  /** Stable opaque key sent back to the Host; never a local Skill path. */
  name: string
  skillName?: string
  qualifiedName?: string
  label: string
  description: string
  prompt?: string
  source?: string
  scope?: string
  pluginName?: string
  version?: string
  digest?: string
  availability?: string
  availabilityReason?: string
  toolDependencies?: string[]
  artifactTemplate?: { name?: string; description?: string; preview_path?: string; gallery_kind?: string } | null
}

export type SlashCommandItem = { id: string; kind: 'command'; command: SlashCommand; disabled: boolean; reason?: string }
export type SlashSkillItem = { id: string; kind: 'skill'; skill: SlashSkill; disabled: boolean; reason?: string }
export type SlashMenuItem = SlashCommandItem | SlashSkillItem

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', label: '/new', desc: '新建空白对话', keywords: '新对话 新聊天', icon: IconMessagePlus, requiresIdle: true },
  { name: 'compact', label: '/compact', desc: '压缩当前对话上下文', keywords: '压缩 上下文 记忆', icon: IconArchive, requiresSession: true, requiresIdle: true },
  { name: 'model', label: '/model', desc: '选择模型和推理强度', keywords: '模型 推理 强度', icon: IconAdjustmentsHorizontal },
  { name: 'skill', label: '/skill', desc: '筛选当前工作区技能', keywords: '技能 skill', icon: IconBox },
  { name: 'runs', label: '/runs', desc: '打开当前对话的 DSH 轨迹', keywords: '轨迹 运行 审查 工具 错误', icon: IconListCheck, requiresSession: true },
  { name: 'trace', label: '/trace', desc: '查看 DSH 事件、耗时和 Token', keywords: '过程 事件 轨迹 耗时 token 错误', icon: IconActivityHeartbeat, requiresSession: true }
]

export interface SlashCtx {
  hasSession?: boolean
  busy?: boolean
  hasProject?: boolean
}

export function filterSlash(query: string, ctx: SlashCtx = {}): SlashCommandItem[] {
  const keyword = query.trim().toLowerCase()
  return SLASH_COMMANDS
    .filter((command) => !keyword || `${command.name} ${command.label} ${command.desc} ${command.keywords}`.toLowerCase().includes(keyword))
    .map((command) => ({
      id: `command:${command.name}`,
      kind: 'command' as const,
      command,
      disabled: Boolean(
        (command.requiresSession && !ctx.hasSession)
        || (command.requiresIdle && ctx.busy)
        || (command.requiresProject && !ctx.hasProject)
      ),
      reason: command.requiresSession && !ctx.hasSession
        ? '需要先有一轮对话'
        : command.requiresIdle && ctx.busy
          ? '当前任务完成后可用'
          : command.requiresProject && !ctx.hasProject
            ? '需要先创建一个项目'
          : undefined
    }))
}

export function filterSlashSkills(query: string, skills: SlashSkill[]): SlashSkillItem[] {
  const keyword = query.trim().toLowerCase()
  return skills
    .filter((skill) => !keyword || `${skill.name} ${skill.label} ${skill.description}`.toLowerCase().includes(keyword))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      skill,
      disabled: !isSkillRunnable(skill),
      reason: !isSkillRunnable(skill)
        ? skillAvailabilityReason(skill) || (skill.availability === 'unverified' ? '本机发现，尚未通过兼容验证' : '当前不可用')
        : undefined
    }))
}

export function slashMenuItems(query: string, ctx: SlashCtx, skills: SlashSkill[], skillsOnly = false): SlashMenuItem[] {
  return [
    ...(skillsOnly ? [] : filterSlash(query, ctx)),
    ...filterSlashSkills(query, skills)
  ]
}

interface Props {
  query: string
  hasSession?: boolean
  busy?: boolean
  hasProject?: boolean
  skills: SlashSkill[]
  skillsOnly?: boolean
  skillsStatus: 'idle' | 'loading' | 'ready' | 'error'
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onRun: (name: string) => void
  onSkill: (skill: SlashSkill) => void
}

export default function SlashMenu({
  query,
  hasSession,
  busy,
  hasProject,
  skills,
  skillsOnly = false,
  skillsStatus,
  activeIndex,
  onActiveIndexChange,
  onRun,
  onSkill
}: Props) {
  const commandItems = useMemo(
    () => skillsOnly ? [] : filterSlash(query, { hasSession, busy, hasProject }),
    [busy, hasProject, hasSession, query, skillsOnly]
  )
  const skillItems = useMemo(() => filterSlashSkills(query, skills), [query, skills])
  const items = [...commandItems, ...skillItems]
  const showSkillSection = skillsOnly || !query || skillItems.length > 0
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className={`${styles.mentionPanel} ${styles.slashPanel}`} data-slash-menu role="listbox" aria-label="输入框命令">
      <div className={styles.slashScroll}>
        {!skillsOnly && commandItems.length > 0 && <div className={styles.mentionHd}>常用命令</div>}
        {!skillsOnly && commandItems.map((item, index) => {
          const Icon = item.command.icon
          const active = index === activeIndex
          return (
            <button
              ref={active ? activeRef : undefined}
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={item.disabled}
              className={styles.slashItem}
              data-active={active ? 'true' : undefined}
              data-disabled={item.disabled ? 'true' : undefined}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => !item.disabled && onRun(item.command.name)}
            >
              <Icon size={15} stroke={1.65} className={styles.wsPickItemIcon} />
              <span className={styles.slashName}>{item.command.label}</span>
              <span className={styles.slashDesc}>{item.reason || item.command.desc}</span>
            </button>
          )
        })}

        {showSkillSection && (
          <div className={styles.mentionHd}>{skillsOnly ? '选择技能' : '技能'}</div>
        )}
        {showSkillSection && skillsStatus === 'loading' && <div className={styles.slashState}>正在读取当前工作区技能…</div>}
        {showSkillSection && skillsStatus === 'error' && <div className={styles.slashState} data-error="true">技能暂时无法读取，固定命令仍可使用</div>}
        {showSkillSection && skillsStatus === 'ready' && !skillItems.length && (
          <div className={styles.slashState}>{query ? '没有匹配的技能' : '当前工作区没有已启用技能'}</div>
        )}
        {skillItems.map((item, skillIndex) => {
          const index = commandItems.length + skillIndex
          const active = index === activeIndex
          return (
            <button
              ref={active ? activeRef : undefined}
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={item.disabled}
              className={styles.slashItem}
              data-active={active ? 'true' : undefined}
              data-disabled={item.disabled ? 'true' : undefined}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => !item.disabled && onSkill(item.skill)}
            >
              <IconBox size={15} stroke={1.65} className={styles.wsPickItemIcon} />
              <span className={styles.slashSkillName}>{item.skill.label}</span>
              <span className={styles.slashDesc}>{item.reason || item.skill.description || item.skill.name}</span>
            </button>
          )
        })}
        {!items.length && skillsStatus !== 'loading' && skillsStatus !== 'error' && (
          <div className={styles.slashState}>没有这个命令</div>
        )}
      </div>
      <div className={styles.slashFooter}><span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span></div>
    </div>
  )
}
