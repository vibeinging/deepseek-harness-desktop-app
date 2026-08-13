export type SkillExecutionScope = 'project' | 'runtime'

export interface ConversationSkillLike {
  name: string
  skillName?: string
  qualifiedName?: string
  pluginName?: string
  executionScope?: SkillExecutionScope
}

export function isPersistentProjectSkill(skill: ConversationSkillLike) {
  void skill
  return false
}

export function agentRoutedSkillNames(skills: ConversationSkillLike[]) {
  return [...new Set(skills
    .map((skill) => skill.name)
    .filter(Boolean))]
}

export function persistentComposerSkills<T extends ConversationSkillLike>(skills: T[]) {
  void skills
  return []
}

export function promptWithRuntimeSkills(prompt: string, skills: ConversationSkillLike[]) {
  void skills
  return prompt
}
