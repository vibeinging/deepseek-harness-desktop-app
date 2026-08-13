import { describe, expect, it } from 'vitest'
import en from '@/lang/en'
import zh from '@/lang/zh'
import i18n from '@/lang'

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

describe('skin manager translations', () => {
  it('keeps the full zh/en skin copy tree in sync', () => {
    expect(leafPaths(en.agentSkins).sort()).toEqual(leafPaths(zh.agentSkins).sort())
  })

  it('provides localized user-facing copy instead of falling back to technical keys', () => {
    expect(en.agentSkins.settings.pageTitle).toBe('Themes and appearance')
    expect(zh.agentSkins.settings.pageTitle).toBe('主题与外观')
    expect(en.agentSkins.appearance.resetConfirm).not.toBe(zh.agentSkins.appearance.resetConfirm)
    expect(en.agentSkins.notice.importFailed).toContain('{message}')
  })

  it('interpolates runtime values with the configured single-brace delimiters', async () => {
    const previousLanguage = i18n.language
    try {
      await i18n.changeLanguage('zh')
      expect(i18n.t('agentSkins.notice.importFailed', { message: '磁盘只读' }))
        .toBe('导入失败：磁盘只读')
      await i18n.changeLanguage('en')
      expect(i18n.t('agentSkins.manager.currentCard', { name: 'Ocean' }))
        .toBe('Current theme: Ocean')
    } finally {
      await i18n.changeLanguage(previousLanguage || 'zh')
    }
  })
})
