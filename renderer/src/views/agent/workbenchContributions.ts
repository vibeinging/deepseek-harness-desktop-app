import type { WorkbenchTab } from './workbenchTabs'

export const WORKBENCH_SLOT = 'agent.workbench.tool' as const

export type WorkbenchComponent = `dsh-work/${WorkbenchTab}`
export type WorkbenchIcon = 'archive' | 'dashboard' | 'file' | 'terminal' | 'world'

export interface WorkbenchContribution {
  slot: typeof WORKBENCH_SLOT
  id: WorkbenchTab
  component: WorkbenchComponent
  label: string
  icon: WorkbenchIcon
  order: number
  packageName: string
}

interface ProfileBundleLike {
  name?: unknown
  managed_by?: unknown
  profile_order?: unknown
  product?: {
    contributions?: unknown
  } | null
}

const COMPONENTS = new Set<WorkbenchComponent>([
  'dsh-work/review',
  'dsh-work/browser',
  'dsh-work/files',
  'dsh-work/artifacts',
  'dsh-work/sites'
])

const ICONS = new Set<WorkbenchIcon>(['archive', 'dashboard', 'file', 'terminal', 'world'])

function isWorkbenchTab(value: unknown): value is WorkbenchTab {
  return typeof value === 'string' && COMPONENTS.has(`dsh-work/${value}` as WorkbenchComponent)
}

/** Project app-managed Profile Bundle metadata into the trusted workbench slot. */
export function projectWorkbenchContributions(bundles: readonly ProfileBundleLike[]): WorkbenchContribution[] {
  const byId = new Map<WorkbenchTab, WorkbenchContribution>()
  const orderedBundles = [...bundles].sort((left, right) => (
    Number(left.profile_order || 0) - Number(right.profile_order || 0)
  ))
  for (const bundle of orderedBundles) {
    // Host components execute in the app renderer. Only bundles shipped and
    // reviewed with dsh-work may name them; user bundles need a future
    // sandboxed contribution kind instead of acquiring renderer authority.
    if (bundle.managed_by !== 'app') continue
    const packageName = typeof bundle.name === 'string' ? bundle.name : ''
    const contributions = bundle.product?.contributions
    if (!Array.isArray(contributions)) continue
    for (const raw of contributions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entry = raw as Record<string, unknown>
      if (entry.slot !== WORKBENCH_SLOT || !isWorkbenchTab(entry.id)) continue
      const component = entry.component
      const icon = entry.icon
      const label = typeof entry.label === 'string' ? entry.label.trim() : ''
      if (!COMPONENTS.has(component as WorkbenchComponent) || !ICONS.has(icon as WorkbenchIcon) || !label) continue
      if (component !== `dsh-work/${entry.id}`) continue
      byId.set(entry.id, {
        slot: WORKBENCH_SLOT,
        id: entry.id,
        component: component as WorkbenchComponent,
        label,
        icon: icon as WorkbenchIcon,
        order: Number.isSafeInteger(entry.order) ? Number(entry.order) : 0,
        packageName
      })
    }
  }
  return [...byId.values()].sort((left, right) => left.order - right.order)
}
