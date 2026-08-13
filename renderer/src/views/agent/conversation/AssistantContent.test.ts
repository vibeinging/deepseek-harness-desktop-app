import { describe, expect, it } from 'vitest'
import { visibleAgentError } from './AssistantContent'

describe('visibleAgentError', () => {
  it('replaces a stale DSH cwd conflict without exposing runtime ids or local paths', () => {
    const visible = visibleAgentError(
      'DSH session session-private 与工作目录 /Users/private/.dsh/runs/run/work 冲突，已停止以避免产生断裂历史',
    )

    expect(visible).toBe('会话已切换到新的 DSH 运行环境，请重新发送这条消息。')
    expect(visible).not.toContain('session-private')
    expect(visible).not.toContain('/Users/private')
  })

  it('keeps unrelated actionable errors unchanged', () => {
    expect(visibleAgentError('模型服务暂时不可用')).toBe('模型服务暂时不可用')
  })
})
