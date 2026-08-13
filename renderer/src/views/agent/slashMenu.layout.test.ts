import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationSource = readFileSync(fileURLToPath(new URL('./AgentConversation.tsx', import.meta.url)), 'utf8')
const skillSelectionSource = readFileSync(fileURLToPath(new URL('./conversationSkillSelection.ts', import.meta.url)), 'utf8')
const menuSource = readFileSync(fileURLToPath(new URL('./SlashMenu.tsx', import.meta.url)), 'utf8')
const modelSource = readFileSync(fileURLToPath(new URL('./ConversationModelSelector.tsx', import.meta.url)), 'utf8')
const shellSource = readFileSync(fileURLToPath(new URL('./AgentShell.tsx', import.meta.url)), 'utf8')
const styleSource = readFileSync(fileURLToPath(new URL('./agent.module.scss', import.meta.url)), 'utf8')

describe('slash menu integration contract', () => {
  it('loads real workspace skills and supports keyboard selection', () => {
    expect(conversationSource).toContain('getDshSkillsReq(projectId, currentSessionId)')
    expect(conversationSource).toContain("e.key === 'ArrowDown'")
    expect(conversationSource).toContain("e.key === 'ArrowUp'")
    expect(conversationSource).toContain('applySlashSkill')
    expect(menuSource).toContain('data-slash-menu')
    expect(menuSource).toContain('role="listbox"')
    expect(styleSource).toContain(".slashItem[data-active='true']")
  })

  it('passes the Skill default prompt into the selected composer Skill', () => {
    expect(conversationSource).toContain('skill?.interface?.display_name')
    expect(conversationSource).toContain('skill?.interface?.default_prompt')
    expect(conversationSource).toContain('onSelectSkill?.(selectionFromCatalogSkill(skill))')
    expect(conversationSource).toContain('skillName: skill.skillName')
    expect(conversationSource).toContain('qualifiedName: skill.qualifiedName')
    expect(conversationSource).toContain('...(skill.prompt ? { prompt: skill.prompt } : {})')
    expect(conversationSource).toContain('...(skill.digest ? { digest: skill.digest } : {})')
  })

  it('connects commands to existing model and review surfaces', () => {
    expect(conversationSource).toContain("name === 'runs' || name === 'trace'")
    expect(conversationSource).toContain('OPEN_AGENT_REVIEW')
    expect(modelSource).toContain('openRequest?: number')
    expect(shellSource).toContain('selectedSkills={composerSkills}')
    expect(shellSource).toContain('current.some((item) => item.name === skill.name)')
  })

  it('routes selected Skills directly to DSH without the removed project Plugin selection state', () => {
    expect(conversationSource).toContain('agentRoutedSkillNames(turnSkillSelections)')
    expect(skillSelectionSource).not.toContain('pluginSkills')
    expect(conversationSource).not.toContain('capabilitySelection')
  })

  it('shows installed image templates from catalog metadata without an App-owned creator Skill', () => {
    expect(conversationSource).toContain('catalogToolDependencies')
    expect(conversationSource).toContain('skill.toolDependencies?.includes(IMAGE_GENERATION_TOOL)')
    expect(conversationSource).toContain('skill.artifactTemplate?.gallery_kind === IMAGE_TEMPLATE_GALLERY_KIND')
    expect(conversationSource).not.toContain('artifact_template_create')
    expect(conversationSource).not.toContain('pickTemplateImage')
    expect(conversationSource).not.toContain("=== 'imagegen'")
  })
})
