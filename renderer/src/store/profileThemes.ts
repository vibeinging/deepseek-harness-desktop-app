import { listPluginCatalogReq } from '@/api/plugins'
import { useSkinsStore } from '@/store/skins'
import type { SkinDefinition } from '@/theme/skins/types'

interface ProfileThemeError {
  message?: unknown
}

export interface ProfileThemeCatalogSnapshot {
  authoritative: true
  profile_themes: SkinDefinition[]
  profile_theme_errors: ProfileThemeError[]
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Normalize the DSH Profile catalog envelope without treating a malformed response as an empty catalog. */
export function normalizeProfileThemeCatalog(value: unknown): ProfileThemeCatalogSnapshot {
  const outer = asObject(value)
  const payload = asObject(outer.data && typeof outer.data === 'object' ? outer.data : outer)
  if (!Array.isArray(payload.profile_themes)) {
    throw new Error('DSH Profile catalog.profile_themes 必须是数组')
  }
  return {
    authoritative: true,
    profile_themes: payload.profile_themes as SkinDefinition[],
    profile_theme_errors: Array.isArray(payload.profile_theme_errors)
      ? payload.profile_theme_errors as ProfileThemeError[]
      : []
  }
}

let refreshSequence = 0
let refreshInFlight: Promise<ProfileThemeCatalogSnapshot> | null = null

/**
 * Refresh the full Profile-owned theme snapshot.
 * A successful empty snapshot removes old Profile themes; request failure preserves the last applied snapshot.
 */
export function refreshProfileThemes(force = false): Promise<ProfileThemeCatalogSnapshot> {
  if (refreshInFlight && !force) return refreshInFlight
  const requestId = ++refreshSequence
  let response: unknown | Promise<unknown>
  try {
    response = listPluginCatalogReq(force)
  } catch (error) {
    response = Promise.reject(error)
  }
  let request: Promise<ProfileThemeCatalogSnapshot>
  request = Promise.resolve(response)
    .then(async (result) => {
      const snapshot = normalizeProfileThemeCatalog(result)
      if (requestId !== refreshSequence) return snapshot
      const warnings = snapshot.profile_theme_errors
        .map((error) => typeof error?.message === 'string' ? error.message.trim() : '')
        .filter(Boolean)
      await useSkinsStore.getState().setProfileThemes(snapshot.profile_themes, {
        authoritative: true,
        warnings
      })
      return snapshot
    })
    .finally(() => {
      if (refreshInFlight === request) refreshInFlight = null
    })
  refreshInFlight = request
  return request
}

/** Reset module request state for isolated tests. */
export function resetProfileThemeRefreshForTests() {
  refreshSequence = 0
  refreshInFlight = null
}
