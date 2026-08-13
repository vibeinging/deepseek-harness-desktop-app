import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const settingsSource = readFileSync(fileURLToPath(new URL('./AgentSettings.tsx', import.meta.url)), 'utf8')
const shellSource = readFileSync(fileURLToPath(new URL('./AgentShell.tsx', import.meta.url)), 'utf8')
const conversationSource = [
  './AgentConversation.tsx',
  './conversation/ConversationTurns.tsx',
  './conversation/AssistantContent.tsx'
].map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).join('\n')
const planFloatSource = readFileSync(fileURLToPath(new URL('./PlanStatusFloat.tsx', import.meta.url)), 'utf8')

describe('interaction and visibility settings', () => {
  it('describes reasoning as a display-only summary', () => {
    expect(settingsSource).toContain('label="显示思考摘要"')
    expect(settingsSource).toContain('只控制界面显示，不影响模型推理和用量')
    expect(settingsSource).not.toContain('label="显示思考过程"')
  })

  it('keeps plan details in the independent status window instead of the conversation body', () => {
    expect(shellSource).toContain('PlanStatusFloat')
    expect(shellSource).toContain('showPlanFloat && <PlanStatusFloat plan={wsPlan} running={running} />')
    expect(shellSource).toContain('showTodo={agentDisplaySettings.showTodo}')
    expect(conversationSource).toContain("(showTodo || block.type !== 'plan')")
    expect(conversationSource).not.toContain('PlanProgress')
    expect(conversationSource).toContain('prev.showTodo === next.showTodo')
    expect(planFloatSource).toContain('data-plan-float')
    expect(planFloatSource).toContain('className={styles.planFloatSteps}')
  })

  it('opens the right workbench only through explicit actions, not edge hover', () => {
    expect(shellSource).toContain('onClick={wsCollapsed ? expandWorkspace : collapseWorkspace}')
    expect(shellSource).toContain('setWsCollapsed(false)')
    expect(shellSource).not.toContain('wsPeeking')
    expect(shellSource).not.toContain('showWsOverlay')
    expect(shellSource).not.toContain('styles.asidePeek')
  })

  it('renders terminal approval and user-input cards without live controls', () => {
    expect(conversationSource).toContain('approvalInteractionState(b.title, b.metadata?.status, decision, turnStatus)')
    expect(conversationSource).toContain('userInputInteractionState(b.title, b.metadata?.status, turnStatus)')
    expect(conversationSource).toContain('prev.turnStatus === next.turnStatus')
    expect(conversationSource).toContain("state !== 'requested'")
    expect(conversationSource).toContain("interactionState === 'requested'")
    expect(conversationSource).toContain('问题已停止，不再接受回答')
  })

  it('projects the DSH-owned queue and mutates it only through the DSH protocol', () => {
    expect(conversationSource).toContain('getDshSessionProtocolState(projectId, selectedId)')
    expect(conversationSource).toContain('watchDshSessionProtocol(projectId, selectedId, controller.signal)')
    expect(conversationSource).toContain('if (localContentStreamSessionRef.current === selectedId) return')
    expect(conversationSource).toContain("state.queue.filter((item) => item.placement === 'queued')")
    expect(conversationSource).toContain("promptDshSession(projectId, sid")
    expect(conversationSource).toContain("updateDshSessionQueueItem(projectId, sid, item.id, { kind: 'steer' })")
    expect(conversationSource).not.toContain('loadConversationInputQueue(')
    expect(conversationSource).not.toContain('persistConversationInputQueue(')
  })
})
