import { describe, expect, it } from 'vitest'
import { parseToolEventView } from './toolEventView'

describe('parseToolEventView', () => {
  it('parses a generic call view', () => {
    const view = parseToolEventView({
      for: 'call',
      view: { card: 'generic', title: 'List projects', kind: 'search', rawInput: 'alpha' },
    })
    expect(view).toEqual({
      for: 'call',
      view: { card: 'generic', title: 'List projects', kind: 'search', rawInput: 'alpha' },
    })
  })

  it('parses a terminal call view with cwd', () => {
    const view = parseToolEventView({
      for: 'call',
      view: { card: 'terminal', title: 'ls -la', description: 'list files', cwd: '/tmp' },
    })
    expect(view?.view).toMatchObject({ card: 'terminal', title: 'ls -la', cwd: '/tmp', description: 'list files' })
  })

  it('parses a diff call view with file diffs', () => {
    const view = parseToolEventView({
      for: 'call',
      view: {
        card: 'diff', title: 'Write foo.txt',
        diffs: [{ path: 'foo.txt', oldText: null, newText: 'hello' }],
      },
    })
    expect(view?.view).toMatchObject({
      card: 'diff', title: 'Write foo.txt',
      diffs: [{ path: 'foo.txt', oldText: null, newText: 'hello' }],
    })
  })

  it('parses every structured field of a search result view', () => {
    const view = parseToolEventView({
      for: 'result',
      view: { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 9 }
    })
    expect(view).toEqual({
      for: 'result',
      view: { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 9 }
    })
  })

  it('parses terminal, read, and web result details', () => {
    expect(parseToolEventView({ for: 'result', view: { card: 'terminal', output: 'ok', exitCode: 0 } })?.view)
      .toEqual({ card: 'terminal', output: 'ok', exitCode: 0 })
    expect(parseToolEventView({
      for: 'result',
      view: { card: 'read', path: 'a.ts', offset: 2, lines: [{ number: 2, text: 'x' }], totalLines: 4, lang: 'ts' }
    })?.view).toMatchObject({ card: 'read', path: 'a.ts', offset: 2, totalLines: 4, lang: 'ts' })
    expect(parseToolEventView({
      for: 'result',
      view: { card: 'web', kind: 'search', sources: [{ url: 'https://example.com', title: 'Example' }], answer: 'ok', truncated: false }
    })?.view).toMatchObject({ card: 'web', kind: 'search', answer: 'ok', truncated: false })
  })

  it('returns undefined when the envelope is not an object', () => {
    expect(parseToolEventView(null)).toBeUndefined()
    expect(parseToolEventView('not-a-view')).toBeUndefined()
    expect(parseToolEventView(42)).toBeUndefined()
  })

  it('returns undefined when `for` is unknown', () => {
    expect(parseToolEventView({ for: 'other', view: { card: 'generic' } })).toBeUndefined()
    expect(parseToolEventView({ view: { card: 'generic' } })).toBeUndefined()
  })

  it('returns undefined when the inner view is missing required fields', () => {
    expect(parseToolEventView({ for: 'call', view: { card: 'generic' } })).toBeUndefined()
    expect(parseToolEventView({ for: 'call', view: { title: 'no card' } })).toBeUndefined()
    expect(parseToolEventView({ for: 'call', view: { card: 'terminal' } })).toBeUndefined()
  })

  it('returns undefined for a diff view with no valid diffs', () => {
    expect(parseToolEventView({ for: 'call', view: { card: 'diff', title: 'd', diffs: [] } })).toBeUndefined()
    expect(parseToolEventView({ for: 'call', view: { card: 'diff', title: 'd', diffs: [{ path: 'x' }] } })).toBeUndefined()
  })

  it('returns undefined for an unknown card (forward-compat)', () => {
    expect(parseToolEventView({ for: 'call', view: { card: 'brand-new-card', title: 'x' } })).toBeUndefined()
    expect(parseToolEventView({ for: 'result', view: { card: 'brand-new-card' } })).toBeUndefined()
  })

  it('returns undefined for incomplete structured result cards', () => {
    expect(parseToolEventView({ for: 'result', view: { card: 'search' } })).toBeUndefined()
    expect(parseToolEventView({ for: 'result', view: { card: 'read', path: 'a.ts' } })).toBeUndefined()
    expect(parseToolEventView({ for: 'result', view: { card: 'web', kind: 'fetch', url: 'x' } })).toBeUndefined()
  })

  it('returns undefined for a call card the renderer only knows on the result side', () => {
    // 'search' is a result-only card; a call with card: 'search' is invalid.
    expect(parseToolEventView({ for: 'call', view: { card: 'search', title: 'x' } })).toBeUndefined()
  })

  it('tolerates optional fields being absent', () => {
    const view = parseToolEventView({ for: 'call', view: { card: 'generic', title: 'bare' } })
    expect(view?.view).toEqual({ card: 'generic', title: 'bare' })
  })

  it('parses locations on a generic call view', () => {
    const view = parseToolEventView({
      for: 'call',
      view: { card: 'generic', title: 'Read', locations: [{ path: 'foo.txt', line: 10 }, { path: 'bar.txt' }] },
    })
    expect((view?.view as { locations?: unknown }).locations).toEqual([
      { path: 'foo.txt', line: 10 }, { path: 'bar.txt' },
    ])
  })

  it('drops malformed locations but keeps the view', () => {
    const view = parseToolEventView({
      for: 'call',
      view: { card: 'generic', title: 'Read', locations: [{ path: 'ok.txt' }, { line: 5 }, 'bad'] },
    })
    expect((view?.view as { locations?: unknown[] }).locations).toEqual([{ path: 'ok.txt' }])
  })
})
