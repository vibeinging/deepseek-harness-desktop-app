import { describe, expect, it } from 'vitest'
import {
  attachmentPreviewKind,
  isRenderableMediaSrc,
  localMediaKindForPath,
  mediaSrcFromPath
} from './uiCapabilities'

describe('local media UI capabilities', () => {
  it('classifies previewable attachments from either MIME type or extension', () => {
    expect(attachmentPreviewKind({ path: '/workspace/photo.gif' })).toBe('image')
    expect(attachmentPreviewKind({ path: '/workspace/clip', mimeType: 'video/mp4' })).toBe('video')
    expect(attachmentPreviewKind({ path: '/workspace/voice.wav' })).toBe('audio')
    expect(attachmentPreviewKind({ path: '/workspace/report.PDF' })).toBe('pdf')
    expect(attachmentPreviewKind({ path: '/workspace/assets', isDir: true })).toBe('folder')
    expect(attachmentPreviewKind({ path: '/workspace/data.csv' })).toBe('file')
  })

  it('recognizes video and audio files without confusing ordinary files', () => {
    expect(localMediaKindForPath('/workspace/output.mp4')).toBe('video')
    expect(localMediaKindForPath('/workspace/voice.m4a?version=2')).toBe('audio')
    expect(localMediaKindForPath('/workspace/report.pdf')).toBeNull()
  })

  it('maps absolute media paths to the authorized desktop protocol', () => {
    const src = mediaSrcFromPath('/workspace/output.mp4')
    expect(src).toMatch(/^dsh-file:\/\/local\/[a-zA-Z0-9_-]+$/)
    expect(isRenderableMediaSrc(src, 'video')).toBe(true)
  })

  it('rejects unsafe media schemes while allowing HTTPS and loopback development URLs', () => {
    expect(isRenderableMediaSrc('javascript:alert(1)', 'video')).toBe(false)
    expect(isRenderableMediaSrc('https://cdn.example.com/output.mp4', 'video')).toBe(true)
    expect(isRenderableMediaSrc('http://127.0.0.1:3000/output.mp4', 'video')).toBe(true)
    expect(isRenderableMediaSrc('http://example.com/output.mp4', 'video')).toBe(false)
  })
})
