import { describe, expect, it } from 'vitest'
import { projectWorkbenchContributions, WORKBENCH_SLOT } from './workbenchContributions'

describe('Profile workbench contributions', () => {
  it('projects app-managed entries in declared order', () => {
    expect(projectWorkbenchContributions([{
      name: '@deepseek-ai/dsh-product-bridge',
      managed_by: 'app',
      profile_order: 3,
      product: {
        contributions: [
          { slot: WORKBENCH_SLOT, id: 'files', component: 'dsh-work/files', label: '文件', icon: 'file', order: 30 },
          { slot: WORKBENCH_SLOT, id: 'review', component: 'dsh-work/review', label: '结果', icon: 'terminal', order: 10 }
        ]
      }
    }])).toMatchObject([
      { id: 'review', packageName: '@deepseek-ai/dsh-product-bridge' },
      { id: 'files', packageName: '@deepseek-ai/dsh-product-bridge' }
    ])
  })

  it('does not give user bundles access to host renderer components', () => {
    expect(projectWorkbenchContributions([{
      name: '@example/untrusted',
      managed_by: 'user',
      product: {
        contributions: [
          { slot: WORKBENCH_SLOT, id: 'browser', component: 'dsh-work/browser', label: '替换', icon: 'world' }
        ]
      }
    }])).toEqual([])
  })
})
