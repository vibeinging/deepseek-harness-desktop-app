import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8')

test('conversation keeps breathing room above a compact growing composer', () => {
  const conversation = read('renderer', 'src', 'views', 'agent', 'AgentConversation.tsx')
  const styles = read('renderer', 'src', 'views', 'agent', 'agent.module.scss')

  assert.match(conversation, /data-testid="agent-message-input"[\s\S]*rows=\{1\}/)
  assert.match(styles, /padding: 8px 10px/)
  assert.match(styles, /padding: 0 clamp\(14px, 2vw, 24px\) clamp\(14px, 2vw, 22px\)/)
  assert.match(styles, /min-height: 40px/)
  assert.match(styles, /max-height: 160px/)
  assert.match(styles, /field-sizing: content/)
})
