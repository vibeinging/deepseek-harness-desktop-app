import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('product copy and package metadata use the DeepSeek Harness Desktop App identity', () => {
  assert.match(read('README.md'), /^# DeepSeek Harness Desktop App$/m)
  assert.equal(JSON.parse(read('package.json')).productName, 'DeepSeek Harness Desktop App')
  assert.equal(JSON.parse(read('electron/package.json')).build.productName, 'DeepSeek Harness Desktop App')
  assert.match(read('renderer/index.html'), /DeepSeek Harness Desktop App/)
  assert.match(read('server/src/config/app_name.js'), /DeepSeek Harness Desktop App/)
  assert.match(read('server/.agents/plugins/marketplace.json'), /DSH 内置能力/)
})

test('product data and protocol names keep stable DSH and dsh-work namespaces', () => {
  assert.match(read('README.md'), /\.dsh/)
  assert.match(read('electron/main.js'), /USER_DATA_DIR_NAME = 'dsh-electron'/)
  assert.match(read('electron/main.js'), /LOCAL_FILE_SCHEME = 'dsh-file'/)
  assert.match(read('packages/dsh-work-shell/package.json'), /@deepseek-ai\/dsh-work-shell/)
  assert.match(read('renderer/src/views/agent/workbenchContributions.ts'), /dsh-work\/files/)
  assert.match(read('renderer/src/theme/skins/types.ts'), /dsh-/)
})
