import { describe, expect, it } from 'vitest'
import { resolveAgentAction } from './actionBlock'

describe('agent action block', () => {
  it('maps the data-source prerequisite to current project settings', () => {
    expect(resolveAgentAction({
      target: 'project.settings.datasource',
      label: '添加数据源',
      description: '先添加数据源。'
    })).toEqual({
      target: 'project.settings.datasource',
      label: '添加数据源',
      description: '先添加数据源。',
      href: '#database',
      externalHost: null
    })
  })

  it('does not invent navigation for an unknown action target', () => {
    expect(resolveAgentAction({ target: 'unknown' })).toEqual({
      target: 'unknown',
      label: '前往设置',
      description: '完成所需设置后即可继续。',
      href: null,
      externalHost: null
    })
  })

  it('only exposes safe MCP authorization URLs', () => {
    expect(resolveAgentAction({ target: 'mcp_authorization', href: 'https://auth.example.com/oauth' })).toMatchObject({
      href: 'https://auth.example.com/oauth',
      externalHost: 'auth.example.com'
    })
    expect(resolveAgentAction({ target: 'mcp_authorization', href: 'http://localhost:9911/callback' })).toMatchObject({
      href: 'http://localhost:9911/callback',
      externalHost: 'localhost:9911'
    })
    expect(resolveAgentAction({ target: 'mcp_authorization', href: 'javascript:alert(1)' }).href).toBeNull()
    expect(resolveAgentAction({ target: 'mcp_authorization', href: 'file:///tmp/token' }).href).toBeNull()
    expect(resolveAgentAction({ target: 'mcp_authorization', href: 'http://auth.example.com' }).href).toBeNull()
  })
})
