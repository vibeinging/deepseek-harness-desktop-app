import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { describe, expect, it } from 'vitest'
import { createDshThemePresenter } from './dshRuntimeTheme'

class StyleStub {
  readonly values = new Map<string, string>()
  colorScheme = ''

  setProperty(name: string, value: string) {
    this.values.set(name, value)
  }

  removeProperty(name: string) {
    this.values.delete(name)
    if (name === 'color-scheme') this.colorScheme = ''
    return ''
  }
}

class ElementStub {
  readonly style = new StyleStub()
  readonly attributes = new Set<string>()

  toggleAttribute(name: string, force?: boolean) {
    if (force) this.attributes.add(name)
    else this.attributes.delete(name)
    return this.attributes.has(name)
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
}

function snapshot(colorScheme: 'light' | 'dark', tokens: Record<string, string>): ThemeSnapshot {
  return {
    preference: colorScheme,
    active: { id: colorScheme, colorScheme, tokens },
    themes: [],
    revision: 1
  }
}

function documentStub() {
  const body = new ElementStub()
  const documentElement = new ElementStub()
  return {
    body,
    documentElement,
    documentRef: { body, documentElement } as unknown as Document
  }
}

describe('DSH ThemeRuntime document presenter', () => {
  it('replaces stale snapshot tokens while preserving unrelated inline styles', () => {
    const { body, documentRef } = documentStub()
    body.style.setProperty('--product-owned', '#123456')
    const presenter = createDshThemePresenter(documentRef)

    presenter.present(snapshot('light', {
      '--dsw-alias-bg-base': '#ffffff',
      '--dsw-alias-label-primary': '#111111'
    }))
    presenter.present(snapshot('light', { '--dsw-alias-bg-base': '#f7f8fa' }))

    expect(body.style.values.get('--dsw-alias-bg-base')).toBe('#f7f8fa')
    expect(body.style.values.has('--dsw-alias-label-primary')).toBe(false)
    expect(body.style.values.get('--product-owned')).toBe('#123456')
  })

  it('presents the resolved scheme and removes only owned state on dispose', () => {
    const { body, documentElement, documentRef } = documentStub()
    body.style.setProperty('--product-owned', '#123456')
    const presenter = createDshThemePresenter(documentRef)

    presenter.present(snapshot('dark', { '--dsw-alias-border-l2': '#333333' }))

    expect(documentElement.style.colorScheme).toBe('dark')
    expect(body.attributes.has('data-ds-dark-theme')).toBe(true)

    presenter.dispose()

    expect(documentElement.style.colorScheme).toBe('')
    expect(body.attributes.has('data-ds-dark-theme')).toBe(false)
    expect(body.style.values.has('--dsw-alias-border-l2')).toBe(false)
    expect(body.style.values.get('--product-owned')).toBe('#123456')
  })
})
