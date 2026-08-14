import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('chat message actions contract', () => {
  it('offers copy, edit, retry and branch actions on persisted messages', () => {
    const conversation = [read('./AgentConversation.tsx'), read('./conversation/ConversationTurns.tsx')].join('\n')
    const styles = read('./agent.module.scss')

    expect(conversation).toContain('data-message-action="copy-user"')
    expect(conversation).toContain('data-message-action="edit-user"')
    expect(conversation).toContain('data-message-action="copy-assistant"')
    expect(conversation).toContain('partitionAssistantDisplayBlocks(')
    expect(conversation).toContain('data-message-action="retry-assistant"')
    expect(conversation).toContain('data-message-action="branch-assistant"')
    expect(conversation).toContain('data-message-edit-panel')
    expect(conversation).toContain("runMessageAction('edit', target, text)")
    expect(conversation).toContain("runMessageAction('retry', target)")
    expect(conversation).toContain("runMessageAction('branch', target)")
    expect(styles).toContain('.messageActions')
    expect(styles).toContain('.messageEditPanel')
  })

  it('continues edit and retry in a new local session and keeps temporary chats immutable', () => {
    const conversation = read('./AgentConversation.tsx')
    const api = read('../../api/agent.ts')

    expect(conversation).toContain('if (!sourceSessionId || !messageId || effectiveBusy || temporary || messageActionPending)')
    expect(conversation).toContain('setSessionId(nextSessionId)')
    expect(conversation).toContain('sessionIdRef.current = nextSessionId')
    expect(conversation).toContain("mode === 'retry' && Array.isArray(draft.input)")
    expect(conversation).toContain('await dispatch(prompt, turnExtra)')
    expect(api).toContain('/messages/${pe(messageId)}/branch`')
  })

  it('persists the original turn request and forks at the DSH event boundary only', () => {
    const agentChat = read('../../../../server/src/app/chat/agent_chat.js')
    const messageActions = read('../../../../server/src/app/chat/message_actions.js')

    expect(agentChat).toContain('turn_request: {')
    expect(agentChat).toContain('turn_input: turnInput')
    expect(messageActions).toContain('const atSeq = Number(previousAssistant?.message_metadata?.dsh_last_seq)')
    expect(messageActions).toContain('client.request("session.fork", { sessionId: binding.dshSessionId, atSeq })')
    expect(messageActions).toContain('ensureDshWorkspaceSession(client, { cwd: binding.cwd })')
    expect(messageActions).not.toContain('thread/rollback')
    expect(messageActions).not.toContain('thread/resume')
  })
})
