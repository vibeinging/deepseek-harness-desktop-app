import { describe, expect, it } from 'vitest'
import {
  collaborationModeFromDshPlan,
  effectiveDshPlanMode,
  normalizeCollaborationMode,
} from './collaborationMode'

describe('conversation collaboration mode', () => {
  it('only accepts the current Codex Default and Plan values', () => {
    expect(normalizeCollaborationMode('default')).toBe('default')
    expect(normalizeCollaborationMode('plan')).toBe('plan')
    expect(normalizeCollaborationMode('legacy-plan')).toBe('default')
  })

  it('reads active and pending states from the DSH Plan projection', () => {
    expect(effectiveDshPlanMode({ active: true, pending: false })).toBe(true)
    expect(effectiveDshPlanMode({ active: false, pending: false })).toBe(false)
    expect(effectiveDshPlanMode({ active: false, pending: true })).toBe(true)
    expect(effectiveDshPlanMode({ active: true, pending: true })).toBe(false)
    expect(effectiveDshPlanMode(null)).toBeNull()
  })

  it('does not invent a mode when the DSH projection is missing', () => {
    expect(collaborationModeFromDshPlan({ active: true })).toBe('plan')
    expect(collaborationModeFromDshPlan({ active: false })).toBe('default')
    expect(collaborationModeFromDshPlan(undefined)).toBeNull()
  })
})
