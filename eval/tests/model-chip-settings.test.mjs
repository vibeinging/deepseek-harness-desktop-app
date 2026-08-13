import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..', '..')
const readAppFile = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8')

test('model chip separates loading, empty, configured, and error states', () => {
  const selector = readAppFile('renderer', 'src', 'views', 'agent', 'ConversationModelSelector.tsx')

  assert.match(selector, /const \[loading, setLoading\] = useState\(true\)/)
  assert.match(selector, /const \[failed, setFailed\] = useState\(false\)/)
  assert.match(selector, /'读取模型…'/)
  assert.match(selector, /selected\?\.display_name \|\| selected\?\.model_name \|\| '去设置模型'/)
  assert.match(selector, /'检查模型设置'/)
  assert.doesNotMatch(selector, /解析模型中…/)
})

test('model chip opens the existing model settings page for setup and switching', () => {
  const conversation = readAppFile('renderer', 'src', 'views', 'agent', 'AgentConversation.tsx')
  const selector = readAppFile('renderer', 'src', 'views', 'agent', 'ConversationModelSelector.tsx')
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx')
  const styles = readAppFile('renderer', 'src', 'views', 'agent', 'ConversationModelSelector.module.scss')

  assert.match(conversation, /onOpenSettings=\{onOpenModelSettings\}/)
  assert.match(selector, /onOpenSettings\(\)/)
  assert.match(selector, /当前模型：\$\{label\}，点击切换模型/)
  assert.match(shell, /onOpenModelSettings=\{\(\) => openSettings\('models'\)\}/)
  assert.match(styles, /\.trigger/)
  assert.doesNotMatch(styles, /\.trigger \{\s*display: none;/)
})
