import { describe, expect, it } from 'vitest'

import { parsePluginCatalogEvent } from './plugins'

describe('Plugin catalog event parsing', () => {
  it('normalizes authoritative Server changes', () => {
    const event = parsePluginCatalogEvent(`data: ${JSON.stringify({
      type: 'plugin_catalog.changed',
      payload: {
        event_id: 'event-1',
        server_instance_id: 'server-1',
        seq: '8',
        reason: 'disable',
        canonical_plugin_id: 'sample-plugin@local',
        project_ids: ['project-1', 'project-1'],
        at: '2026-08-09T00:00:00.000Z'
      }
    })}`)

    expect(event).toEqual({
      type: 'plugin_catalog.changed',
      payload: {
        event_id: 'event-1',
        server_instance_id: 'server-1',
        seq: 8,
        reason: 'disable',
        canonical_plugin_id: 'sample-plugin@local',
        project_ids: ['project-1'],
        at: '2026-08-09T00:00:00.000Z'
      }
    })
  })

  it('accepts ready and ignores malformed frames', () => {
    expect(parsePluginCatalogEvent('data: {"type":"plugin_catalog.ready","payload":{}}'))
      .toMatchObject({ type: 'plugin_catalog.ready' })
    expect(parsePluginCatalogEvent('data: [DONE]')).toBeNull()
    expect(parsePluginCatalogEvent('data: {bad json')).toBeNull()
    expect(parsePluginCatalogEvent('data: {"type":"unknown"}')).toBeNull()
  })
})
