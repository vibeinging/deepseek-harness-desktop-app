import { describe, expect, it } from 'vitest'
import { createWorkbenchSlotRuntime } from './workbenchSlotRuntime'
import type { WorkbenchContribution } from './workbenchContributions'

const tools: WorkbenchContribution[] = [
  {
    slot: 'agent.workbench.tool',
    id: 'files',
    component: 'dsh-work/files',
    label: '文件',
    icon: 'file',
    order: 30,
    packageName: '@deepseek-ai/dsh-product-bridge'
  },
  {
    slot: 'agent.workbench.tool',
    id: 'review',
    component: 'dsh-work/review',
    label: '结果',
    icon: 'terminal',
    order: 10,
    packageName: '@deepseek-ai/dsh-product-bridge'
  }
]

describe('DSH workbench Slot runtime', () => {
  it('assembles the Profile roster under the official root Slot lifecycle', () => {
    const [root] = createWorkbenchSlotRuntime(tools).snapshot()

    expect(root).toMatchObject({
      name: 'root',
      kind: 'single',
      scope: 'root',
      occupants: [{ registrant: 'dsh-work', active: true }]
    })
    expect(root.children).toEqual([{
      name: 'agent.workbench.tool',
      kind: 'list',
      scope: 'root',
      declaredBy: 'an entry in "root" (dsh-work)',
      occupants: [
        {
          registrant: '@deepseek-ai/dsh-product-bridge',
          id: 'review',
          order: 10,
          priority: 0,
          active: true
        },
        {
          registrant: '@deepseek-ai/dsh-product-bridge',
          id: 'files',
          order: 30,
          priority: 0,
          active: true
        }
      ],
      children: []
    }])
  })
})
