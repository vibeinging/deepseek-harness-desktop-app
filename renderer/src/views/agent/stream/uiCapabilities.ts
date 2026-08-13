import type { ArtifactKind } from '@/layout/workstation/Workstation'

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'] as const
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'] as const
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac'] as const
export const CODE_EXTENSIONS = ['.py', '.js', '.ts', '.sql', '.sh', '.json'] as const
export const TABLE_EXTENSIONS = ['.csv', '.xls', '.xlsx', '.parquet'] as const

export const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

export type AttachmentPreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'folder'

function hasKnownExtension(path: string, extensions: readonly string[]) {
  const clean = path.split(/[?#]/)[0]?.toLowerCase() || ''
  return extensions.some((ext) => clean.endsWith(ext))
}

export function artifactKindForPath(path: string): ArtifactKind {
  if (hasKnownExtension(path, CODE_EXTENSIONS)) return 'code'
  if (hasKnownExtension(path, TABLE_EXTENSIONS)) return 'table'
  if (hasKnownExtension(path, IMAGE_EXTENSIONS)) return 'image'
  return 'file'
}

function base64UrlEncode(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function imageSrcFromPath(raw: string) {
  const value = raw.trim()
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value
  const path = value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
  if (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) return `dsh-file://local/${base64UrlEncode(path)}`
  return value
}

export type LocalMediaKind = 'video' | 'audio'

export function localMediaKindForPath(path: string): LocalMediaKind | null {
  if (hasKnownExtension(path, VIDEO_EXTENSIONS)) return 'video'
  if (hasKnownExtension(path, AUDIO_EXTENSIONS)) return 'audio'
  return null
}

export function attachmentPreviewKind({
  path = '',
  mimeType = '',
  isDir = false
}: {
  path?: string
  mimeType?: string
  isDir?: boolean
}): AttachmentPreviewKind {
  if (isDir) return 'folder'
  const mime = mimeType.trim().toLowerCase()
  if (mime.startsWith('image/') || hasKnownExtension(path, IMAGE_EXTENSIONS)) return 'image'
  if (mime.startsWith('video/') || hasKnownExtension(path, VIDEO_EXTENSIONS)) return 'video'
  if (mime.startsWith('audio/') || hasKnownExtension(path, AUDIO_EXTENSIONS)) return 'audio'
  if (mime === 'application/pdf' || hasKnownExtension(path, ['.pdf'])) return 'pdf'
  return 'file'
}

export function mediaSrcFromPath(raw: string) {
  const value = raw.trim()
  if (/^https?:\/\//i.test(value) || /^data:(?:video|audio)\//i.test(value) || value.startsWith('dsh-file://')) {
    return value
  }
  const path = value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
  if (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) return `dsh-file://local/${base64UrlEncode(path)}`
  return value
}

export function isRenderableMediaSrc(src: string, kind: LocalMediaKind) {
  return (
    src.startsWith('dsh-file://local/') ||
    new RegExp(`^data:${kind}/[a-z0-9.+-]+;base64,`, 'i').test(src) ||
    /^https:\/\//i.test(src) ||
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(src)
  )
}

export function isRenderableImageSrc(src: string) {
  return (
    src.startsWith('dsh-file://') ||
    /^https?:\/\//i.test(src) ||
    /^data:image\//i.test(src) ||
    hasKnownExtension(src, IMAGE_EXTENSIONS)
  )
}
