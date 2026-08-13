export type WorkbenchTab = 'review' | 'browser' | 'files' | 'artifacts' | 'sites'

export type WorkbenchTabsState = {
  opened: WorkbenchTab[]
  active: WorkbenchTab | null
}

export const EMPTY_WORKBENCH_TABS: WorkbenchTabsState = {
  opened: [],
  active: null
}

export function openWorkbenchTabState(
  state: WorkbenchTabsState,
  tab: WorkbenchTab
): WorkbenchTabsState {
  const current = state
  const key = tab
  return {
    opened: current.opened.includes(key) ? current.opened : [...current.opened, key],
    active: key
  }
}

export function activateWorkbenchTabState(
  state: WorkbenchTabsState,
  tab: WorkbenchTab
): WorkbenchTabsState {
  const current = state
  const key = tab
  return current.opened.includes(key) ? { ...current, active: key } : current
}

export function closeWorkbenchTabState(
  state: WorkbenchTabsState,
  tab: WorkbenchTab
): WorkbenchTabsState {
  const current = state
  const key = tab
  const closedIndex = current.opened.indexOf(key)
  if (closedIndex < 0) return current

  const opened = current.opened.filter((item) => item !== key)
  if (current.active !== key) return { opened, active: current.active }

  return {
    opened,
    active: opened[Math.min(closedIndex, opened.length - 1)] || null
  }
}

/** Remove tabs whose Profile contribution is no longer present. */
export function reconcileWorkbenchTabsState(
  state: WorkbenchTabsState,
  available: readonly WorkbenchTab[]
): WorkbenchTabsState {
  const allowed = new Set(available)
  const opened = state.opened.filter((tab) => allowed.has(tab))
  const active = state.active && opened.includes(state.active)
    ? state.active
    : opened.at(-1) || null
  if (
    active === state.active
    && opened.length === state.opened.length
    && opened.every((tab, index) => tab === state.opened[index])
  ) return state
  return { opened, active }
}
