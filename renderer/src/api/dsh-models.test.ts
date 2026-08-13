import { describe, expect, it } from 'vitest'

import { parseDshModelSettingsEvent } from './dsh-models'

describe('DSH model settings event protocol', () => {
  it('parses value-free invalidations from the DSH host bridge', () => {
    expect(parseDshModelSettingsEvent('data: {"type":"dsh_models.changed","payload":{"event_id":"e1","server_instance_id":"s1","seq":3,"reason":"host/settings-changed","ns":"llm-deepseek","ref":null,"at":"2026-08-13T00:00:00.000Z"}}')).toEqual({
      type: 'dsh_models.changed',
      payload: {
        event_id: 'e1',
        server_instance_id: 's1',
        seq: 3,
        reason: 'host/settings-changed',
        ns: 'llm-deepseek',
        ref: null,
        at: '2026-08-13T00:00:00.000Z'
      }
    })
  })

  it('ignores terminal, malformed, and unrelated stream lines', () => {
    expect(parseDshModelSettingsEvent('data: [DONE]')).toBeNull()
    expect(parseDshModelSettingsEvent('data: {bad')).toBeNull()
    expect(parseDshModelSettingsEvent('data: {"type":"session/event","payload":{}}')).toBeNull()
  })
})
