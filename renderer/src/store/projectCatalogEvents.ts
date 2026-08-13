export const PROJECT_CATALOG_CHANGED_EVENT = 'dsh:project-catalog-changed'

export function notifyProjectCatalogChanged() {
  window.dispatchEvent(new Event(PROJECT_CATALOG_CHANGED_EVENT))
}

export function subscribeProjectCatalogChanged(listener: () => void) {
  window.addEventListener(PROJECT_CATALOG_CHANGED_EVENT, listener)
  return () => window.removeEventListener(PROJECT_CATALOG_CHANGED_EVENT, listener)
}
