import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider, useLocation, useOutlet } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentWorkspaceRoute, { resolveAgentShellRouteContent } from './AgentWorkspaceRoute'

function SharedShellFixture() {
  const location = useLocation()
  const routeContent = resolveAgentShellRouteContent(location.pathname, useOutlet())

  return (
    <main>
      {routeContent ?? <section data-agent-conversation>conversation</section>}
    </main>
  )
}

function renderRoute(pathname: string) {
  const router = createMemoryRouter([
    {
      Component: SharedShellFixture,
      children: [{ path: '/agent', Component: AgentWorkspaceRoute }]
    }
  ], { initialEntries: [pathname] })

  return renderToStaticMarkup(<RouterProvider router={router} />)
}

describe('Agent workspace route content', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the built-in conversation surface for /agent without an empty-leaf warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(renderRoute('/agent')).toContain('data-agent-conversation')
    expect(warn.mock.calls.flat().join('\n')).not.toContain('Matched leaf route')
  })
})
