import type { ReactNode } from 'react'

export function isAgentWorkspacePath(pathname: string) {
  return pathname === '/agent' || pathname === '/agent/'
}

export function resolveAgentShellRouteContent(pathname: string, outlet: ReactNode) {
  return isAgentWorkspacePath(pathname) ? null : outlet
}

/**
 * Explicit leaf for the built-in conversation workspace.
 * AgentPage renders the conversation surface itself; this component keeps the
 * React Router leaf valid without replacing that built-in content.
 */
export default function AgentWorkspaceRoute() {
  return null
}
