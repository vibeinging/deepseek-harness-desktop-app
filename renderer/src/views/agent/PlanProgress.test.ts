import { describe, expect, it } from 'vitest'
import type { PlanStep } from '@/layout/workstation/Workstation'
import {
  normalizePlanSteps,
  planStepWindow,
  summarizePlanProgress
} from './planState'

describe('plan state projection', () => {
  it('keeps native statuses while normalizing them for display', () => {
    expect(normalizePlanSteps(JSON.stringify([
      { step: '检查目录', status: 'completed' },
      { step: '汇总发现', status: 'in_progress', detail: '读取配置' },
      { step: '核对结果', status: 'failed' },
      { step: '候选分支', status: 'skipped' },
      { step: '给出建议', status: 'interrupted' }
    ]))).toEqual([
      { title: '检查目录', detail: undefined, state: 'done' },
      { title: '汇总发现', detail: '读取配置', state: 'running' },
      { title: '核对结果', detail: undefined, state: 'failed' },
      { title: '候选分支', detail: undefined, state: 'skipped' },
      { title: '给出建议', detail: undefined, state: 'interrupted' }
    ])
  })

  it('reports failed, skipped and interrupted terminal steps without calling them pending', () => {
    expect(summarizePlanProgress([
      { title: '查询数据', state: 'done' },
      { title: '业务校验', state: 'failed' },
      { title: '备用来源', state: 'skipped' },
      { title: '最终回答', state: 'interrupted' }
    ], false)).toMatchObject({
      completed: 1,
      failed: 1,
      skipped: 1,
      interrupted: 1,
      remaining: 0,
      title: '计划未完成',
      label: '1/4 已完成 · 1 项失败 · 1 项跳过 · 1 项停止'
    })
  })

  it('animates an in-progress step only while the Turn is running', () => {
    const steps: PlanStep[] = [
      { title: '检查目录', state: 'done' },
      { title: '汇总发现', state: 'running' },
      { title: '给出建议', state: 'todo' }
    ]
    expect(summarizePlanProgress(steps, true)).toMatchObject({
      active: true,
      activeIndex: 1,
      title: '正在执行计划',
      label: '1/3 已完成 · 2 项未完成'
    })
    expect(summarizePlanProgress(steps, false)).toMatchObject({
      active: false,
      activeIndex: 1,
      title: '计划进度',
      label: '1/3 已完成 · 2 项未完成'
    })
  })

  it('hides empty plans and reports a fully completed plan', () => {
    expect(normalizePlanSteps('{broken')).toEqual([])
    expect(summarizePlanProgress([
      { title: '检查目录', state: 'done' },
      { title: '汇总发现', state: 'done' }
    ], false)).toMatchObject({
      completed: 2,
      remaining: 0,
      active: false,
      title: '计划已完成',
      label: '2/2 已完成'
    })
  })

  it('keeps the active step visible when a long plan is collapsed', () => {
    const steps: PlanStep[] = Array.from({ length: 10 }, (_, index) => ({
      title: `步骤 ${index + 1}`,
      state: index < 6 ? 'done' : index === 7 ? 'running' : 'todo'
    }))
    expect(planStepWindow(steps, false)).toEqual({
      start: 4,
      end: 10,
      hiddenBefore: 4,
      hiddenAfter: 0
    })
    expect(planStepWindow(steps, true)).toEqual({
      start: 0,
      end: 10,
      hiddenBefore: 0,
      hiddenAfter: 0
    })
  })
})
