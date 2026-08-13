export interface SkillAvailabilityLike {
  availability?: string | null
  availability_reason?: string | null
  availabilityReason?: string | null
  effective_enabled?: boolean | null
  is_enabled?: boolean | null
  default_enabled?: boolean | null
}

export function isSkillConfiguredEnabled(skill: SkillAvailabilityLike | null | undefined) {
  if (!skill) return false
  const declared = skill.effective_enabled ?? skill.is_enabled ?? skill.default_enabled
  return declared == null ? true : Boolean(declared)
}

export function isSkillRunnable(skill: SkillAvailabilityLike | null | undefined) {
  return isSkillConfiguredEnabled(skill) && String(skill?.availability || 'enabled') === 'enabled'
}

export function skillAvailabilityReason(skill: SkillAvailabilityLike | null | undefined) {
  return String(skill?.availability_reason || skill?.availabilityReason || '')
}

export function skillStatusText(skill: SkillAvailabilityLike | null | undefined) {
  if (!skill) return '-'
  if (!isSkillConfiguredEnabled(skill) || skill.availability === 'disabled') return '已关闭'
  if (skill.availability === 'unverified') return '未验证'
  if (skill.availability === 'unavailable' || skill.availability === 'blocked') return '不可用'
  return '可运行'
}

export function skillIsUnavailable(skill: SkillAvailabilityLike | null | undefined) {
  return !isSkillRunnable(skill)
}
