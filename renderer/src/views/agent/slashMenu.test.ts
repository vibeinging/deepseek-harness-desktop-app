import { describe, expect, it } from 'vitest'
import { filterSlash, filterSlashSkills, slashMenuItems, SLASH_COMMANDS } from './SlashMenu'

const skills = [
  { name: 'data-quality', label: '数据质量检查', description: '检查表和数据集质量' },
  { name: 'weekly-report', label: '周报生成', description: '生成项目周报' }
]

describe('slash menu commands', () => {
  it('keeps all fixed commands discoverable in a new conversation', () => {
    expect(SLASH_COMMANDS.map((item) => item.name)).toEqual([
      'new', 'compact', 'model', 'skill', 'runs', 'trace'
    ])
    const items = filterSlash('', { hasSession: false, hasProject: true })
    expect(items).toHaveLength(6)
    expect(items.find((item) => item.command.name === 'compact')).toMatchObject({
      disabled: true,
      reason: '需要先有一轮对话'
    })
    expect(items.find((item) => item.command.name === 'new')?.disabled).toBe(false)
  })

  it('searches command names and Chinese descriptions', () => {
    expect(filterSlash('token', { hasSession: true }).map((item) => item.command.name)).toEqual(['trace'])
    expect(filterSlash('审查', { hasSession: true }).map((item) => item.command.name)).toEqual(['runs'])
  })

  it('filters enabled skills separately and supports a skills-only view', () => {
    expect(filterSlashSkills('质量', skills).map((item) => item.skill.name)).toEqual(['data-quality'])
    const items = slashMenuItems('周报', { hasSession: false }, skills, true)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'skill', skill: { name: 'weekly-report' } })
  })

  it('keeps unverified and unavailable Skills visible but prevents execution', () => {
    const items = filterSlashSkills('', [
      { name: 'external', label: '外部技能', description: '', availability: 'unverified', availabilityReason: '尚未验收' },
      { name: 'missing-cli', label: '缺少命令', description: '', availability: 'unavailable', availabilityReason: '缺少本机命令' },
      { name: 'verified', label: '已验证', description: '', availability: 'enabled' }
    ])
    expect(items[0]).toMatchObject({ disabled: true, reason: '尚未验收' })
    expect(items[1]).toMatchObject({ disabled: true, reason: '缺少本机命令' })
    expect(items[2]).toMatchObject({ disabled: false })
  })

  it('disables state-changing commands while a turn is running', () => {
    const items = filterSlash('', { hasSession: true, busy: true, hasProject: true })
    expect(items.find((item) => item.command.name === 'new')).toMatchObject({ disabled: true })
    expect(items.find((item) => item.command.name === 'runs')).toMatchObject({ disabled: false })
    expect(items.find((item) => item.command.name === 'trace')).toMatchObject({ disabled: false })
  })
})
