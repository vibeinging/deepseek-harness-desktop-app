import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT_PATH)
const ELECTRON_DIR = resolve(SCRIPT_DIR, '..')
const APP_DIR = resolve(ELECTRON_DIR, '..')
const SOURCE_SERVER_DIR = join(APP_DIR, 'server')
const STAGED_SERVER_DIR = join(APP_DIR, '.desktop-build', 'server')
const BUILD_CACHE_DIR = join(APP_DIR, '.desktop-build', 'npm-cache')
const BUILD_HEADERS_DIR = join(APP_DIR, '.desktop-build', 'electron-gyp')
const SUPPORTED_ARCHES = new Set(['arm64', 'x64'])
const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])
const AGENT_RUNTIME_TARGETS = {
  'darwin-arm64': ['codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
  'darwin-x64': ['codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
  'win32-x64': ['codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const nodeDir = dirname(command)
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
        npm_node_execpath: command,
        ...options.env,
      },
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} 退出(code=${code}, signal=${signal || 'none'})`))
    })
  })
}

function supportedNode(version) {
  const [major = 0] = String(version).replace(/^v/, '').split('.').map(Number)
  return major >= 24
}

function nodeVersion(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.version'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function includePackagedServerSource(source) {
  const parts = source.split(/[\\/]/)
  // Local plugin runtimes contain machine- and architecture-specific native
  // binaries. Product plugin source is packaged, but runtimes are provisioned
  // separately for the target platform.
  return !parts.includes('.runtime')
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function isPlainDirectory(path) {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function assertNoSymlinkPath(root, target, label) {
  if (!isInside(root, target)) throw new Error(`${label}路径越界`)
  const parts = relative(root, target).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`${label}不能包含符号链接: ${current}`)
  }
  const actual = await realpath(target)
  if (!isInside(root, actual)) throw new Error(`${label}真实路径越界`)
  return actual
}

function localMarketplaceSourcePath(plugin) {
  if (!plugin || typeof plugin !== 'object') return null
  if (typeof plugin.source === 'string') return plugin.source.trim()
  if (plugin.source && typeof plugin.source === 'object' && plugin.source.source === 'local') {
    return String(plugin.source.path || '').trim()
  }
  return null
}

export async function verifyPackagedBuiltinPlugins({
  sourceServerDir = SOURCE_SERVER_DIR,
  stagedServerDir = STAGED_SERVER_DIR,
} = {}) {
  const sourceRoot = await realpath(resolve(sourceServerDir))
  const stagedRoot = await realpath(resolve(stagedServerDir))
  const marketplacePath = join(stagedRoot, '.agents', 'plugins', 'marketplace.json')
  await assertNoSymlinkPath(stagedRoot, marketplacePath, '内置 Plugin marketplace ')
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'))
  const verified = []
  for (const plugin of Array.isArray(marketplace.plugins) ? marketplace.plugins : []) {
    const sourcePath = localMarketplaceSourcePath(plugin)
    if (sourcePath == null) continue
    const pluginName = String(plugin.name || '').trim()
    if (!pluginName) throw new Error('内置 Plugin 缺少名称')
    if (!sourcePath) throw new Error(`内置 Plugin 缺少本地路径: ${pluginName}`)

    const sourcePluginRoot = resolve(sourceRoot, sourcePath)
    const stagedPluginRoot = resolve(stagedRoot, sourcePath)
    if (!isInside(sourceRoot, sourcePluginRoot) || !isInside(stagedRoot, stagedPluginRoot)) {
      throw new Error(`内置 Plugin 路径越出 Server 安装包: ${sourcePath || pluginName}`)
    }
    if (!existsSync(sourcePluginRoot)) {
      throw new Error(`内置 Plugin 源目录不存在: ${pluginName}`)
    }
    await assertNoSymlinkPath(sourceRoot, sourcePluginRoot, `内置 Plugin「${pluginName}」源目录`)
    if (!await isPlainDirectory(sourcePluginRoot)) {
      throw new Error(`内置 Plugin 源目录不存在: ${pluginName}`)
    }

    const sourceManifestPath = join(sourcePluginRoot, 'plugin.json')
    if (!existsSync(sourceManifestPath)) {
      throw new Error(`内置 Plugin 源 manifest 不存在: ${pluginName}`)
    }
    await assertNoSymlinkPath(sourceRoot, sourceManifestPath, `内置 Plugin「${pluginName}」源 manifest`)
    const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
    if (String(sourceManifest.name || '') !== pluginName) {
      throw new Error(`内置 Plugin 名称不一致: ${pluginName}`)
    }

    const stagedManifestPath = join(stagedPluginRoot, 'plugin.json')
    if (!existsSync(stagedPluginRoot) || !existsSync(stagedManifestPath)) {
      throw new Error(`内置 Plugin 没有进入安装包: ${pluginName}`)
    }
    await assertNoSymlinkPath(stagedRoot, stagedPluginRoot, `内置 Plugin「${pluginName}」安装目录`)
    if (!await isPlainDirectory(stagedPluginRoot)) {
      throw new Error(`内置 Plugin 没有进入安装包: ${pluginName}`)
    }
    await assertNoSymlinkPath(stagedRoot, stagedManifestPath, `内置 Plugin「${pluginName}」安装 manifest`)
    const stagedManifest = JSON.parse(await readFile(stagedManifestPath, 'utf8'))
    if (String(stagedManifest.name || '') !== pluginName) {
      throw new Error(`内置 Plugin 名称不一致: ${pluginName}`)
    }
    verified.push(pluginName)
  }
  return verified
}

export async function preparePackage() {
  if (!supportedNode(process.version) && process.env.DSH_PACKAGE_NODE_REEXEC !== '1') {
    const candidates = [
      process.env.DSH_PACKAGE_NODE_BIN,
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ].filter((value, index, all) => value && existsSync(value) && all.indexOf(value) === index)
    const replacement = candidates.find((candidate) => supportedNode(nodeVersion(candidate)))
    if (replacement) {
      console.log(`[package] 使用 ${replacement} (${nodeVersion(replacement)}) 准备生产依赖`)
      await run(replacement, process.argv.slice(1), {
        cwd: process.cwd(),
        env: { DSH_PACKAGE_NODE_REEXEC: '1' },
      })
      process.exit(0)
    }
    throw new Error(`当前 Node ${process.version} 太旧。请安装 Node 24 后重新执行 npm install`)
  }

  const targetPlatform = arg('platform', process.platform)
  const targetArch = arg('arch', process.arch)
  if (!SUPPORTED_PLATFORMS.has(targetPlatform)) throw new Error(`不支持的目标平台: ${targetPlatform}`)
  if (!SUPPORTED_ARCHES.has(targetArch)) throw new Error(`不支持的目标架构: ${targetArch}`)
  if (targetPlatform !== process.platform) {
    throw new Error(`原生依赖必须在目标系统构建: 当前 ${process.platform}，目标 ${targetPlatform}`)
  }

  await rm(STAGED_SERVER_DIR, { recursive: true, force: true })
  await mkdir(STAGED_SERVER_DIR, { recursive: true })
  for (const name of ['src', 'db', 'vendor', 'plugins', '.agents']) {
    // plugins 是应用运行时生成的本地插件目录，全新检出/清理后可能尚不存在
    if (name === 'plugins' && !existsSync(join(SOURCE_SERVER_DIR, name))) {
      await mkdir(join(STAGED_SERVER_DIR, name), { recursive: true })
      continue
    }
    await cp(join(SOURCE_SERVER_DIR, name), join(STAGED_SERVER_DIR, name), {
      recursive: true,
      // Local plugin runtimes contain machine- and architecture-specific native
      // binaries. They must be installed for the target platform, never copied
      // from the developer's working tree.
      filter: includePackagedServerSource,
    })
  }
  for (const name of ['package.json', 'package-lock.json']) {
    await cp(join(SOURCE_SERVER_DIR, name), join(STAGED_SERVER_DIR, name))
  }
  await verifyPackagedBuiltinPlugins()

  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('找不到 npm CLI，请通过 npm run 执行打包命令')
  const targetEnv = {
    npm_config_cpu: targetArch,
    npm_config_os: targetPlatform,
    npm_config_cache: BUILD_CACHE_DIR,
  }
  await run(process.execPath, [
    npmCli,
    'ci',
    '--omit=dev',
    '--include=optional',
    `--cpu=${targetArch}`,
    `--os=${targetPlatform}`,
    '--no-audit',
    '--no-fund',
  ], {
    cwd: STAGED_SERVER_DIR,
    env: targetEnv,
  })

  // DSH loader 以裸包名按 Node parent-walk 从 server/node_modules 解析内置 Bundle；
  // 把随包本地插件以实体副本放进 staged node_modules，与 $DSH_HOME/profiles 的
  // flat 链接互为冗余，保证任意平台、任意解析起点都能命中（symlink 不能跨机，必须复制）。
  for (const pluginName of ['dsh-product-bridge', 'dsh-theme-pack', 'dsh-work-shell']) {
    await cp(
      join(APP_DIR, 'packages', pluginName),
      join(STAGED_SERVER_DIR, 'node_modules', '@deepseek-ai', pluginName),
      { recursive: true },
    )
  }

  const agentRuntimeTarget = AGENT_RUNTIME_TARGETS[`${targetPlatform}-${targetArch}`]
  if (!agentRuntimeTarget) throw new Error(`Agent 运行时不支持打包目标: ${targetPlatform}/${targetArch}`)
  const [agentRuntimePackage, agentRuntimeTriple, agentRuntimeExecutable] = agentRuntimeTarget
  const stagedAgentRuntimePath = join(
    STAGED_SERVER_DIR,
    'node_modules',
    '@openai',
    agentRuntimePackage,
    'vendor',
    agentRuntimeTriple,
    'bin',
    agentRuntimeExecutable,
  )
  if (!existsSync(stagedAgentRuntimePath)) {
    throw new Error(`Agent ${targetPlatform}/${targetArch} 原生运行时没有进入安装包: ${stagedAgentRuntimePath}`)
  }
  const agentRuntimeVersion = execFileSync(stagedAgentRuntimePath, ['--version'], { encoding: 'utf8' }).trim()
  if (!/codex-cli 0\.147\.0\b/.test(agentRuntimeVersion)) {
    throw new Error(`Agent 运行时版本不正确: ${agentRuntimeVersion || '无输出'}`)
  }

  const electronPackage = JSON.parse(await readFile(join(ELECTRON_DIR, 'package.json'), 'utf8'))
  const electronVersion = String(electronPackage.devDependencies.electron).replace(/^[^\d]*/, '')
  process.env.npm_config_cache = BUILD_CACHE_DIR
  process.env.npm_config_devdir = BUILD_HEADERS_DIR
  const { rebuild } = await import('@electron/rebuild')
  await rebuild({
    buildPath: STAGED_SERVER_DIR,
    electronVersion,
    arch: targetArch,
    force: true,
    onlyModules: ['better-sqlite3'],
  })

  console.log(`[package] Agent 运行时已验证: ${targetPlatform}/${targetArch}`)
  console.log(`[package] Server 资源已准备: ${targetPlatform}/${targetArch} -> ${STAGED_SERVER_DIR}`)
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedScript === SCRIPT_PATH) await preparePackage()
