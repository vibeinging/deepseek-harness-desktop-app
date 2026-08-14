import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('Codex collaboration mode UI', () => {
  it('clearly distinguishes direct action from analysis-only planning in the composer', () => {
    const conversation = [read('./AgentConversation.tsx'), read('./conversation/AssistantContent.tsx')].join('\n')
    const picker = read('./CollaborationModePicker.tsx')

    expect(conversation).toContain('<CollaborationModePicker')
    expect(conversation).toContain('collaborationMode: collaborationModeRef.current')
    expect(conversation).toContain('state?.projections?.plan')
    expect(conversation).toContain('setDshSessionPlanMode(projectId, currentSessionId, next)')
    expect(conversation).not.toContain('persistConversationCollaborationMode')
    expect(picker).toContain("value: 'default'")
    expect(picker).toContain("value: 'plan'")
    expect(picker).toContain("label: '直接处理'")
    expect(picker).toContain('完成修改、运行命令等操作')
    expect(picker).toContain("label: '制定计划'")
    expect(picker).toContain('只调查并给出方案，不修改任何内容')
    expect(picker).toContain('选择本轮工作方式')
    expect(picker).not.toContain("label: '执行'")
  })

  it('renders update_plan in the plan window and does not force unfinished steps to done', () => {
    const conversation = [read('./AgentConversation.tsx'), read('./conversation/AssistantContent.tsx')].join('\n')
    const progress = read('./PlanStatusFloat.tsx')
    const shell = read('./AgentShell.tsx')
    const reducer = read('./stream/reducer.ts')

    expect(conversation).not.toContain('PlanProgress')
    expect(progress).toContain('className={styles.planFloatSteps}')
    expect(progress).toContain("data-active={active ? 'true' : 'false'}")
    expect(progress).toContain('role="status" aria-live="polite"')
    expect(progress).toContain('aria-current={active ? \'step\' : undefined}')
    expect(shell).toContain('PlanStatusFloat')
    expect(reducer).not.toContain('completeOpenPlanSteps')
  })
})
