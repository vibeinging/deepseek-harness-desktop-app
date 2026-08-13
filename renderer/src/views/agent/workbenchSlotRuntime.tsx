import { useMemo, type ReactNode } from 'react'
import {
  SlotCore,
  type HostObservable,
  type LiveSlotNode,
  type PropsRenderSlots,
  type SessionMaybeProvideInfo,
  type SlotRendererHost
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import {
  WORKBENCH_SLOT,
  type WorkbenchContribution
} from './workbenchContributions'
import type { WorkbenchTab } from './workbenchTabs'
import styles from './agent.module.scss'

interface WorkbenchRootOwner {
  opened: readonly WorkbenchTab[]
  active: WorkbenchTab | null
  renderContribution: (tool: WorkbenchContribution) => ReactNode
}

interface WorkbenchToolOwner {
  active: WorkbenchTab | null
  renderContribution: (tool: WorkbenchContribution) => ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    root: {
      kind: 'single'
      scope: 'root'
      owner: WorkbenchRootOwner
    }
    'agent.workbench.tool': {
      kind: 'list'
      scope: 'root'
      owner: WorkbenchToolOwner
    }
  }
}

type WorkbenchRootProps = WorkbenchRootOwner & PropsRenderSlots<typeof WORKBENCH_SLOT>

export interface WorkbenchSlotRuntime {
  render(owner: WorkbenchRootOwner): ReactNode
  snapshot(): LiveSlotNode[]
}

interface WorkbenchSlotPanelsProps extends WorkbenchRootOwner {
  tools: readonly WorkbenchContribution[]
}

const renderer = createSlotRenderer()

function constantObservable<T>(value: T): HostObservable<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => undefined
  }
}

const emptySessionInfo: SessionMaybeProvideInfo = {
  sessionId: undefined,
  hooks: {},
  props: {}
}

function WorkbenchRoot({ opened, active, renderContribution, renderSlot }: WorkbenchRootProps) {
  return (
    <div className={styles.workbenchTabPanels} data-workbench-slot-runtime="dsh">
      {opened.map((tab) => renderSlot(WORKBENCH_SLOT, {
        active,
        renderContribution
      }, { only: tab }))}
    </div>
  )
}

/** Assemble the Profile roster into the official DSH Slot registry and React renderer. */
export function createWorkbenchSlotRuntime(
  tools: readonly WorkbenchContribution[]
): WorkbenchSlotRuntime {
  const core = new SlotCore()
  core.register({
    name: 'root',
    registrant: 'dsh-work',
    children: {
      [WORKBENCH_SLOT]: { kind: 'list', scope: 'root' }
    }
  }, WorkbenchRoot)

  for (const tool of tools) {
    core.register({
      name: WORKBENCH_SLOT,
      id: tool.id,
      order: tool.order,
      label: tool.label,
      registrant: tool.packageName
    }, ({ active, renderContribution }: WorkbenchToolOwner) => (
      <div
        id={`workbench-panel-${tool.id}`}
        className={styles.workbenchTabPanel}
        role="tabpanel"
        aria-labelledby={`workbench-tab-${tool.id}`}
        data-workbench-panel={tool.id}
        data-workbench-component={tool.component}
        data-workbench-source-bundle={tool.packageName}
        hidden={active !== tool.id}
      >
        {renderContribution(tool)}
      </div>
    ))
  }

  const host: SlotRendererHost = {
    subscribe: (key, notify) => core.subscribe(key, notify),
    getVersion: (key) => core.getVersion(key),
    entriesOf: (key) => core.entries(key),
    entriesOfSlot: (key) => core.entriesOfSlot(key),
    reportEntryError: (key, entry, error, info) => core.reportEntryError(key, entry, error, info),
    specOf: (key) => core.specDynamic(key),
    isLive: (entry) => core.isLive(entry),
    storeOf: () => undefined,
    sessions: {
      list: constantObservable([]),
      provideInfo: constantObservable(emptySessionInfo)
    },
    workspaces: {
      list: constantObservable([])
    }
  }

  return {
    render: (owner) => renderer.renderRoot(host, owner),
    snapshot: () => core.snapshot('root')
  }
}

export function WorkbenchSlotPanels({ tools, ...owner }: WorkbenchSlotPanelsProps) {
  const runtime = useMemo(() => createWorkbenchSlotRuntime(tools), [tools])
  return runtime.render(owner)
}
