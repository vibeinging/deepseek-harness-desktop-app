import type { AgentTurnInput } from '@/api/agent'
import type { Attachment } from './ComposerActions'

const VISION_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const
export const VISION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export function isVisionImagePath(path: string) {
  const clean = String(path || '').split(/[?#]/)[0]?.toLowerCase() || ''
  return VISION_IMAGE_EXTENSIONS.some((extension) => clean.endsWith(extension))
}

export function isImageAttachment(attachment: Attachment) {
  if (attachment.isDir) return false
  if (VISION_IMAGE_TYPES.includes(String(attachment.mimeType || '').toLowerCase() as typeof VISION_IMAGE_TYPES[number])) return true
  return isVisionImagePath(attachment.path)
}

export function buildAgentTurnInput(text: string, attachments: Attachment[] = []): AgentTurnInput[] {
  return [
    { type: 'text', text },
    ...attachments
      .filter(isImageAttachment)
      .map((attachment) => ({ type: 'localImage' as const, path: attachment.path })),
  ]
}
