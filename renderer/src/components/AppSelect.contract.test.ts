import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const componentSource = readFileSync(
  fileURLToPath(new URL('./AppSelect.tsx', import.meta.url)),
  'utf8'
)
const rendererSourceRoot = fileURLToPath(new URL('../', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.jsx', '.tsx'].includes(extname(path)) ? [path] : []
  })
}

describe('AppSelect contract', () => {
  it('uses the themed Mantine popup and keeps selection stable', () => {
    expect(componentSource).toContain('Select as MantineSelect')
    expect(componentSource).toContain('allowDeselect={false}')
    expect(componentSource).toContain('checkIconPosition="right"')
    expect(componentSource).toContain('withinPortal: true')
  })

  it('does not leave native select controls in renderer pages', () => {
    const nativeSelectTag = ['<', 'select'].join('')
    const offenders = sourceFiles(rendererSourceRoot)
      .filter((path) => !path.endsWith('AppSelect.contract.test.ts'))
      .filter((path) => readFileSync(path, 'utf8').includes(nativeSelectTag))

    expect(offenders).toEqual([])
  })
})
