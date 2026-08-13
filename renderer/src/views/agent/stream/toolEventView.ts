/**
 * Renderer-side mirror of the DSH `ToolEventView` vocabulary
 * (packages/core/tools/src/presentation.ts). The renderer never imports a DSH
 * runtime package (integration-guide.md §2.5 rule 1), so this hand-written
 * mirror stays in sync with the DSH discriminants by code review, not by import.
 *
 * The parser is deliberately lenient: any malformed shape returns `undefined`
 * so the caller falls back to the generic tool card. It NEVER throws — a bad
 * view on the wire or in a replayed session log must not break the stream.
 */

/** A pointable file location for editor follow-along. */
export interface FileLocation {
  path: string
  line?: number
}

/** One before/after pair a DiffCallView carries. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Category for icon/treatment on a generic call. Mirrors DSH `ToolCallKind`. */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/** The default call card: a titled row with optional icon/raw input/locations. */
export interface GenericCallView {
  card: 'generic'
  title: string
  kind?: ToolCallKind
  rawInput?: unknown
  content?: unknown
  locations?: FileLocation[]
}

/** A call that runs a shell command in a working directory. */
export interface TerminalCallView {
  card: 'terminal'
  title: string
  description?: string
  cwd?: string
}

/** A call that creates or modifies files, rendered as an inline diff. */
export interface DiffCallView {
  card: 'diff'
  title: string
  diffs: FileDiff[]
  locations?: FileLocation[]
}

/** The three call-time card shapes, discriminated by `card`. */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

/**
 * The result-time card shapes the renderer CAN render in this slice. Only the
 * call-time generic/terminal/diff cards have dedicated rendering today; result
 * views are parsed for forward-compatibility but fall back to the generic tool
 * card until their dedicated renderers land.
 */
export interface GenericResultView { card: 'generic'; title?: string; content?: unknown[] }
export interface TerminalResultView { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
export interface DiffResultView { card: 'diff'; title?: string; diffs: FileDiff[] }
export interface SearchLineMatch { lineNumber: number; line: string }
export interface SearchFileMatches { path: string; matches: SearchLineMatch[] }
export interface SearchMatchesResultView {
  card: 'search'
  shape: 'matches'
  title?: string
  files: SearchFileMatches[]
  truncated: boolean
  total: number
}
export interface SearchPathsResultView {
  card: 'search'
  shape: 'paths'
  title?: string
  paths: string[]
  truncated: boolean
  total: number
}
export type SearchResultView = SearchMatchesResultView | SearchPathsResultView
export interface ReadFileLine { number: number; text: string }
export interface ReadResultView {
  card: 'read'
  title?: string
  path: string
  offset: number
  lines: ReadFileLine[]
  totalLines: number
  lang?: string
  content?: unknown[]
}
export interface WebSource { url: string; title?: string; snippet?: string; publishedAt?: string }
export interface WebSearchResultView {
  card: 'web'
  kind: 'search'
  title?: string
  sources: WebSource[]
  answer?: string
  truncated: boolean
}
export interface WebFetchResultView {
  card: 'web'
  kind: 'fetch'
  title?: string
  url: string
  statusCode: number
  truncated: boolean
}
export type WebResultView = WebSearchResultView | WebFetchResultView

export type ToolResultView =
  | GenericResultView
  | TerminalResultView
  | DiffResultView
  | SearchResultView
  | ReadResultView
  | WebResultView

/** The envelope carried on `item.dshView`. `for` names which view applies. */
export interface ToolEventView {
  for: 'call' | 'result'
  view: ToolCallView | ToolResultView
}

/** The card discriminants the renderer knows how to render a CALL with. */
const CALL_CARDS = new Set(['generic', 'terminal', 'diff'])

/** The card discriminants the renderer knows how to render a RESULT with. */
const RESULT_CARDS = new Set(['generic', 'terminal', 'diff', 'search', 'read', 'web'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseFileDiff(raw: unknown): FileDiff | undefined {
  if (!isObject(raw)) return undefined
  const path = typeof raw.path === 'string' ? raw.path : undefined
  if (path === undefined) return undefined
  const oldText = typeof raw.oldText === 'string' ? raw.oldText : raw.oldText === null ? null : undefined
  const newText = typeof raw.newText === 'string' ? raw.newText : undefined
  if (newText === undefined) return undefined
  return { path, oldText: oldText ?? null, newText }
}

function parseFileLocation(raw: unknown): FileLocation | undefined {
  if (!isObject(raw)) return undefined
  if (typeof raw.path !== 'string') return undefined
  const loc: FileLocation = { path: raw.path }
  if (typeof raw.line === 'number') loc.line = raw.line
  return loc
}

function parseFileList(raw: unknown, key: string): FileLocation[] | undefined {
  const arr = isObject(raw) ? raw[key] : undefined
  if (!Array.isArray(arr)) return undefined
  const locs = arr.map(parseFileLocation).filter((v): v is FileLocation => v !== undefined)
  return locs.length > 0 ? locs : undefined
}

/**
 * Parse the inner `view` object for a call card. Returns `undefined` on any
 * malformed shape or unknown card so the caller falls back to generic.
 */
function parseCallView(raw: unknown): ToolCallView | undefined {
  if (!isObject(raw)) return undefined
  const card = typeof raw.card === 'string' ? raw.card : undefined
  const title = typeof raw.title === 'string' ? raw.title : undefined
  if (card === undefined || title === undefined) return undefined
  const locations = parseFileList(raw, 'locations')
  if (card === 'generic') {
    const view: GenericCallView = { card, title }
    if (typeof raw.kind === 'string') view.kind = raw.kind as ToolCallKind
    if (raw.rawInput !== undefined) view.rawInput = raw.rawInput
    if (raw.content !== undefined) view.content = raw.content
    if (locations !== undefined) view.locations = locations
    return view
  }
  if (card === 'terminal') {
    const view: TerminalCallView = { card, title }
    if (typeof raw.description === 'string') view.description = raw.description
    if (typeof raw.cwd === 'string') view.cwd = raw.cwd
    return view
  }
  if (card === 'diff') {
    const diffArr = Array.isArray(raw.diffs) ? raw.diffs : undefined
    if (diffArr === undefined) return undefined
    const diffs = diffArr.map(parseFileDiff).filter((v): v is FileDiff => v !== undefined)
    if (diffs.length === 0) return undefined
    const view: DiffCallView = { card, title, diffs }
    if (locations !== undefined) view.locations = locations
    return view
  }
  return undefined
}

/** Parse the inner `view` object for a result card. Lenient: unknown cards → undefined. */
function parseResultView(raw: unknown): ToolResultView | undefined {
  if (!isObject(raw)) return undefined
  const card = typeof raw.card === 'string' ? raw.card : undefined
  if (card === undefined || !RESULT_CARDS.has(card)) return undefined
  const title = typeof raw.title === 'string' ? raw.title : undefined
  const withTitle = title !== undefined ? { title } : {}
  if (card === 'generic') {
    if (raw.content !== undefined && !Array.isArray(raw.content)) return undefined
    return { card, ...withTitle, ...(Array.isArray(raw.content) ? { content: raw.content } : {}) }
  }
  if (card === 'terminal') {
    if (raw.output !== undefined && typeof raw.output !== 'string') return undefined
    if (raw.exitCode !== undefined && typeof raw.exitCode !== 'number') return undefined
    if (raw.signal !== undefined && typeof raw.signal !== 'string') return undefined
    return {
      card,
      ...withTitle,
      ...(typeof raw.output === 'string' ? { output: raw.output } : {}),
      ...(typeof raw.exitCode === 'number' ? { exitCode: raw.exitCode } : {}),
      ...(typeof raw.signal === 'string' ? { signal: raw.signal } : {})
    }
  }
  if (card === 'diff') {
    if (!Array.isArray(raw.diffs)) return undefined
    const diffs = raw.diffs.map(parseFileDiff).filter((value): value is FileDiff => value !== undefined)
    if (diffs.length !== raw.diffs.length) return undefined
    return { card, ...withTitle, diffs }
  }
  if (card === 'search') {
    if ((raw.shape !== 'matches' && raw.shape !== 'paths') || typeof raw.truncated !== 'boolean' || typeof raw.total !== 'number') return undefined
    if (raw.shape === 'paths') {
      if (!Array.isArray(raw.paths) || raw.paths.some(path => typeof path !== 'string')) return undefined
      return { card, shape: raw.shape, ...withTitle, paths: raw.paths as string[], truncated: raw.truncated, total: raw.total }
    }
    if (!Array.isArray(raw.files)) return undefined
    const files: SearchFileMatches[] = []
    for (const file of raw.files) {
      if (!isObject(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) return undefined
      const matches: SearchLineMatch[] = []
      for (const match of file.matches) {
        if (!isObject(match) || typeof match.lineNumber !== 'number' || typeof match.line !== 'string') return undefined
        matches.push({ lineNumber: match.lineNumber, line: match.line })
      }
      files.push({ path: file.path, matches })
    }
    return { card, shape: raw.shape, ...withTitle, files, truncated: raw.truncated, total: raw.total }
  }
  if (card === 'read') {
    if (typeof raw.path !== 'string' || typeof raw.offset !== 'number' || typeof raw.totalLines !== 'number' || !Array.isArray(raw.lines)) return undefined
    const lines: ReadFileLine[] = []
    for (const line of raw.lines) {
      if (!isObject(line) || typeof line.number !== 'number' || typeof line.text !== 'string') return undefined
      lines.push({ number: line.number, text: line.text })
    }
    if (raw.lang !== undefined && typeof raw.lang !== 'string') return undefined
    if (raw.content !== undefined && !Array.isArray(raw.content)) return undefined
    return {
      card,
      ...withTitle,
      path: raw.path,
      offset: raw.offset,
      lines,
      totalLines: raw.totalLines,
      ...(typeof raw.lang === 'string' ? { lang: raw.lang } : {}),
      ...(Array.isArray(raw.content) ? { content: raw.content } : {})
    }
  }
  if (card === 'web') {
    if (raw.kind === 'fetch') {
      if (typeof raw.url !== 'string' || typeof raw.statusCode !== 'number' || typeof raw.truncated !== 'boolean') return undefined
      return { card, kind: raw.kind, ...withTitle, url: raw.url, statusCode: raw.statusCode, truncated: raw.truncated }
    }
    if (raw.kind !== 'search' || !Array.isArray(raw.sources) || typeof raw.truncated !== 'boolean') return undefined
    const sources: WebSource[] = []
    for (const source of raw.sources) {
      if (!isObject(source) || typeof source.url !== 'string') return undefined
      for (const key of ['title', 'snippet', 'publishedAt']) {
        if (source[key] !== undefined && typeof source[key] !== 'string') return undefined
      }
      sources.push({
        url: source.url,
        ...(typeof source.title === 'string' ? { title: source.title } : {}),
        ...(typeof source.snippet === 'string' ? { snippet: source.snippet } : {}),
        ...(typeof source.publishedAt === 'string' ? { publishedAt: source.publishedAt } : {})
      })
    }
    if (raw.answer !== undefined && typeof raw.answer !== 'string') return undefined
    return {
      card,
      kind: raw.kind,
      ...withTitle,
      sources,
      ...(typeof raw.answer === 'string' ? { answer: raw.answer } : {}),
      truncated: raw.truncated
    }
  }
  return undefined
}

/**
 * Parse a `ToolEventView` envelope from `item.dshView`. Returns `undefined`
 * for any malformed shape, unknown `for`, or unknown `card` — the caller then
 * falls back to the generic tool card. Never throws.
 * @param raw - the `item.dshView` value from a live or replayed tool event.
 */
export function parseToolEventView(raw: unknown): ToolEventView | undefined {
  if (!isObject(raw)) return undefined
  const forDiscriminant = raw.for
  if (forDiscriminant !== 'call' && forDiscriminant !== 'result') return undefined
  const view = forDiscriminant === 'call' ? parseCallView(raw.view) : parseResultView(raw.view)
  if (view === undefined) return undefined
  // Re-check the card is one the renderer knows for this side (forward-compat:
  // a brand-new card the renderer hasn't mirrored yet must fall back, not render
  // a wrong shape).
  const known = forDiscriminant === 'call' ? CALL_CARDS.has(view.card) : RESULT_CARDS.has(view.card)
  if (!known) return undefined
  return { for: forDiscriminant, view }
}
