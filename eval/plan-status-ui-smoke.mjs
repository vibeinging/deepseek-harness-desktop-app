import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'plan-status-ui-smoke-'))
const dbPath = path.join(evalHome, '.dsh', 'local.db')
process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

let session = null
try {
  session = await openSession({ port: 9361 })
  const ui = makeUiDriver(session)
  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    return true;
  `)

  const prepared = await session.evalJs(`
    const projectResponse = await window.electronAPI.apiRequest({
      method: 'POST',
      url: '/api/projects',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '计划浮窗测试' })
    });
    const projectId = projectResponse.json?.data?.id || projectResponse.json?.data?.project_id;
    const sessionResponse = await window.electronAPI.apiRequest({
      method: 'POST',
      url: '/api/projects/' + encodeURIComponent(projectId) + '/sessions',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '计划位置检查',
        source_type: 'agent',
        source_id: projectId,
        action_type: 'agentic_chat'
      })
    });
    return { projectId, sessionId: sessionResponse.json?.data?.id };
  `, { timeoutMs: 20_000 })
  assert.equal(typeof prepared.projectId, 'string', JSON.stringify(prepared))
  assert.equal(typeof prepared.sessionId, 'string', JSON.stringify(prepared))

  const userMessageId = randomUUID()
  const assistantMessageId = randomUUID()
  const userItems = [{ id: 'user-text', type: 'text', content: '检查计划应该显示在哪里' }]
  const assistantItems = [
    {
      id: 'commentary-1',
      type: 'markdown',
      content: '我会按计划检查数据。',
      metadata: { item_type: 'agentMessage', phase: 'commentary' }
    },
    {
      id: 'plan-1',
      type: 'plan',
      content: JSON.stringify([
        { step: '检查数据结构', status: 'completed' },
        { step: '查询目标记录', status: 'in_progress' },
        { step: '核对结果', status: 'pending' }
      ]),
      metadata: { item_type: 'plan', msg_category: 'status' }
    },
    {
      id: 'answer-1',
      type: 'markdown',
      content: '当前检查尚未完成。',
      metadata: { item_type: 'agentMessage', phase: 'final_answer' }
    }
  ]
  execFileSync('sqlite3', [dbPath, [
    `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at) VALUES (${sqlText(userMessageId)},${sqlText(prepared.sessionId)},'user',${sqlText(JSON.stringify(userItems))},1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`,
    `INSERT INTO session_messages (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at) VALUES (${sqlText(assistantMessageId)},${sqlText(prepared.sessionId)},'assistant',${sqlText(JSON.stringify(assistantItems))},${sqlText(JSON.stringify({ turn_status: 'completed' }))},2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);`,
    `UPDATE sessions SET message_count=2,updated_at=CURRENT_TIMESTAMP WHERE id=${sqlText(prepared.sessionId)};`
  ].join('\n')])

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  const conversationSelector = `[data-agent-conv-id="${prepared.sessionId}"]`
  await ui.waitFor(conversationSelector, { timeout: 30_000 })
  await ui.click(conversationSelector)
  await ui.waitFor('[data-plan-float]', { timeout: 15_000 })

  await ui.click('[data-agent-process-toggle]')
  const placement = await session.evalJs(`
    const assistant = document.querySelector('[data-message-role="assistant"]');
    const planFloat = document.querySelector('[data-plan-float]');
    return {
      floatingSteps: planFloat?.querySelectorAll('li').length || 0,
      inlinePlanLists: assistant?.querySelectorAll('[data-plan-progress], [data-plan-float]').length || 0,
      processText: assistant?.querySelector('[data-agent-process]')?.textContent || '',
      floatText: planFloat?.textContent || ''
    };
  `)
  assert.equal(placement.floatingSteps, 3, JSON.stringify(placement))
  assert.equal(placement.inlinePlanLists, 0, JSON.stringify(placement))
  assert.match(placement.processText, /1\/3 已完成/)
  assert.match(placement.floatText, /查询目标记录/)

  await ui.click('[data-plan-float] button[aria-label="最小化计划浮窗"]')
  assert.equal(
    await session.evalJs(`return document.querySelector('[data-plan-float]')?.getAttribute('data-minimized')`),
    'true'
  )

  console.log('[plan-status-ui-smoke] PASS 计划详情仅在独立浮窗展示，消息区保留紧凑摘要')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
