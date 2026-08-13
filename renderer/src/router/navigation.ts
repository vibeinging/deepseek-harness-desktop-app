/**
 * Routing bridge for non-component callers (store, axios interceptors, guards).
 * Inject the real `navigate` via setNavigate after createBrowserRouter is created
 * to avoid store-router circular dependency.
 */
export type NavigateFn = (to: string, opts?: { replace?: boolean }) => void

let _navigate: NavigateFn = () => {
  // Fallback to browser navigation when the router is not ready.
  if (typeof window !== 'undefined') window.location.assign('/agent')
}

export const setNavigate = (fn: NavigateFn) => {
  _navigate = fn
}

export const navigate: NavigateFn = (to, opts) => _navigate(to, opts)
