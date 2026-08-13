/**
 * URL utility helpers.
 * Handle baseURL/path joining and avoid duplicate slashes.
 */

/**
 * Get the base URL.
 * @returns {string} Base URL.
 */
export function getBaseURL() {
  return import.meta.env.VITE_APP_BASE_URL || window.location.origin || ''
}

/**
 * Map frontend origin to backend origin for the same worktree.
 * Convention:
 * - frontend 515x <-> backend 511x
 * - other ports keep unchanged
 * @param {string} origin - Current frontend origin.
 * @returns {string} Backend origin.
 */
export function mapFrontendOriginToBackendOrigin(origin: any = window.location.origin || '') {
  const value = String(origin || '')
  return value.replace(/:515(\d)\b/, ':511$1')
}

/**
 * Join base URL and path.
 * @param {string} baseURL - Base URL.
 * @param {string} path - Path.
 * @returns {string} Full joined URL.
 */
export function joinURL(baseURL: any, path: any) {
  // Remove trailing slash from base URL.
  const cleanBaseURL = baseURL.replace(/\/$/, '')
  // Ensure path starts with slash.
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${cleanBaseURL}${cleanPath}`
}

/**
 * Build API URL.
 * @param {string} path - API path.
 * @returns {string} Full API URL.
 */
export function createAPIURL(path: any) {
  return joinURL(getBaseURL(), path)
}
