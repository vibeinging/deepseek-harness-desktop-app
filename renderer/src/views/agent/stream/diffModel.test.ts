import { describe, expect, it } from 'vitest'
import { fileChangeLabel, parseUnifiedDiff } from './diffModel'

describe('diffModel', () => {
  it('builds file and line statistics from an aggregated runtime diff', () => {
    const result = parseUnifiedDiff([
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' keep',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two'
    ].join('\n'))

    expect(result).toMatchObject({ added: 3, deleted: 1 })
    expect(result.files.map((file) => file.path)).toEqual(['README.md', 'src/new.ts'])
    expect(result.files[1]).toMatchObject({ added: 2, deleted: 0 })
    expect(result.files[0].lines.find((line) => line.text === '-old')).toMatchObject({ oldLine: 1, newLine: null })
    expect(result.files[0].lines.find((line) => line.text === '+new')).toMatchObject({ oldLine: null, newLine: 1 })
    expect(result.files[0].lines.find((line) => line.text === ' keep')).toMatchObject({ oldLine: 2, newLine: 2 })
  })

  it('returns an empty projection when a turn has no remaining diff', () => {
    expect(parseUnifiedDiff('')).toEqual({ files: [], added: 0, deleted: 0 })
  })

  it('uses readable labels for native file change kinds', () => {
    expect(fileChangeLabel('add')).toBe('已创建')
    expect(fileChangeLabel('delete')).toBe('已删除')
    expect(fileChangeLabel('rename')).toBe('已重命名')
    expect(fileChangeLabel('update')).toBe('已编辑')
  })
})
