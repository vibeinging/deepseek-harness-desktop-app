import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('product copy and package metadata use the dsh-work identity', () => {
  assert.match(read('README.md'), /^# dsh-work$/m)
  assert.equal(JSON.parse(read('package.json')).productName, 'dsh-work')
  assert.match(read('renderer/index.html'), /dsh-work/)
  assert.match(read('server/.agents/plugins/marketplace.json'), /DSH 内置能力/)
})

test('product data and protocol names use the DSH namespace', () => {
  assert.match(read('README.md'), /\.dsh/)
  assert.match(read('renderer/src/store/brand.ts'), /dsh-work/)
  assert.match(read('renderer/src/theme/skins/types.ts'), /dsh-/)
})
