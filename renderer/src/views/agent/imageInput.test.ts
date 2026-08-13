import { describe, expect, it } from 'vitest'
import { buildAgentTurnInput, isImageAttachment, isVisionImagePath } from './imageInput'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const conversationSource = [
  './AgentConversation.tsx',
  './conversation/ConversationTurns.tsx',
  './conversation/AssistantContent.tsx'
].map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).join('\n')

describe('chat image input', () => {
  it('turns supported image attachments into localImage inputs in attachment order', () => {
    expect(buildAgentTurnInput('比较图片', [
      { path: '/tmp/one.PNG', name: 'one.PNG' },
      { path: '/tmp/data.csv', name: 'data.csv' },
      { path: '/tmp/two.webp', name: 'two.webp' },
      { path: '/tmp/paste', name: 'paste', mimeType: 'image/png' },
    ])).toEqual([
      { type: 'text', text: '比较图片' },
      { type: 'localImage', path: '/tmp/one.PNG' },
      { type: 'localImage', path: '/tmp/two.webp' },
      { type: 'localImage', path: '/tmp/paste' },
    ])
  })

  it('does not treat unsupported or directory paths as visual model input', () => {
    expect(isVisionImagePath('/tmp/animation.gif')).toBe(true)
    expect(isImageAttachment({ path: '/tmp/folder.png', name: 'folder.png', isDir: true })).toBe(false)
    expect(isImageAttachment({ path: '/tmp/paste', name: 'paste', mimeType: 'image/png' })).toBe(true)
  })

  it('keeps the exact managed image path on persisted user attachment previews', () => {
    expect(conversationSource).toContain('data-attachment-path={attachment.path}')
    expect(conversationSource).toContain('无法预览，仍可正常发送')
  })
})
