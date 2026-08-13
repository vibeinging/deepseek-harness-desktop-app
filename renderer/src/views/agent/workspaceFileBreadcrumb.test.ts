import { describe, expect, it } from 'vitest'
import { buildWorkspaceFileBreadcrumb, workspaceFileScopeLabel } from './workspaceFileBreadcrumb'

describe('workspace file breadcrumb', () => {
  it('uses the logical project root instead of leaking the physical source-folder path', () => {
    expect(buildWorkspaceFileBreadcrumb({
      scope: 'project',
      projectName: '税务项目',
      rootName: 'PDF测试样本',
      relativePath: '2022/申报表/TCC VAT declaration form 202206.pdf',
      absolutePath: '/Users/example/Downloads/pdf测试/2022/申报表/TCC VAT declaration form 202206.pdf'
    })).toEqual([
      '税务项目',
      'PDF测试样本',
      '2022',
      '申报表',
      'TCC VAT declaration form 202206.pdf'
    ])
  })

  it('shows only the last two parent folders for an external file', () => {
    expect(buildWorkspaceFileBreadcrumb({
      scope: 'external',
      relativePath: 'TCC VAT declaration form 202206.pdf',
      absolutePath: '/Users/example/Downloads/临时资料/TCC VAT declaration form 202206.pdf'
    })).toEqual([
      '本机文件',
      'Downloads',
      '临时资料',
      'TCC VAT declaration form 202206.pdf'
    ])
    expect(workspaceFileScopeLabel('external')).toBe('项目外')
  })

  it('keeps both ends when a project path is too deep for the right panel', () => {
    expect(buildWorkspaceFileBreadcrumb({
      scope: 'project',
      projectName: 'Dsh',
      rootName: '代码',
      relativePath: 'renderer/src/views/agent/WorkspaceFilesSection.tsx'
    })).toEqual(['Dsh', '代码', '…', 'views', 'agent', 'WorkspaceFilesSection.tsx'])
  })
})
