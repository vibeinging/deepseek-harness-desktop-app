export interface AgentActionView {
  target: string
  label: string
  description: string
  href: string | null
  externalHost: string | null
}

const ACTION_TARGET_HREF: Record<string, string> = {
  'project.settings.datasource': '#database'
}

export function safeExternalActionUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol === 'https:') return url
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    return url.protocol === 'http:' && localHost ? url : null
  } catch {
    return null
  }
}

export function resolveAgentAction(payload: unknown): AgentActionView {
  const action = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const target = String(action.target || '')
  const externalUrl = target === 'mcp_authorization' ? safeExternalActionUrl(action.href) : null
  return {
    target,
    label: String(action.label || '前往设置'),
    description: String(action.description || '完成所需设置后即可继续。'),
    href: externalUrl?.toString() || ACTION_TARGET_HREF[target] || null,
    externalHost: externalUrl?.host || null
  }
}
