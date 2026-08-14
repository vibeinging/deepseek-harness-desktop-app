import { useEffect, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useDshClientHost } from '@/dsh-client/DshClientHost'
import {
  WORKBENCH_SLOT,
  type WorkbenchContribution
} from './workbenchContributions'
import type { WorkbenchTab } from './workbenchTabs'
import styles from './agent.module.scss'

export interface WorkbenchToolOwner {
  active: WorkbenchTab | null
  renderContribution: (tool: WorkbenchContribution) => ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'agent.workbench.tool': {
      kind: 'list'
      scope: 'root'
      owner: WorkbenchToolOwner
    }
  }
}

interface WorkbenchSlotPanelsProps extends WorkbenchToolOwner {
  tools: readonly WorkbenchContribution[]
  opened: readonly WorkbenchTab[]
}

type WorkbenchSlotRegistrar = Pick<ClientContext['slots'], 'register'>
type WorkbenchPanelProps = PropsRuntime<typeof WORKBENCH_SLOT>
type WorkbenchPanelComponent = (props: WorkbenchPanelProps) => ReactNode

function WorkbenchToolPanelView({
  tool,
  active,
  renderContribution
}: WorkbenchToolOwner & { tool: WorkbenchContribution }) {
  return (
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
  )
}

function createWorkbenchPanel(tool: WorkbenchContribution): WorkbenchPanelComponent {
  return function WorkbenchToolPanel(props) {
    return <WorkbenchToolPanelView tool={tool} {...props} />
  }
}

/** Register one Profile product roster into the active DSH Client Slot fiber. */
export function registerWorkbenchContributions(
  slots: WorkbenchSlotRegistrar,
  tools: readonly WorkbenchContribution[]
): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const tool of tools) {
      disposers.push(slots.register({
        name: WORKBENCH_SLOT,
        id: tool.id,
        order: tool.order,
        label: tool.label
      }, createWorkbenchPanel(tool)))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function StandaloneWorkbenchPanels({
  tools,
  opened,
  active,
  renderContribution
}: WorkbenchSlotPanelsProps) {
  return (
    <div className={styles.workbenchTabPanels} data-workbench-slot-runtime="standalone">
      {opened.map((tab) => {
        const tool = tools.find((candidate) => candidate.id === tab)
        if (!tool) return null
        return (
          <WorkbenchToolPanelView
            key={tab}
            tool={tool}
            active={active}
            renderContribution={renderContribution}
          />
        )
      })}
    </div>
  )
}

/** Render workbench contributions through the root-authorized DSH renderSlot face. */
export function WorkbenchSlotPanels({ tools, opened, ...owner }: WorkbenchSlotPanelsProps) {
  const host = useDshClientHost()

  useEffect(() => {
    if (!host) return
    return registerWorkbenchContributions(host.slots, tools)
  }, [host, tools])

  if (!host) {
    return <StandaloneWorkbenchPanels tools={tools} opened={opened} {...owner} />
  }

  const renderSlot: PropsRenderSlots<typeof WORKBENCH_SLOT>['renderSlot'] = host.renderSlot
  return (
    <div className={styles.workbenchTabPanels} data-workbench-slot-runtime="dsh-client">
      {opened.map((tab) => renderSlot(WORKBENCH_SLOT, owner, { only: tab }))}
    </div>
  )
}
