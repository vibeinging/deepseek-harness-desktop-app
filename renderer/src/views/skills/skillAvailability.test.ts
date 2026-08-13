import { describe, expect, it } from 'vitest'
import {
  isSkillConfiguredEnabled,
  isSkillRunnable,
  skillIsUnavailable,
  skillStatusText
} from './skillAvailability'

describe('Skill availability', () => {
  it('separates configured state from runnable state', () => {
    const skill = { effective_enabled: true, availability: 'unverified' }
    expect(isSkillConfiguredEnabled(skill)).toBe(true)
    expect(isSkillRunnable(skill)).toBe(false)
    expect(skillIsUnavailable(skill)).toBe(true)
    expect(skillStatusText(skill)).toBe('未验证')
  })

  it('shows enabled Skills as runnable and disabled Skills as closed', () => {
    expect(isSkillRunnable({ availability: 'enabled' })).toBe(true)
    expect(skillStatusText({ availability: 'enabled' })).toBe('可运行')
    expect(skillStatusText({ effective_enabled: false, availability: 'disabled' })).toBe('已关闭')
  })

  it('does not mislabel unavailable as enabled', () => {
    const skill = { effective_enabled: true, availability: 'unavailable' }
    expect(isSkillRunnable(skill)).toBe(false)
    expect(skillStatusText(skill)).toBe('不可用')
  })
})
