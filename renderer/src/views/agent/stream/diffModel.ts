export interface DiffLine {
  id: string
  text: string
  kind: 'add' | 'delete' | 'context' | 'meta'
  oldLine?: number | null
  newLine?: number | null
  hunkId?: string | null
}

export interface DiffFile {
  path: string
  previousPath?: string | null
  added: number
  deleted: number
  lines: DiffLine[]
}

export interface DiffSummary {
  files: DiffFile[]
  added: number
  deleted: number
}

function cleanDiffPath(value: string) {
  const path = String(value || '').trim().replace(/^"|"$/g, '')
  if (path === '/dev/null') return ''
  return path.replace(/^[ab]\//, '')
}

function lineKind(line: string): DiffLine['kind'] {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'delete'
  if (line.startsWith(' ') || line === '') return 'context'
  return 'meta'
}

function emptyFile(path = '更改') : DiffFile {
  return { path, previousPath: null, added: 0, deleted: 0, lines: [] }
}

/**
 * Parse only the stable parts of unified diff that the UI needs. The original
 * text remains the source of truth; this model is a disposable render view.
 */
export function parseUnifiedDiff(diff: string): DiffSummary {
  const source = String(diff || '')
  if (!source.trim()) return { files: [], added: 0, deleted: 0 }

  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldLine: number | null = null
  let newLine: number | null = null
  let hunkId: string | null = null
  const ensureCurrent = () => {
    if (!current) {
      current = emptyFile()
      files.push(current)
    }
    return current
  }

  source.split('\n').forEach((line, index) => {
    const header = line.match(/^diff --git\s+(?:"?a\/(.+?)"?)\s+(?:"?b\/(.+?)"?)$/)
    if (header) {
      const previousPath = cleanDiffPath(header[1])
      const path = cleanDiffPath(header[2]) || previousPath || '更改'
      current = emptyFile(path)
      current.previousPath = previousPath && previousPath !== path ? previousPath : null
      files.push(current)
      oldLine = null
      newLine = null
      hunkId = null
    }

    const file = ensureCurrent()
    const previousHeader = line.match(/^---\s+(.+)$/)
    const nextHeader = line.match(/^\+\+\+\s+(.+)$/)
    if (previousHeader) {
      const previousPath = cleanDiffPath(previousHeader[1])
      if (previousPath && previousPath !== file.path) file.previousPath = previousPath
    }
    if (nextHeader) {
      const nextPath = cleanDiffPath(nextHeader[1])
      if (nextPath) file.path = nextPath
    }

    const kind = lineKind(line)
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      hunkId = `${file.path}:${oldLine}:${newLine}`
    }
    if (kind === 'add') file.added += 1
    if (kind === 'delete') file.deleted += 1
    const lineOld = kind === 'delete' || kind === 'context' ? oldLine : null
    const lineNew = kind === 'add' || kind === 'context' ? newLine : null
    file.lines.push({
      id: `${files.length - 1}:${index}`,
      text: line,
      kind,
      oldLine: lineOld,
      newLine: lineNew,
      hunkId
    })
    if (kind === 'delete' || kind === 'context') oldLine = oldLine == null ? null : oldLine + 1
    if (kind === 'add' || kind === 'context') newLine = newLine == null ? null : newLine + 1
  })

  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0)
  }
}

export function fileChangeLabel(kind: string) {
  const normalized = String(kind || '').toLowerCase()
  if (normalized.includes('add') || normalized.includes('create')) return '已创建'
  if (normalized.includes('delete') || normalized.includes('remove')) return '已删除'
  if (normalized.includes('rename') || normalized.includes('move')) return '已重命名'
  return '已编辑'
}
