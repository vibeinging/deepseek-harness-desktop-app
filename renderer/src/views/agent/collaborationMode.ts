export type CollaborationMode = 'default' | 'plan'

const COLLABORATION_MODES = new Set<CollaborationMode>(['default', 'plan'])

export function normalizeCollaborationMode(value: unknown): CollaborationMode {
  return COLLABORATION_MODES.has(value as CollaborationMode)
    ? value as CollaborationMode
    : 'default'
}

/** Read the effective state of DSH's logged Plan projection. */
export function effectiveDshPlanMode(value: unknown): boolean | null {
  if (!value || typeof value !== 'object') return null
  const projection = value as { active?: unknown; pending?: unknown }
  const active = projection.active === true
  return projection.pending === true ? !active : active
}

/** Convert one DSH Plan projection into the composer mode. */
export function collaborationModeFromDshPlan(value: unknown): CollaborationMode | null {
  const active = effectiveDshPlanMode(value)
  if (active === null) return null
  return active ? 'plan' : 'default'
}
