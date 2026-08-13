import { describe, expect, it } from 'vitest'
import { artifactActionTarget } from './ArtifactActions'

describe('artifact action contract', () => {
  it('honors declared host actions, removes unknown values and keeps stable order', () => {
    const target = artifactActionTarget({
      type: 'file',
      metadata: {
        output_delivery: {
          kind: 'document',
          path: '/tmp/report.docx',
          actions: ['reveal', 'remove', 'open', 'open']
        }
      }
    })

    expect(target.actions).toEqual(['open', 'reveal'])
    expect(target.path).toBe('/tmp/report.docx')
  })

  it('keeps old generated images useful when stored messages have no action contract', () => {
    const target = artifactActionTarget({ type: 'image', metadata: { saved_path: '/tmp/cat.png' } }, {
      dataUrl: 'data:image/png;base64,aW1hZ2U='
    })

    expect(target.actions).toEqual(['reveal', 'copy'])
  })

  it('adds open and reveal fallbacks to old file cards', () => {
    const target = artifactActionTarget({ type: 'file' }, { kind: 'document', path: '/tmp/report.docx' })
    expect(target.actions).toEqual(['open', 'reveal'])
  })

  it('maps client-generated PDF output to download without a local path', () => {
    const target = artifactActionTarget({
      type: 'html',
      metadata: { output_artifact: { materialization: 'client-download' } }
    }, { kind: 'pdf' })
    expect(target.actions).toEqual(['download'])
  })
})
