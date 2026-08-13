import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8')
const readConversation = () => [
  read('renderer', 'src', 'views', 'agent', 'AgentConversation.tsx'),
  read('renderer', 'src', 'views', 'agent', 'conversation', 'AssistantContent.tsx'),
  read('renderer', 'src', 'views', 'agent', 'conversation', 'ConversationTurns.tsx')
].join('\n')

test('assistant process stays open while running and defaults to expanded after completion', () => {
  const conversation = readConversation()
  const state = read('renderer', 'src', 'views', 'agent', 'thinking-state.ts')

  assert.match(conversation, /partitionAssistantDisplayBlocks\(/)
  assert.match(conversation, /const state = processState\(message, busy && isLast\)/)
  assert.match(conversation, /const isRunning = state\.running/)
  assert.match(conversation, /resolveProcessExpanded\(expanded\[processGroupId\], isRunning\)/)
  assert.match(conversation, /visibleProcessBlocks\.length > 0 \|\| isRunning/)
  assert.match(conversation, /aria-expanded=\{processExpanded\}/)
  assert.match(conversation, /onToggleExpand\(processGroupId, processExpanded\)/)
  assert.match(state, /return manualExpanded \?\? true/)
})

test('thinking and tools share one collapsible process group while final results stay outside', () => {
  const conversation = readConversation()
  const styles = read('renderer', 'src', 'views', 'agent', 'agent.module.scss')
  const state = read('renderer', 'src', 'views', 'agent', 'thinking-state.ts')

  assert.match(conversation, /processDetailBlocks\(visibleProcessBlocks\)/)
  assert.match(conversation, /visibleProcessDetails\.map\(\(block\) =>/)
  assert.match(conversation, /resultBlocks\.map\(\(block\) =>/)
  assert.match(conversation, /if \(status === 'failed'\) return \{ running: false, label: '处理失败' \}/)
  assert.match(conversation, /duration \? `已处理 \$\{duration\}` : '已处理'/)
  assert.match(styles, /\.processGroup/)
  assert.match(styles, /\.processHead:focus-visible/)
  assert.match(styles, /\.processBody/)
  assert.match(styles, /max-height: min\(68dvh, 640px\)/)
  assert.match(styles, /\.processBody \.structuredTableWrap/)
  assert.match(styles, /max-height: min\(58dvh, 540px\)/)
  assert.match(styles, /scrollbar-width: thin/)
  assert.match(styles, /touch-action: pan-y/)
  assert.match(styles, /overscroll-behavior: contain/)
  assert.match(state, /ACTION_BLOCK_TYPES = new Set\(\['error', 'confirm', 'user_input', 'action', 'file_change'\]\)/)
  assert.match(conversation, /if \(b\.type === 'action'\)/)
  assert.match(conversation, /resolveAgentAction\(parseJsonObject\(b\.content\)\)/)
  assert.match(state, /answer_status/)
  assert.match(state, /isCanonicalAnswer/)
  assert.doesNotMatch(state, /blockPhase\(block\)/)
  assert.doesNotMatch(state, /isProcessBlock\(block\)/)
  assert.doesNotMatch(state, /lastProcessIndex/)
  assert.doesNotMatch(state, /block\.title === '回答'/)
  assert.doesNotMatch(state, /dedupeResultBlocks/)
})

test('thinking keeps an independent expanded layer inside the running process', () => {
  const conversation = readConversation()
  const styles = read('renderer', 'src', 'views', 'agent', 'agent.module.scss')
  const state = read('renderer', 'src', 'views', 'agent', 'thinking-state.ts')

  assert.match(conversation, /resolveThinkingExpanded\(expanded, busy, Boolean\(groupedProcess\)\)/)
  assert.match(conversation, /data-grouped=\{groupedProcess \? 'true' : 'false'\}/)
  assert.match(conversation, /onToggleExpand\(b\.id, thinkingExpanded\)/)
  assert.doesNotMatch(conversation, /return <div className=\{styles\.processThinking\}>/)
  assert.match(styles, /\.thinkingBlock\[data-grouped='true'\]/)
  assert.match(state, /return groupedProcess \? manualExpanded \?\? true : resolveProcessExpanded/)
})

test('process header derives a compact progress summary from stable turn items', () => {
  const conversation = readConversation()
  const planProgress = read('renderer', 'src', 'views', 'agent', 'planState.ts')
  const planFloat = read('renderer', 'src', 'views', 'agent', 'PlanStatusFloat.tsx')
  const styles = read('renderer', 'src', 'views', 'agent', 'agent.module.scss')
  const state = read('renderer', 'src', 'views', 'agent', 'thinking-state.ts')
  const reducer = read('renderer', 'src', 'views', 'agent', 'stream', 'reducer.ts')

  assert.match(conversation, /summarizeAssistantProcess\(\[\.\.\.visibleProcessBlocks, \.\.\.resultBlocks\], isRunning\)/)
  assert.match(conversation, /isRunning \? processSummary\.runningLabel : processSummary\.completedLabel/)
  assert.match(conversation, /className=\{styles\.processMeta\}/)
  assert.doesNotMatch(conversation, /PlanProgress/)
  assert.match(planProgress, /const completed = steps\.filter\(\(step\) => step\.state === 'done'\)\.length/)
  assert.match(planProgress, /const failed = steps\.filter\(\(step\) => step\.state === 'failed'\)\.length/)
  assert.match(planProgress, /const skipped = steps\.filter\(\(step\) => step\.state === 'skipped'\)\.length/)
  assert.match(planProgress, /const interrupted = steps\.filter\(\(step\) => step\.state === 'interrupted'\)\.length/)
  assert.match(planProgress, /failed \? `\$\{failed\} 项失败`/)
  assert.match(planProgress, /skipped \? `\$\{skipped\} 项跳过`/)
  assert.match(planProgress, /interrupted \? `\$\{interrupted\} 项停止`/)
  assert.match(planProgress, /\.filter\(Boolean\)\.join\(' · '\)/)
  assert.match(planFloat, /data-plan-float/)
  assert.match(planFloat, /className=\{styles\.planFloatSteps\}/)
  assert.match(planFloat, /data-active=\{active \? 'true' : 'false'\}/)
  assert.match(styles, /\.processMeta/)
  assert.match(styles, /\.planFloat/)
  assert.match(styles, /text-overflow: ellipsis/)
  assert.match(state, /new Set\(blocks\.map\(toolCallKey\)\.filter\(Boolean\)\)\.size/)
  assert.match(state, /item_type/)
  assert.match(state, /runningParts\.join\(' · '\)/)
  assert.match(state, /completedParts\.join\(' · '\)/)
  assert.match(reducer, /turn\/plan\/updated/)
})
