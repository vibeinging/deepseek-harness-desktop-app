import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MIN_NODE_MAJOR = 24

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function supportedNodeVersion(version) {
  const [major = 0] = String(version || '').split('.').map(Number)
  return major >= MIN_NODE_MAJOR
}

export function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

export function nodeVersion(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function nativeBinaryArch(filePath) {
  if (!existsSync(filePath)) return ''
  try {
    const output = execFileSync('file', [filePath], { encoding: 'utf8' })
    if (output.includes('arm64')) return 'arm64'
    if (output.includes('x86_64')) return 'x64'
  } catch {
    // If `file` is missing or on Windows, fall back to marker/system architecture.
  }
  return ''
}

function macHardwareArch() {
  if (process.platform !== 'darwin') return process.arch
  try {
    const supportsArm = execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim()
    if (supportsArm === '1') return 'arm64'
    return process.arch
  } catch {
    // Sandboxes may block sysctl. Let the installed native module/marker decide before process.arch.
    return ''
  }
}

function uniqueExistingPaths(paths) {
  const seen = new Set()
  return paths.filter((filePath) => {
    if (!filePath || !existsSync(filePath)) return false
    let key = filePath
    try {
      key = realpathSync(filePath)
    } catch {
      // Keep original path.
    }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function runtimeMarker(appDir) {
  const marker = readJson(join(appDir, '.desktop-deps.json'))
  return marker?.platform === process.platform ? marker : null
}

function runtimeCandidates(targetArch, env) {
  const pathCandidates = String(env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))

  const preferred = process.platform === 'darwin'
    ? targetArch === 'arm64'
      ? ['/opt/homebrew/bin/node', '/usr/local/bin/node']
      : ['/usr/local/bin/node', '/opt/homebrew/bin/node']
    : []

  return uniqueExistingPaths([
    env.DSH_PROJECT_NODE,
    env.DSH_NODE_BIN,
    ...preferred,
    process.execPath,
    ...pathCandidates,
  ])
}

export function resolveProjectNode({ appDir = APP_DIR, env = process.env } = {}) {
  const marker = runtimeMarker(appDir)
  const sqliteArch = nativeBinaryArch(
    join(appDir, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  )
  // Development defaults to the real machine architecture. A stale marker or a dependency installed
  // under Rosetta must not drag all subsequent launches back to x64. Cross-architecture workflows can
  // still opt in explicitly (for example packaging checks) through DSH_PROJECT_ARCH.
  const targetArch = env.DSH_PROJECT_ARCH || macHardwareArch() || sqliteArch || marker?.arch || process.arch
  const targetMajor = Number(marker?.nodeMajor || 0)
  const candidates = runtimeCandidates(targetArch, env).map((filePath) => ({
    filePath,
    arch: nodeArch(filePath),
    version: nodeVersion(filePath),
  }))
  const compatible = candidates.filter(
    (candidate) => candidate.arch === targetArch && supportedNodeVersion(candidate.version),
  )

  if (targetMajor) {
    const exact = compatible.find(
      (candidate) => Number(candidate.version.split('.')[0]) === targetMajor,
    )
    if (exact) return exact.filePath
  }
  if (compatible.length) return compatible[0].filePath

  const found = candidates
    .map((candidate) => `${candidate.filePath} (${candidate.arch || 'unknown'}, v${candidate.version || 'unknown'})`)
    .join(', ')
  throw new Error(
    `找不到 ${targetArch} 且 Node >=${MIN_NODE_MAJOR} 的运行时。`
    + `${found ? ` 已检查: ${found}` : ''}`,
  )
}

export function projectNodeEnv(nodePath, env = process.env) {
  return {
    ...env,
    PATH: `${dirname(nodePath)}${delimiter}${env.PATH || ''}`,
    DSH_PROJECT_NODE: nodePath,
    DSH_NODE_BIN: nodePath,
    npm_node_execpath: nodePath,
  }
}

export function resolveNpmCli(nodePath, env = process.env) {
  if (env.npm_execpath && existsSync(env.npm_execpath)) return env.npm_execpath

  const adjacentNpm = join(dirname(nodePath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (existsSync(adjacentNpm) && process.platform !== 'win32') {
    try {
      const resolved = realpathSync(adjacentNpm)
      if (resolved.endsWith('.js')) return resolved
    } catch {
      // Continue checking common npm installation paths.
    }
  }

  for (const filePath of [
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ]) {
    if (existsSync(filePath)) return filePath
  }
  throw new Error('找不到 npm CLI，请先安装 Node 24 或更高版本')
}
