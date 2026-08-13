/**
 * Clipboard utility functions.
 * Supports both HTTP and HTTPS environments.
 */

/**
 * Copy text to clipboard.
 * @param {string} text - Text to copy.
 * @returns {Promise<boolean>} - Whether copy succeeded.
 */
export const copyToClipboard = async (text: any): Promise<boolean> => {
  // Desktop builds should not depend on page permission or focus state. The
  // preload bridge only accepts calls from the trusted main renderer.
  const nativeWrite = (window as any)?.electronAPI?.writeClipboardText
  if (typeof nativeWrite === 'function') {
    try {
      return (await nativeWrite(String(text ?? ''))) === true
    } catch (err) {
      console.warn('原生剪贴板失败，使用网页 fallback:', err)
    }
  }

  // Option 1: use modern Clipboard API (only available in HTTPS).
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('Clipboard API 失败，使用 fallback:', err)
    }
  }

  // Option 2: use legacy execCommand fallback (works in HTTP).
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length) // Keep this compatible on mobile browsers.
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch (err) {
    console.error('复制失败:', err)
    return false
  }
}
