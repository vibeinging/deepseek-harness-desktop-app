import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import {
  APP_DIR,
  nodeArch,
  nodeVersion,
  projectNodeEnv,
  resolveNpmCli,
  resolveProjectNode,
} from './project-runtime.mjs'

let projectNode
try {
  projectNode = resolveProjectNode({ appDir: APP_DIR })
} catch (error) {
  console.error(`[runtime] ${error?.message || error}`)
  process.exit(1)
}

const [mode, ...inputArgs] = process.argv.slice(2)
if (mode === 'print') {
  console.log(`${projectNode}\t${nodeArch(projectNode)}\t${nodeVersion(projectNode)}`)
  process.exit(0)
}

let command
let args
const env = projectNodeEnv(projectNode)
if (mode === 'node') {
  command = projectNode
  args = inputArgs
} else if (mode === 'npm') {
  try {
    const npmCli = resolveNpmCli(projectNode)
    command = projectNode
    args = [npmCli, ...inputArgs]
    env.npm_execpath = npmCli
  } catch (error) {
    console.error(`[runtime] ${error?.message || error}`)
    process.exit(1)
  }
} else if (mode === 'exec' && inputArgs.length) {
  command = inputArgs[0]
  args = inputArgs.slice(1)
} else {
  console.error('[runtime] 用法: run-with-project-node.mjs <node|npm|exec|print> [...args]')
  process.exit(1)
}

function sameExecutable(left, right) {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}

if (!sameExecutable(process.execPath, projectNode)) {
  console.log(`[runtime] 使用 ${projectNode} (${nodeArch(projectNode)}, Node ${nodeVersion(projectNode)})`)
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  shell: false,
})

function forwardSignal(signal) {
  try {
    child.kill(signal)
  } catch {
    // Child process may have already exited.
  }
}

process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))

child.once('error', (error) => {
    console.error(`[runtime] Command failed to start: ${error.message}`)
  process.exit(1)
})

child.once('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
