/**
 * Clipboard utility logic.
 */
import { notifications } from '@mantine/notifications'
import { t } from '@/lang'

// Copy to clipboard with fallback support.
export const copyToClipboard = async (text: any): Promise<boolean> => {
  // Option 1: use modern Clipboard API.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('Clipboard API 失败，使用 fallback:', err)
    }
  }

  // Option 2: use legacy execCommand fallback.
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch (err) {
    console.error('复制失败（两种方法都失败）:', err)
    return false
  }
}

// Copy SQL.
export const copySQL = async (sql: any): Promise<void> => {
  const success = await copyToClipboard(sql)
  if (success) {
    notifications.show({ color: 'green', message: t('common.sqlCopied') })
  } else {
    notifications.show({ color: 'red', message: t('common.copyFailedPermission') })
  }
}

// Copy code block.
export const copyCodeBlock = async (code: any): Promise<void> => {
  const success = await copyToClipboard(code)
  if (success) {
    notifications.show({ color: 'green', message: t('common.codeCopied') })
  } else {
    notifications.show({ color: 'red', message: t('common.copyFailedPermission') })
  }
}
