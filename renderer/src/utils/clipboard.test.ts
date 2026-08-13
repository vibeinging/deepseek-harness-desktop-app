import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from './clipboard'

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the trusted Electron system clipboard before browser fallbacks', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', { electronAPI: { writeClipboardText } })
    vi.stubGlobal('navigator', {})

    await expect(copyToClipboard('真实回答')).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('真实回答')
  })
})
