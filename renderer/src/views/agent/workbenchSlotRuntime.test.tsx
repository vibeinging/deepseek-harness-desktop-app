import { describe, expect, it } from 'vitest'
import {
  SlotCore,
  type PropsRenderSlots,
  type PropsRuntime,
  type StoredEntry
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { projectDshSettingsSections } from '@/dsh-client/DshClientHost'
import { registerWorkbenchContributions } from './workbenchSlotRuntime'
import type { WorkbenchContribution } from './workbenchContributions'
import { WORKBENCH_SLOT } from './workbenchContributions'

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
  it('registers the Profile roster under the dsh-work standard root Slots', () => {
    const core = new SlotCore()
    type RootSlot = typeof WORKBENCH_SLOT
      | 'sidebar'
      | 'conversation'
      | 'details'
      | 'settings.section'
      | 'shell.overlay'
    function TestRoot({ renderSlot }: PropsRuntime<'root'> & PropsRenderSlots<RootSlot>) {
      return renderSlot(WORKBENCH_SLOT, {
        active: null,
        renderContribution: () => null
      })
    }
    core.register({
      name: 'root',
      registrant: '@deepseek-ai/dsh-work-shell',
      priority: -100,
      children: {
        'agent.workbench.tool': { kind: 'list', scope: 'root' },
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'settings.section': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' }
      }
    }, TestRoot)
    registerWorkbenchContributions({ register: core.register.bind(core) }, tools)
    const [root] = core.snapshot('root')

    expect(root).toMatchObject({
      name: 'root',
      kind: 'single',
      scope: 'root',
      occupants: [{ registrant: '@deepseek-ai/dsh-work-shell', priority: -100, active: true }]
    })
    expect(root.children.map((child) => child.name)).toEqual([
      'agent.workbench.tool',
      'sidebar',
      'conversation',
      'details',
      'settings.section',
      'shell.overlay'
    ])
    expect(root.children.find((child) => child.name === WORKBENCH_SLOT)).toEqual({
      name: 'agent.workbench.tool',
      kind: 'list',
      scope: 'root',
      declaredBy: 'an entry in "root" (@deepseek-ai/dsh-work-shell)',
      occupants: [
        {
          id: 'review',
          order: 10,
          priority: 0,
          active: true
        },
        {
          id: 'files',
          order: 30,
          priority: 0,
          active: true
        }
      ],
      children: []
    })
  })

  it('projects Profile settings entries without duplicating App-owned pages', () => {
    const entry = (id: string, order: number, label: string, registrant: string, priority = 0): StoredEntry => ({
      component: () => null,
      options: { id, order, label, priority },
      registrant
    })
    const sections = projectDshSettingsSections([
      entry('general', 0, '通用设置', '@deepseek-ai/dsh-client-ui-settings-general'),
      entry('models', 10, '模型', '@deepseek-ai/dsh-client-ui-settings-models'),
      entry('plugins', 15, '插件', '@deepseek-ai/dsh-client-ui-settings-plugins'),
      entry('agent-presets', 20, 'Agent 预设', '@deepseek-ai/dsh-client-ui-agent-preset'),
      entry('better-sidebar', 40, '侧边栏', 'dsh-better-sidebar'),
      entry('better-sidebar', 40, '旧侧边栏', 'old-sidebar', 10)
    ])

    expect(sections).toEqual([
      {
        id: 'agent-presets',
        label: 'Agent 预设',
        order: 20,
        registrant: '@deepseek-ai/dsh-client-ui-agent-preset'
      },
      {
        id: 'better-sidebar',
        label: '侧边栏',
        order: 40,
        registrant: 'dsh-better-sidebar'
      }
    ])
  })
})
