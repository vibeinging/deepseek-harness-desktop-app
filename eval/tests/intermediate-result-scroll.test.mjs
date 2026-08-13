import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8')

test('multi-row intermediate results keep a useful height and scroll independently', () => {
  const conversation = [
    read('renderer', 'src', 'views', 'agent', 'AgentConversation.tsx'),
    read('renderer', 'src', 'views', 'agent', 'conversation', 'AssistantContent.tsx')
  ].join('\n')
  const styles = read('renderer', 'src', 'views', 'agent', 'agent.module.scss')
  const processBodyRule = styles.match(/\.processBody \{([^}]+)\}/)?.[1] || ''

  assert.match(
    conversation,
    /if \(\(displayType === 'table'[\s\S]*data-scrollable=\{rows\.length > 6 \? 'true' : 'false'\}[\s\S]*structuredTableWrap/
  )
  assert.match(processBodyRule, /display: grid;/)
  assert.match(processBodyRule, /grid-auto-rows: max-content;/)
  assert.match(processBodyRule, /align-content: start;/)
  assert.match(styles, /\.processBody > \* \{\s*max-width: 100%;/)
  assert.doesNotMatch(processBodyRule, /flex/)
  assert.match(styles, /\.structuredBlock \{\s*flex: none;\s*min-width: 0;/)
  assert.match(styles, /\.processBody \.structuredBlock\[data-scrollable='true'\] \.structuredTableWrap \{\s*height: clamp\(320px, 44dvh, 420px\);/)
  assert.match(styles, /\.structuredTableWrap \{[\s\S]*overflow-y: auto;[\s\S]*scrollbar-gutter: stable;[\s\S]*touch-action: pan-x pan-y;/)
  assert.match(styles, /\.structuredTable th \{\s*position: sticky;\s*top: 0;/)
})
