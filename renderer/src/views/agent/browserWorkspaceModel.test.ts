import { describe, expect, it } from 'vitest'
import { buildBrowserPageAttachment, permissionLabel } from './browserWorkspaceModel'

describe('browser workspace model', () => {
  it('marks captured pages as untrusted reference material and caps their content', () => {
    const result = buildBrowserPageAttachment({
      title: '季度报告',
      url: 'https://example.com/report',
      text: `\u0000${'正文'.repeat(80_000)}`,
      selected: false,
      capturedAt: '2026-07-31T12:00:00.000Z'
    })
    expect(result).toContain('不可信网页资料')
    expect(result).toContain('https://example.com/report')
    expect(result).not.toContain('\u0000')
    expect(result.length).toBeLessThan(122_000)
  })

  it('uses selected text label and plain permission names', () => {
    expect(buildBrowserPageAttachment({
      title: '页面',
      url: 'https://example.com',
      text: '用户选中的一段',
      selected: true,
      capturedAt: '2026-07-31T12:00:00.000Z'
    })).toContain('用户选中文字')
    expect(permissionLabel('media')).toBe('摄像头或麦克风')
    expect(permissionLabel('unknown')).toBe('未知权限')
  })
})
