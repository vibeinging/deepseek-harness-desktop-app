import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ELECTRON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCT_NAME = 'DeepSeek Harness Desktop App'
const DEV_APP_ID = 'ai.deepseek.dsh.dev'
const CACHE_REVISION = '1'

function replacePlistString(plistPath, key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plistPath])
}

function prepareMacDevelopmentApp(electronExecutable) {
  const electronPackageDir = dirname(require.resolve('electron/package.json'))
  const electronVersion = JSON.parse(readFileSync(join(electronPackageDir, 'package.json'), 'utf8')).version
  const sourceApp = dirname(dirname(dirname(electronExecutable)))
  const cacheDir = join(
    dirname(electronPackageDir),
    '.cache',
    'dsh-dev-app',
    `${electronVersion}-${process.arch}-${CACHE_REVISION}`,
  )
  const developmentApp = join(cacheDir, `${PRODUCT_NAME}.app`)
  const markerPath = join(cacheDir, 'source.txt')
  const marker = `${electronExecutable}\n`

  if (existsSync(developmentApp) && existsSync(markerPath) && readFileSync(markerPath, 'utf8') === marker) {
    return join(developmentApp, 'Contents', 'MacOS', 'Electron')
  }

  rmSync(cacheDir, { recursive: true, force: true })
  mkdirSync(cacheDir, { recursive: true })
  const preparingApp = join(cacheDir, `${PRODUCT_NAME}-preparing.app`)

  try {
    try {
      // APFS clone does not allocate a full duplicate of Electron binaries.
      execFileSync('cp', ['-cR', sourceApp, preparingApp])
    } catch {
      execFileSync('cp', ['-R', sourceApp, preparingApp])
    }

    const plistPath = join(preparingApp, 'Contents', 'Info.plist')
    replacePlistString(plistPath, 'CFBundleDisplayName', PRODUCT_NAME)
    replacePlistString(plistPath, 'CFBundleName', PRODUCT_NAME)
    replacePlistString(plistPath, 'CFBundleIdentifier', DEV_APP_ID)
    replacePlistString(plistPath, 'CFBundleIconFile', 'icon.icns')
    copyFileSync(join(ELECTRON_DIR, 'icons', 'icon.icns'), join(preparingApp, 'Contents', 'Resources', 'icon.icns'))

    // Re-sign the app package after modifying app metadata to avoid macOS launch rejection.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', preparingApp], { stdio: 'inherit' })
    renameSync(preparingApp, developmentApp)
    writeFileSync(markerPath, marker)
  } catch (error) {
    rmSync(cacheDir, { recursive: true, force: true })
    throw error
  }

  return join(developmentApp, 'Contents', 'MacOS', 'Electron')
}

const stockElectronExecutable = require('electron')
const electronExecutable = process.platform === 'darwin'
  ? prepareMacDevelopmentApp(stockElectronExecutable)
  : stockElectronExecutable

if (process.argv.includes('--prepare-only')) {
  console.log(`[electron] 开发应用已准备: ${electronExecutable}`)
  process.exit(0)
}

const child = spawn(electronExecutable, ['.'], {
  cwd: ELECTRON_DIR,
  env: process.env,
  stdio: 'inherit',
})

function forwardSignal(signal) {
  try {
    child.kill(signal)
  } catch {
    // Child process may already have exited.
  }
}

process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))

child.once('error', (error) => {
  console.error(`[electron] 启动失败: ${error.message}`)
  process.exit(1)
})

child.once('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
