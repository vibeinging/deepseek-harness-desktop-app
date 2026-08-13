import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationSource = readFileSync(
  fileURLToPath(new URL('./AgentConversation.tsx', import.meta.url)),
  'utf8',
)
const shellSource = readFileSync(
  fileURLToPath(new URL('./AgentShell.tsx', import.meta.url)),
  'utf8',
)
const modelSelectorSource = readFileSync(
  fileURLToPath(new URL('./ConversationModelSelector.tsx', import.meta.url)),
  'utf8',
)

describe('dsh-work conversation product boundary', () => {
  it('uses one dsh-work conversation surface without a DSH Web iframe or technology switch', () => {
    expect(conversationSource).toContain('return <DshWorkAgentConversation {...props} />')
    expect(conversationSource).not.toContain('DshNativeConversationSurface')
    expect(conversationSource).not.toContain('DSH 原生界面')
    expect(conversationSource).not.toContain('兼容界面')
    expect(conversationSource).not.toContain('<iframe')
  })

  it('keeps product tools in the existing right workbench', () => {
    expect(shellSource).toContain('projectWorkbenchContributions')
    expect(shellSource).toContain('WorkbenchSlotPanels')
    expect(shellSource).toContain('workbenchTools.map')
    expect(shellSource).toContain('data-workbench-tab={tool.id}')
    expect(shellSource).not.toContain('onOpenWorkbenchTab=')
  })

  it('lets DSH Host enforce image capability when the rc.2 catalog leaves it unknown', () => {
    expect(modelSelectorSource).toContain("return model?.source === 'dsh' ? null : false")
    expect(modelSelectorSource).toContain('supportsImageInput: imageInputCapability(initial)')
    expect(modelSelectorSource).toContain('supportsImageInput: imageInputCapability(model)')
    expect(conversationSource).toContain("modelRuntime?.supportsImageInput === false")
    expect(conversationSource).toContain('图片将通过 DSH 发送；如果当前模型不支持，DSH 会拒绝本次发送')
  })
})
