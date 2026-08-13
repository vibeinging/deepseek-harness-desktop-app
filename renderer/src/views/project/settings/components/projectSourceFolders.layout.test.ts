import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('./BasicInfo.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./BasicInfo.module.scss', import.meta.url), 'utf8')

describe('project source-folder management contract', () => {
  it('persists display names and order, not just folder paths', () => {
    expect(view).toContain("write_target: folder.write_target === true || folder.access_mode === 'write'")
    expect(view).toContain('onChange={(event) => setFolders')
    expect(view).toContain('moveFolder(index, -1)')
    expect(view).toContain('moveFolder(index, 1)')
  })

  it('makes unavailable folders visible and keeps native folder actions explicit', () => {
    expect(view).toContain("folder.available === false ? t('project.basicInfo.unavailable')")
    expect(view).toContain('openLocalFile(folder.path)')
    expect(view).toContain('disabled={folder.available === false}')
    expect(styles).toContain('.folderUnavailable')
  })

  it('checks duplicate or overlapping roots and confirms removal', () => {
    expect(view).toContain('folderConflict(folder.path, path)')
    expect(view).toContain('modals.openConfirmModal')
    expect(view).toContain('project.basicInfo.removeFolderConfirm')
  })

  it('shows one explicit write target and keeps unavailable roots out of selection', () => {
    expect(view).toContain('selectWriteTarget(folder.path)')
    expect(view).toContain('name={`project-write-target-${project?.id')
    expect(view).toContain("checked={folder.write_target === true || folder.access_mode === 'write'}")
    expect(view).toContain('disabled={!canManage || folder.available === false}')
    expect(styles).toContain('.writeTarget')
  })
})
