import { describe, expect, it } from 'vitest'
import {
  agentRoutedSkillNames,
  persistentComposerSkills,
  promptWithRuntimeSkills
} from './conversationSkillSelection'

describe('conversation Skill selection boundary', () => {
  const projectSkill = {
    name: 'document-tools:create-document',
    qualifiedName: 'document-tools:create-document',
    pluginName: 'document-tools',
    executionScope: 'project' as const
  }
  const runtimeSkill = {
    name: 'codex-security:security-scan',
    skillName: 'security-scan',
    qualifiedName: 'codex-security:security-scan',
    pluginName: 'codex-security',
    executionScope: 'runtime' as const
  }
  const localSkill = { name: 'imagegen' }

  it('routes every selected Skill through the DSH Skill reference contract', () => {
    expect(agentRoutedSkillNames([projectSkill, runtimeSkill, localSkill])).toEqual([
      'document-tools:create-document',
      'codex-security:security-scan',
      'imagegen'
    ])
    expect(promptWithRuntimeSkills('扫描这个文件', [runtimeSkill])).toBe('扫描这个文件')
  })

  it('clears every selected Skill after the turn because Profile state is runtime-owned', () => {
    expect(persistentComposerSkills([projectSkill, runtimeSkill, localSkill])).toEqual([])
  })
})
