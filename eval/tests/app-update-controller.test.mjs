import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { AppUpdateController } = require('../../electron/app-update-controller.js')

class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.feed = null
    this.quitArgs = null
  }

  setFeedURL(feed) {
    this.feed = feed
  }

  async checkForUpdates() {
    return { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } }
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 48.5, transferred: 485, total: 1000, bytesPerSecond: 100 })
    this.emit('update-downloaded', { version: '1.1.0' })
    return ['/tmp/update.zip']
  }

  quitAndInstall(...args) {
    this.quitArgs = args
  }
}

function updateResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      data: {
        schema_version: 1,
        checked_at: '2026-08-12T08:00:00Z',
        current: { version: '1.0.0' },
        latest: {
          id: 'release-1',
          version: '1.1.0',
          released_at: '2026-08-12T07:00:00Z',
          notes: { features: ['自动升级'], improvements: [], fixes: [] },
          min_supported_version: '1.0.0',
          update_available: true,
          mandatory: false,
          feed_url: 'https://updates.dsh.example/api/desktop/updates/stable/darwin/arm64',
        },
      },
    }),
  }
}

test('desktop updater checks metadata, downloads on demand, and preserves data paths', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'dsh-updater-'))
  const dataRoot = join(userDataPath, 'projects-and-plugins')
  const updater = new FakeUpdater()
  let prepareCalls = 0
  const controller = new AppUpdateController({
    app: { getVersion: () => '1.0.0' },
    updater,
    fetch: async () => updateResponse(),
    apiBaseUrl: 'https://updates.dsh.example',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'stable',
    locale: 'zh-CN',
    userDataPath,
    dataRoot,
    isPackaged: true,
    prepareToInstall: async () => { prepareCalls += 1 },
    logger: { info() {}, warn() {}, error() {} },
  })

  const checked = await controller.check()
  assert.equal(checked.status, 'available')
  assert.deepEqual(updater.feed, {
    provider: 'generic',
    url: 'https://updates.dsh.example/api/desktop/updates/stable/darwin/arm64',
    useMultipleRangeRequest: false,
  })

  await controller.downloadAndInstall()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prepareCalls, 1)
  assert.deepEqual(updater.quitArgs, [false, true])
  const pending = JSON.parse(readFileSync(join(userDataPath, 'pending-app-update.json'), 'utf8'))
  assert.equal(pending.fromVersion, '1.0.0')
  assert.equal(pending.toVersion, '1.1.0')
  assert.deepEqual(pending.preservedPaths, [userDataPath, dataRoot])
  controller.destroy()
})
test('desktop updater records successful upgrade after the new app starts', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'dsh-updater-history-'))
  writeFileSync(join(userDataPath, 'pending-app-update.json'), JSON.stringify({
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
  }))
  const controller = new AppUpdateController({
    app: { getVersion: () => '1.1.0' },
    updater: new FakeUpdater(),
    fetch: async () => updateResponse(),
    apiBaseUrl: 'https://updates.dsh.example',
    platform: 'linux',
    arch: 'x64',
    userDataPath,
    dataRoot: join(userDataPath, 'data'),
    isPackaged: true,
    logger: { info() {}, warn() {}, error() {} },
  })
  assert.equal(controller.getState().enabled, false)
  assert.equal(controller.getState().history[0].result, 'success')
  assert.equal(controller.getState().history[0].toVersion, '1.1.0')
  controller.destroy()
})

test('desktop updater rejects a feed URL from a private or foreign server', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'dsh-updater-trust-'))
  const controller = new AppUpdateController({
    app: { getVersion: () => '1.0.0' },
    updater: new FakeUpdater(),
    fetch: async () => {
      const response = updateResponse()
      const payload = JSON.parse(await response.text())
      payload.data.latest.feed_url = 'https://private.example.com/api/desktop/updates/stable/darwin/arm64'
      return { ...response, text: async () => JSON.stringify(payload) }
    },
    apiBaseUrl: 'https://updates.dsh.example',
    platform: 'darwin',
    arch: 'arm64',
    userDataPath,
    dataRoot: join(userDataPath, 'data'),
    isPackaged: true,
    logger: { info() {}, warn() {}, error() {} },
  })
  const state = await controller.check()
  assert.equal(state.status, 'error')
  assert.match(state.error, /不受信任/)
  controller.destroy()
})

test('desktop updater restores cached release notes without trusting them as an install command', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'dsh-updater-cache-'))
  writeFileSync(join(userDataPath, 'app-update-metadata-cache.json'), JSON.stringify({
    schema_version: 1,
    checked_at: '2026-08-12T08:00:00Z',
    current: { version: '1.0.0', release: null },
    latest: {
      id: 'cached-release', version: '1.1.0', released_at: '2026-08-12T07:00:00Z',
      notes: { features: ['缓存说明'], improvements: [], fixes: [] },
      update_available: true, mandatory: false,
      feed_url: 'https://updates.dsh.example/api/desktop/updates/stable/darwin/arm64',
    },
  }))
  const updater = new FakeUpdater()
  let downloadCalls = 0
  updater.downloadUpdate = async () => { downloadCalls += 1 }
  const controller = new AppUpdateController({
    app: { getVersion: () => '1.0.0' }, updater,
    fetch: async () => { throw new Error('offline') },
    apiBaseUrl: 'https://updates.dsh.example', platform: 'darwin', arch: 'arm64',
    userDataPath, dataRoot: join(userDataPath, 'data'), isPackaged: true,
    logger: { info() {}, warn() {}, error() {} },
  })
  assert.equal(controller.getState().latest.notes.features[0], '缓存说明')
  await controller.downloadAndInstall()
  assert.equal(downloadCalls, 0)
  assert.equal(controller.getState().status, 'error')
  controller.destroy()
})


test('desktop updater stays disabled until the app has an explicit HTTPS update source', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'dsh-updater-disabled-'))
  const controller = new AppUpdateController({
    app: { getVersion: () => '1.0.0' },
    updater: new FakeUpdater(),
    fetch: async () => { throw new Error('must not fetch') },
    apiBaseUrl: '',
    platform: 'darwin',
    arch: 'arm64',
    userDataPath,
    dataRoot: join(userDataPath, 'data'),
    isPackaged: true,
    logger: { info() {}, warn() {}, error() {} },
  })
  assert.equal(controller.getState().enabled, false)
  assert.equal(controller.getState().status, 'disabled')
  controller.destroy()
})
