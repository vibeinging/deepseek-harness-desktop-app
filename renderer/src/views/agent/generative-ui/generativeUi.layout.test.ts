import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('./GenerativeUiBlock.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./GenerativeUi.module.scss', import.meta.url), 'utf8')
const conversation = [
  readFileSync(new URL('../AgentConversation.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('../conversation/ConversationTurns.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('../conversation/AssistantContent.tsx', import.meta.url), 'utf8')
].join('\n')

describe('Generative UI host interaction and layout contract', () => {
  it('keeps the Host identity and ordinary-message notice outside the model Schema', () => {
    expect(component).toContain('Agent 生成界面')
    expect(component).toContain('提交后将作为普通对话消息发送')
    expect(component).not.toContain("type=\"password\"")
    expect(component).not.toContain("type=\"file\"")
  })

  it('uses semantic form, table, chart fallback and image privacy controls', () => {
    expect(component).toContain('<form')
    expect(component).toContain('htmlFor={controlId}')
    expect(component).toContain('scope="col"')
    expect(component).toContain('查看图表数据')
    expect(component).toContain("referrerPolicy={/^https:\\/\\//i.test(src) ? 'no-referrer' : undefined}")
    expect(component).toContain('aria-describedby={summaryId}')
  })

  it('uses container queries, local table scrolling and visible focus without hiding mobile actions', () => {
    expect(styles).toContain('@container (max-width: 760px)')
    expect(styles).toContain('@container (max-width: 480px)')
    expect(styles).toMatch(/\.tableRegion\s*\{[^}]*overflow: auto/s)
    expect(styles).toContain('&:focus-visible')
    expect(styles).toContain('prefers-reduced-motion')
  })

  it('only enables actions for a completed turn while the conversation is idle', () => {
    expect(conversation).toContain('const canInteractGenerativeUi = completed && !busy && !actionPending')
    expect(conversation).toContain('if (busyRef.current) throw new Error')
    expect(conversation).toContain('await request')
    expect(conversation).toContain('renderGenerativeUi: true')
  })
})
