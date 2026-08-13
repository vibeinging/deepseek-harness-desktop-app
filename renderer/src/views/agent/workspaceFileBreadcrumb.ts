export type WorkspaceFileScope = 'project' | 'chat' | 'external'

export interface WorkspaceFileBreadcrumbInput {
  scope: WorkspaceFileScope
  projectName?: string
  rootName?: string
  relativePath: string
  absolutePath?: string
}

function pathSegments(value: string) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
}

function removeAdjacentDuplicates(items: string[]) {
  return items.filter((item, index) => index === 0 || item !== items[index - 1])
}

function compactMiddle(items: string[], maxItems = 6) {
  if (items.length <= maxItems) return items
  return [items[0], items[1], '…', ...items.slice(-(maxItems - 3))]
}

export function buildWorkspaceFileBreadcrumb({
  scope,
  projectName,
  rootName,
  relativePath,
  absolutePath
}: WorkspaceFileBreadcrumbInput) {
  if (scope === 'external') {
    const externalTail = pathSegments(absolutePath || relativePath).slice(-3)
    return removeAdjacentDuplicates(['本机文件', ...externalTail])
  }

  const owner = scope === 'chat' ? '聊天' : String(projectName || '').trim() || '当前项目'
  const logicalRoot = String(rootName || '').trim()
  const relativeSegments = pathSegments(relativePath)
  return compactMiddle(removeAdjacentDuplicates([owner, logicalRoot, ...relativeSegments].filter(Boolean)))
}

export function workspaceFileScopeLabel(scope: WorkspaceFileScope) {
  if (scope === 'external') return '项目外'
  if (scope === 'chat') return '聊天文件'
  return '项目内'
}
