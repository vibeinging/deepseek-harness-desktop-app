import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })
})

import { appearanceFieldPatch } from './AppearancePanel'
import type { BrandAppearance } from '@/theme/skins/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mergeLikeAppearanceStore(
  current: BrandAppearance,
  patch: Partial<BrandAppearance>
): BrandAppearance {
  return {
    ...current,
    ...patch,
    ...((current.dark || patch.dark)
      ? { dark: { ...(current.dark || {}), ...(patch.dark || {}) } }
      : {})
  }
}

describe('AppearancePanel async field patches', () => {
  it('does not overwrite a dark field changed while a local image is being copied', async () => {
    let current: BrandAppearance = { dark: { panelOpacity: 70 } }
    const upload = deferred<string>()
    const savingImage = upload.promise.then((url) => {
      current = mergeLikeAppearanceStore(current, appearanceFieldPatch('dark', 'bgImage', url))
    })

    current = mergeLikeAppearanceStore(
      current,
      appearanceFieldPatch('dark', 'panelOpacity', 86)
    )
    upload.resolve('dsh-skin-asset://0123456789abcdef01234567.webp')
    await savingImage

    expect(current.dark).toEqual({
      panelOpacity: 86,
      bgImage: 'dsh-skin-asset://0123456789abcdef01234567.webp'
    })
  })
})
