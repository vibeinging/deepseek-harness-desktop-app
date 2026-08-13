import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const centerSource = readFileSync(fileURLToPath(new URL('./AutomationCenter.tsx', import.meta.url)), 'utf8')
const styleSource = readFileSync(fileURLToPath(new URL('./AutomationCenter.module.scss', import.meta.url)), 'utf8')
const workstationSource = readFileSync(
  fileURLToPath(new URL('../../layout/workstation/Workstation.tsx', import.meta.url)),
  'utf8'
)

describe('agent automation center layout contract', () => {
  it('keeps the scheduled-task surface in the primary navigation', () => {
    expect(workstationSource).toContain("useState<'runs' | 'trace'>('runs')")
    expect(workstationSource).not.toContain('data-workstation-view="automations"')
    expect(centerSource).toContain('data-automation-center')
    expect(centerSource).toContain('data-scheduled-tasks-page')
    expect(centerSource).toContain('data-automation-create-open')
    expect(centerSource).toContain('data-scheduled-task-form')
    expect(centerSource).toContain('data-scheduled-task-id')
    expect(centerSource).toContain('listAgentAutomations')
    expect(centerSource).toContain('listAgentAutomationRuns')
  })

  it('offers templates and the Codex-hosted local automation boundary', () => {
    expect(centerSource).toContain("id: 'daily-brief'")
    expect(centerSource).toContain("id: 'metric-anomaly'")
    expect(centerSource).toContain("id: 'data-readiness'")
    expect(centerSource).toContain("{ value: 'once', label: '运行一次' }")
    expect(centerSource).toContain("{ value: 'rrule', label: '自定义重复规则' }")
    expect(centerSource).toContain("{ value: 'event', label: '本地事件触发' }")
    expect(centerSource).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone')
    expect(centerSource).toContain('恢复后补跑一次')
    expect(centerSource).toContain('仅结果变化时提醒')
    expect(centerSource).toContain('固定使用的 Skill')
    expect(centerSource).toContain('每次新建独立对话')
    expect(centerSource).toContain('DSH、系统沙箱和自动审查')
    expect(centerSource).not.toContain('Runner 禁网')
    expect(centerSource).toContain('label="运行项目"')
    expect(centerSource).toContain('label="运行模型"')
    expect(centerSource).toContain('label="推理强度"')
    expect(centerSource).toContain('getAgentModel')
    expect(centerSource).toContain('去设置模型')
    expect(centerSource).toContain('运行历史')
    expect(centerSource).toContain('markAllAgentAutomationRunsRead')
    expect(styleSource).toContain('grid-template-columns: minmax(270px, 32%) minmax(0, 1fr)')
    expect(styleSource).toContain('@container (max-width: 760px)')
  })
})
