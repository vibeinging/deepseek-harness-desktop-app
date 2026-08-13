export type ProfileCatalogChangeReason = 'install' | 'uninstall' | 'upgrade'

export interface ProfileCatalogChanged {
  reason: ProfileCatalogChangeReason
  canonical_plugin_id: string
  event_id?: string | null
}

const listeners = new Set<(change: ProfileCatalogChanged) => void>()

/** Publish one authoritative DSH Profile catalog invalidation. */
export function dispatchProfileCatalogChanged(
  change: Omit<ProfileCatalogChanged, 'event_id'>,
  eventId?: string | null
) {
  const event = { ...change, event_id: eventId || null }
  for (const listener of listeners) listener(event)
}

/** Subscribe to DSH Profile catalog invalidations. */
export function subscribeProfileCatalogChanged(listener: (change: ProfileCatalogChanged) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
