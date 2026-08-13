import { describe, expect, it } from 'vitest'
import type { WorkstationDraft } from './types'
import { mapServerMessage, mergeServerMessages } from './streamAdapter'
import {
  applyWorkstationPatch,
  backfillWorkstationFromMessages,
  mergeStreamBlock,
  reduceContentItem,
  reduceStreamEvent
} from './reducer'

function draft(): WorkstationDraft {
  return {
    tools: new Map(),
    artifacts: new Map(),
    skills: new Map(),
    plan: []
  }
}

describe('agent stream reducer', () => {
  it('projects Codex 0.147 image, sleep, review, retry, and runtime notice events', () => {
    const generated = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'image-1',
      payload: { item: { id: 'image-1', type: 'imageGeneration', status: 'completed', result: 'aW1hZ2U=', revisedPrompt: 'blue whale' } }
    })
    expect(generated.block).toMatchObject({
      id: 'image-1', type: 'image', content: 'data:image/png;base64,aW1hZ2U=', display_type: 'image'
    })

    const viewed = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'view-1',
      payload: { item: { id: 'view-1', type: 'imageView', path: '/tmp/result.png' } }
    })
    expect(viewed.block).toMatchObject({ type: 'image', content: '/tmp/result.png' })

    const sleeping = reduceStreamEvent({
      type: 'item/started',
      item_id: 'sleep-1',
      payload: { item: { id: 'sleep-1', type: 'sleep', durationMs: 500 } }
    })
    expect(sleeping.block).toMatchObject({ type: 'status', title: 'running', metadata: { status: 'inProgress' } })

    const review = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'review-1',
      payload: { item: { id: 'review-1', type: 'enteredReviewMode', review: 'Review current changes' } }
    })
    expect(review.block).toMatchObject({ type: 'status', title: '开始审查' })

    const retry = reduceStreamEvent({
      type: 'error',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      payload: { error: { message: 'temporary overload' }, willRetry: true }
    })
    expect(retry.block).toMatchObject({ id: 'retry:turn-1', type: 'status', title: '正在重试' })
    const completed = reduceStreamEvent({
      type: 'turn/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      payload: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          answer: { status: 'accepted', itemId: 'answer-1', source: 'runtime_terminal' }
        }
      }
    })
    expect(completed.removeBlockId).toBe('retry:turn-1')
    expect(completed.turn).toMatchObject({
      answerStatus: 'accepted',
      answerItemId: 'answer-1',
      answerSource: 'runtime_terminal'
    })

    const warning = reduceStreamEvent({ type: 'warning', payload: { message: 'runtime warning' } })
    expect(warning.block).toMatchObject({ type: 'status', content: 'runtime warning' })
    const configWarning = reduceStreamEvent({ type: 'configWarning', payload: { summary: '配置过期', details: '请更新字段' } })
    expect(configWarning.block).toMatchObject({ type: 'status', content: '配置过期：请更新字段' })
    const rerouted = reduceStreamEvent({ type: 'model/rerouted', payload: { fromModel: 'gpt-old', toModel: 'gpt-new', reason: 'highRiskCyberActivity' } })
    expect(rerouted.block).toMatchObject({ type: 'status', title: '模型已切换', content: expect.stringContaining('gpt-new') })
    const mcpFailed = reduceStreamEvent({
      type: 'mcpServer/startupStatus/updated',
      payload: { name: 'drive', status: 'failed', error: 'auth failed', failureReason: 'oauth' }
    })
    expect(mcpFailed.block).toMatchObject({ type: 'error', title: 'MCP 启动失败', content: 'auth failed' })
    const progress = reduceStreamEvent({
      type: 'item/mcpToolCall/progress', item_id: 'mcp-1', payload: { itemId: 'mcp-1', message: '正在下载' }
    })
    expect(progress.block).toMatchObject({ id: 'result:mcp-1', type: 'tool_result', content: '正在下载' })
  })

  it('projects answer, skill, tool, and workspace items into chat/workstation lanes', () => {
    const answer = reduceStreamEvent({
      type: 'item/agentMessage/delta',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'answer-1',
      payload: {
        delta: 'hello',
        mode: 'append',
        phase: 'final_answer',
        format: 'markdown',
        model: 'test-model',
        metadata: { answer_status: 'accepted' }
      }
    })
    expect(answer.block).toMatchObject({
      id: 'answer-1',
      type: 'markdown',
      content: 'hello',
      metadata: { answer_status: 'accepted', phase: 'final_answer', model: 'test-model' }
    })

    const evidenceUpdate = reduceStreamEvent({
      type: 'item/agentMessage/delta',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'answer-1',
      payload: {
        delta: '',
        mode: 'append',
        phase: 'final_answer',
        format: 'markdown',
        metadata: { evidence_bundle_ref: { id: 'bundle-1', status: 'verified' } }
      }
    })
    expect(evidenceUpdate.block?.metadata?.evidence_bundle_ref).toEqual({ id: 'bundle-1', status: 'verified' })

    const ws = draft()
    const skill = reduceStreamEvent({
      type: 'item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'skill:query-project-data',
      payload: {
        item: { id: 'skill:query-project-data', type: 'skill', name: 'query-project-data', runtime: 'service', status: 'running', reason: 'data question' }
      }
    })
    applyWorkstationPatch(skill.workstation, ws)
    expect(ws.skills.get('query-project-data')).toMatchObject({ name: 'query-project-data', runtime: 'service', status: 'running' })

    const tool = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'tool-1',
      payload: {
        item: { id: 'tool-1', type: 'dynamicToolCall', tool: 'mcp_query', namespace: 'cloud', status: 'inProgress', arguments: '{"sql":"select 1"}' }
      }
    })
    expect(tool.block).toMatchObject({ id: 'tool-1', type: 'tool', title: 'running' })
    applyWorkstationPatch(tool.workstation, ws)
    expect(ws.tools.get('tool-1')).toMatchObject({ name: 'mcp_query', where: 'cloud', status: 'running' })

    const workspace = reduceStreamEvent({
      type: 'item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'workspace-1',
      payload: {
        item: {
          id: 'workspace-1',
          type: 'workspaceEvent',
          data: { event: 'project_ready_for_query', project_id: 'project-1' },
          visibility: 'hidden'
        }
      }
    })
    expect(workspace.workspaceEvent?.project_id).toBe('project-1')
  })

  it('keeps smart query tool progress visible in the chat stream', () => {
    const started = reduceStreamEvent({
      type: 'item/started',
      item_id: 'sql-1',
      payload: {
        item: {
          id: 'sql-1',
          type: 'dynamicToolCall',
          tool: 'execute_readonly_sql',
          status: 'inProgress',
          arguments: '{"question":"查询销售额最高的前10个客户"}'
        }
      }
    })
    expect(started.block).toMatchObject({
      id: 'sql-1',
      type: 'tool',
      title: 'running',
      content: expect.stringContaining('查询数据库')
    })

    const completed = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'sql-1',
      payload: {
        item: {
          id: 'sql-1',
          type: 'dynamicToolCall',
          tool: 'execute_readonly_sql',
          status: 'completed',
          arguments: '{"question":"查询销售额最高的前10个客户"}'
        }
      }
    })
    expect(completed.block).toMatchObject({ id: 'sql-1', type: 'tool', title: 'done' })

    const output = reduceStreamEvent({
      type: 'item/toolCall/outputDelta',
      item_id: 'sql-1',
      payload: {
        name: 'execute_readonly_sql',
        delta: '已查询并存入中间表 r_abcd',
        mode: 'append'
      }
    })
    expect(output.block).toMatchObject({
      id: 'result:sql-1',
      type: 'tool_result',
      title: '查询数据库',
      content: '已查询并存入中间表 r_abcd'
    })
  })

  it('renders native Agent Runtime command, file and MCP items without a legacy adapter', () => {
    const command = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'cmd-1',
      payload: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/tmp/project'
        }
      }
    })
    expect(command.block).toMatchObject({ id: 'cmd-1', type: 'tool', title: 'done' })
    expect(command.workstation?.tool?.value).toMatchObject({ name: 'command', args: 'pwd', result: '/tmp/project' })

    const fileChange = reduceStreamEvent({
      type: 'item/started',
      item_id: 'patch-1',
      payload: {
        item: {
          id: 'patch-1',
          type: 'fileChange',
          status: 'inProgress',
          changes: [{ path: 'README.md', kind: 'update' }]
        }
      }
    })
    expect(fileChange.block).toMatchObject({
      id: 'patch-1',
      type: 'file_change',
      title: 'running',
      metadata: { item_type: 'fileChange' }
    })
    expect(JSON.parse(fileChange.block?.content || '{}').changes).toEqual([
      { path: 'README.md', kind: 'update' }
    ])
    expect(fileChange.workstation).toBeUndefined()

    const mcp = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'mcp-1',
      payload: {
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'github',
          tool: 'list_issues',
          status: 'completed',
          arguments: { state: 'open' },
          result: { count: 2 }
        }
      }
    })
    expect(mcp.workstation?.tool?.value).toMatchObject({ name: 'list_issues', where: 'mcp', status: 'ok' })
  })

  it('keeps rejected and interrupted native states distinct', () => {
    const command = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'cmd-declined',
      payload: { item: { id: 'cmd-declined', type: 'commandExecution', command: 'pwd', status: 'declined' } }
    })
    expect(command.block).toMatchObject({ type: 'tool', title: 'rejected' })

    const file = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'file-stopped',
      payload: { item: { id: 'file-stopped', type: 'fileChange', status: 'interrupted', changes: [] } }
    })
    expect(file.block).toMatchObject({ type: 'file_change', title: 'stopped' })

    const collaboration = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'collab-stopped',
      payload: {
        item: {
          id: 'collab-stopped',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'interrupted',
          receiverThreadIds: ['child-1'],
          agentsStates: { 'child-1': { status: 'interrupted', message: '已停止' } }
        }
      }
    })
    expect(collaboration.block).toMatchObject({ type: 'delegated_subtask', title: 'stopped' })
    expect(JSON.parse(collaboration.block?.content || '{}').status).toBe('interrupted')
  })

  it('backfills tool results from native content items and persisted trace output', () => {
    const native = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'tool-content',
      payload: {
        item: {
          id: 'tool-content',
          type: 'dynamicToolCall',
          tool: 'query_data',
          status: 'completed',
          contentItems: [{ type: 'inputText', text: '真实结果 42' }]
        }
      }
    })
    expect(native.workstation?.tool?.value.result).toBe('真实结果 42')

    const persisted = reduceContentItem({
      id: 'tool-persisted',
      type: 'tool',
      content: 'query_data {"question":"收入"}',
      title: 'done',
      metadata: { tool_name: 'query_data', trace_output: '历史结果 42' }
    })
    expect(persisted.workstation?.tool?.value.result).toBe('历史结果 42')

    const command = reduceContentItem({
      id: 'command-persisted',
      type: 'tool',
      content: 'commandExecution sleep 30',
      title: 'done',
      metadata: { tool_name: 'command', trace_input: 'sleep 30' }
    })
    expect(command.workstation?.tool?.value.args).toBe('sleep 30')

    const webSearch = reduceContentItem({
      id: 'web-search-persisted',
      type: 'tool',
      content: 'webSearch',
      title: 'done',
      metadata: { tool_name: 'web_search', trace_input: 'OpenAI' }
    })
    expect(webSearch.workstation?.tool?.value.args).toBe('OpenAI')
  })

  it('removes hidden trace deltas instead of rendering raw tool decisions', () => {
    const hidden = reduceStreamEvent({
      type: 'item/agentMessage/delta',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'trace-1',
      payload: {
        delta: 'tool_call update_plan {"steps":[]}',
        mode: 'append',
        visibility: 'hidden'
      }
    })

    expect(hidden.block).toBeUndefined()
    expect(hidden.removeBlockId).toBe('trace-1')
    expect(hidden.target).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1', itemId: 'trace-1' })
  })

  it('replays persisted hidden skill items into Workstation without adding chat blocks', () => {
    const patch = reduceContentItem({
      id: 'skill:query-project-data',
      type: 'skill_invocation',
      content: JSON.stringify({ skill_name: 'query-project-data', runtime: 'service', status: 'selected' }),
      metadata: { display: false }
    })

    expect(patch.block).toBeUndefined()
    expect(patch.workstation?.skill?.value).toMatchObject({ name: 'query-project-data', runtime: 'service' })
  })

  it('replaces plan title and state from the latest plan item', () => {
    const ws = draft()
    applyWorkstationPatch(
      reduceStreamEvent({
        type: 'turn/plan/updated',
        item_id: 'plan',
        payload: {
          plan: [
            { title: '查找比赛信息', status: 'doing' },
            { title: '获取第二名成绩', status: 'todo' }
          ]
        }
      }).workstation,
      ws
    )

    expect(ws.plan).toEqual([
      { title: '查找比赛信息', detail: undefined, state: 'running' },
      { title: '获取第二名成绩', detail: undefined, state: 'todo' }
    ])

    applyWorkstationPatch(
      reduceStreamEvent({
        type: 'turn/plan/updated',
        item_id: 'plan',
        payload: {
          plan: [
            { title: '确认 2008 年中奖赛排名', status: 'done' },
            { title: '获取第二名车手完赛时间', status: 'doing' }
          ]
        }
      }).workstation,
      ws
    )

    expect(ws.plan).toEqual([
      { title: '确认 2008 年中奖赛排名', detail: undefined, state: 'done' },
      { title: '获取第二名车手完赛时间', detail: undefined, state: 'running' }
    ])
  })

  it('keeps native Plan-mode output separate from update_plan progress', () => {
    const completed = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'plan-document-1',
      payload: {
        item: {
          id: 'plan-document-1',
          type: 'plan',
          text: '## 实施方案\n\n1. 先检查现状'
        }
      }
    })
    expect(completed.block).toMatchObject({
      id: 'plan-document-1',
      type: 'markdown',
      content: '## 实施方案\n\n1. 先检查现状',
      title: '计划方案',
      metadata: {
        item_type: 'planDocument'
      }
    })
    expect(completed.workstation).toBeUndefined()

    const delta = reduceStreamEvent({
      type: 'item/plan/delta',
      item_id: 'plan-document-1',
      payload: { delta: '## 实施方案' }
    })
    expect(delta.block).toMatchObject({
      type: 'markdown',
      metadata: { item_type: 'planDocument', mode: 'append' }
    })
    expect(delta.workstation).toBeUndefined()
  })

  it('backfills Workstation from hidden skill items after server message mapping', () => {
    const mapped = mapServerMessage({
      role: 'assistant',
      content_items: [
        {
          id: 'skill:file-review',
          type: 'skill_invocation',
          content: JSON.stringify({ skill_name: 'file-review', runtime: 'prompt', status: 'running' }),
          title: 'file-review',
          metadata: { display: false, skill_name: 'file-review' }
        },
        {
          id: 'answer-1',
          type: 'markdown',
          content: '已开始接入数据',
          display_type: 'text',
          metadata: { display: true }
        }
      ]
    })

    expect(mapped.blocks).toHaveLength(1)
    expect(mapped.blocks[0]).toMatchObject({ id: 'answer-1', type: 'markdown', display_type: 'text' })

    const draft = backfillWorkstationFromMessages([mapped])
    expect(draft.skills.get('file-review')).toMatchObject({ name: 'file-review', runtime: 'prompt', status: 'running' })
  })

  it('does not replay a rejected answer candidate as a visible historical answer', () => {
    const mapped = mapServerMessage({
      role: 'assistant',
      content_items: [
        {
          id: 'candidate-1',
          type: 'markdown',
          content: '错误但未通过验收的答案：4',
          title: '待验收回答',
          metadata: { display: false, answer_status: 'rejected', result_role: 'intermediate' }
        },
        {
          id: 'completion-error',
          type: 'error',
          content: '计划未完成',
          title: '计划未完成',
          metadata: { display: true }
        }
      ]
    })

    expect(mapped.blocks.map((block) => block.id)).toEqual(['completion-error'])
    expect(mapped.workstationBlocks?.map((block) => block.id)).toEqual(['completion-error'])
  })

  it('restores explicit Skill selections from the persisted user turn request', () => {
    const mapped = mapServerMessage({
      id: 'user-1',
      role: 'user',
      content_items: [{ id: 'text-1', type: 'text', content: '检查一下' }],
      message_metadata: {
        turn_request: {
          skills: ['plugin-b:review'],
          skill_selections: [{
            selection_key: 'skill:second',
            name: 'review',
            qualified_name: 'plugin-b:review',
            display_name: 'Review',
            plugin_name: 'plugin-b',
            source: 'plugin:plugin-b',
            selection_mode: 'explicit'
          }]
        }
      }
    })

    expect(mapped.skillSelections).toEqual([{
      selectionKey: 'skill:second',
      name: 'review',
      qualifiedName: 'plugin-b:review',
      displayName: 'Review',
      source: 'plugin:plugin-b',
      scope: null,
      pluginName: 'plugin-b',
      version: null,
      digest: null,
      selectionMode: 'explicit'
    }])
  })

  it('restores persisted plan items into the process summary and Workstation', () => {
    const mapped = mapServerMessage({
      role: 'assistant',
      content_items: [
        {
          id: 'plan',
          type: 'plan',
          content: JSON.stringify([
            { title: '查询该客户的公司名称', status: 'done' },
            { title: '整合结果并回答问题', status: 'done' }
          ]),
          metadata: { display: false }
        },
        {
          id: 'answer-1',
          type: 'markdown',
          content: '答案已生成',
          display_type: 'text',
          metadata: { display: true }
        }
      ]
    })

    expect(mapped.blocks).toHaveLength(2)
    expect(mapped.blocks[0]).toMatchObject({ id: 'plan', type: 'plan' })

    const draft = backfillWorkstationFromMessages([mapped])
    expect(draft.plan).toEqual([
      { title: '查询该客户的公司名称', detail: undefined, state: 'done' },
      { title: '整合结果并回答问题', detail: undefined, state: 'done' }
    ])
  })

  it('removes an earlier visible answer when a later persisted fragment rejects the candidate', () => {
    const fragments = [
      mapServerMessage({
        id: 'assistant-fragment-1',
        role: 'assistant',
        message_metadata: { turn_id: 'turn-1' },
        content_items: [{
          id: 'answer-1',
          type: 'markdown',
          content: '未经校验的回答',
            metadata: { display: true, answer_status: 'rejected' }
        }]
      }),
      mapServerMessage({
        id: 'assistant-fragment-2',
        role: 'assistant',
        message_metadata: { turn_id: 'turn-1' },
        content_items: [
          {
            id: 'answer-1',
            type: 'markdown',
            content: '未经校验的回答',
            metadata: { display: false, answer_status: 'rejected' }
          },
          {
            id: 'error-1',
            type: 'error',
            content: '查询结果未完成校验',
            metadata: { display: true }
          }
        ]
      })
    ]

    const merged = mergeServerMessages(fragments)
    expect(merged).toHaveLength(1)
    expect(merged[0].blocks.map((block) => block.id)).toEqual(['error-1'])
    expect(merged[0].workstationBlocks?.map((block) => block.id)).toEqual(['error-1'])
  })

  it('does not mark failed user input resolution as resolved', () => {
    const failed = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'user_input:ask-1',
      payload: { item: { id: 'user_input:ask-1', type: 'userInput', request_id: 'ask-1', value: 'Alpha', status: 'failed' } }
    })
    expect(failed.block).toMatchObject({
      id: 'user_input:ask-1',
      type: 'user_input',
      title: 'failed',
      metadata: { status: 'failed', response: 'Alpha' }
    })

    const answered = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'user_input:ask-1',
      payload: { item: { id: 'user_input:ask-1', type: 'userInput', request_id: 'ask-1', value: 'Alpha', status: 'answered' } }
    })
    expect(answered.block).toMatchObject({
      title: 'resolved',
      metadata: { status: 'answered', response: 'Alpha' }
    })
  })

  it('updates approval cards without losing the original command text', () => {
    const approvalRequest = {
      action: 'bash',
      risk: 'command_execution',
      target: 'pwd',
      sandbox: { system_enforced: true, mode: 'workspace-write', network: 'blocked' },
      network: 'blocked',
      approval_scope: 'once'
    }
    const requested = reduceStreamEvent({
      type: 'item/started',
      item_id: 'confirm:call-1',
      payload: {
        item: { id: 'confirm:call-1', type: 'approval', toolCallId: 'call-1', tool: 'bash', status: 'requested', summary: 'bash {"cmd":"pwd"}', approvalRequest }
      }
    })
    expect(requested.block).toMatchObject({
      id: 'confirm:call-1',
      type: 'confirm',
      content: 'bash {"cmd":"pwd"}',
      metadata: { approval_request: approvalRequest }
    })

    const resolved = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'confirm:call-1',
      payload: {
        item: { id: 'confirm:call-1', type: 'approval', toolCallId: 'call-1', status: 'approved', summary: 'bash {"cmd":"pwd"}', approvalRequest }
      }
    })
    expect(resolved.block).toMatchObject({
      id: 'confirm:call-1',
      title: 'approved',
      content: 'bash {"cmd":"pwd"}',
      metadata: { approval_request: approvalRequest }
    })
  })

  it('updates one delegated subtask block from running to completed', () => {
    const started = reduceStreamEvent({
      type: 'item/started',
      item_id: 'subtask:child-1',
      payload: { item: {
        id: 'subtask:child-1', type: 'subtask', runId: 'child-1', parentRunId: 'parent-1',
        callId: 'call-1', subtaskType: 'schema_investigation', title: 'Schema 调查',
        tool: 'grep_tables', status: 'inProgress', parallelGroup: 'readonly-1'
      } }
    })
    expect(started.block).toMatchObject({
      id: 'subtask:child-1',
      type: 'subtask',
      title: 'running',
      metadata: { run_id: 'child-1', subtask_type: 'schema_investigation', tool_name: 'grep_tables' }
    })

    const completed = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'subtask:child-1',
      payload: { item: {
        id: 'subtask:child-1', type: 'subtask', runId: 'child-1', parentRunId: 'parent-1',
        callId: 'call-1', subtaskType: 'schema_investigation', title: 'Schema 调查',
        tool: 'grep_tables', status: 'completed', summary: '子任务已完成', parallelGroup: 'readonly-1'
      } }
    })
    expect(completed.block).toMatchObject({ type: 'subtask', title: 'done', content: '子任务已完成' })
  })

  it('projects user input action events into confirmation cards', () => {
    const requested = reduceStreamEvent({
      type: 'item/started',
      item_id: 'user_input:ask-1',
      payload: {
        item: {
          id: 'user_input:ask-1',
          type: 'userInput',
          request_id: 'ask-1',
          run_id: 'run-1',
          resume_handle: { type: 'user_input_resume', run_id: 'run-1', session_id: 'session-1', request_id: 'ask-1' },
          prompt: '请选择客户',
          options: [{ label: '宏远科技' }],
          status: 'requested'
        }
      }
    })
    expect(requested.block).toMatchObject({ id: 'user_input:ask-1', type: 'user_input', title: 'requested' })
    expect(JSON.parse(requested.block?.content || '{}')).toMatchObject({
      request_id: 'ask-1',
      run_id: 'run-1',
      resume_handle: { type: 'user_input_resume', run_id: 'run-1', session_id: 'session-1', request_id: 'ask-1' },
      prompt: '请选择客户',
      options: [{ label: '宏远科技' }]
    })

    const resolved = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'user_input:ask-1',
      payload: {
        item: { id: 'user_input:ask-1', type: 'userInput', request_id: 'ask-1', value: '宏远科技', status: 'answered' }
      }
    })
    expect(resolved.block).toMatchObject({ id: 'user_input:ask-1', type: 'user_input', title: 'resolved' })
  })

  it('renders legacy artifact events as visible deliverables and keeps Workstation metadata', () => {
    const patch = reduceStreamEvent({
      type: 'item/completed',
      item_id: 'file:/tmp/dsh/projects/__chat__/red_solid.png',
      payload: {
        item: {
          id: 'file:/tmp/dsh/projects/__chat__/red_solid.png',
          type: 'artifact',
          artifact_id: 'file:/tmp/dsh/projects/__chat__/red_solid.png',
          kind: 'image',
          name: 'red_solid.png',
          path: '/tmp/dsh/projects/__chat__/red_solid.png',
          source_tool_call_id: 'tool-image'
        }
      }
    })

    expect(patch.workstation?.artifact?.value).toMatchObject({ name: 'red_solid.png', kind: 'image' })
    expect(patch.block).toMatchObject({
      type: 'file',
      title: 'red_solid.png',
      display_type: 'file',
      metadata: {
        result_role: 'deliverable',
        artifact_id: 'file:/tmp/dsh/projects/__chat__/red_solid.png'
      }
    })
    expect(JSON.parse(patch.block?.content || '{}')).toMatchObject({
      path: '/tmp/dsh/projects/__chat__/red_solid.png',
      kind: 'image'
    })
  })

  it('routes lifecycle events by thread, turn and item id', () => {
    const started = reduceStreamEvent({
      type: 'turn/started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: null,
      payload: {
        messageId: 'assistant-1',
        turn: { id: 'turn-1', status: 'inProgress', startedAt: 100, durationMs: null }
      }
    })
    expect(started).toMatchObject({
      target: { threadId: 'thread-1', turnId: 'turn-1', itemId: null },
      turn: { messageId: 'assistant-1', status: 'inProgress', startedAtMs: 100000 }
    })

    const delta = reduceStreamEvent({
      type: 'item/agentMessage/delta',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'answer-1',
      payload: {
        delta: '最终答案',
        mode: 'append',
        phase: 'final_answer',
        format: 'markdown',
        metadata: { answer_status: 'accepted' }
      }
    })
    expect(delta).toMatchObject({
      target: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1' },
      block: {
        id: 'answer-1',
        content: '最终答案',
        metadata: { item_type: 'agentMessage', answer_status: 'accepted' }
      }
    })

    const completed = reduceStreamEvent({
      type: 'turn/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: null,
      payload: {
        turn: { id: 'turn-1', status: 'completed', startedAt: 100, completedAt: 101, durationMs: 1350, error: null }
      }
    })
    expect(completed.turn).toMatchObject({ status: 'completed', durationMs: 1350, completedAtMs: 101000 })
  })

  it('keeps the native turn diff as a dedicated review projection', () => {
    const patch = reduceStreamEvent({
      type: 'turn/diff/updated',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      payload: {
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new'
      }
    })

    expect(patch.block).toBeUndefined()
    expect(patch.workstation).toBeUndefined()
    expect(patch.turnDiff).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      diff: expect.stringContaining('diff --git a/README.md')
    })
  })

  it('does not infer answer metadata from an item phase while appending deltas', () => {
    const started = reduceStreamEvent({
      type: 'item/started',
      item_id: 'commentary-1',
      payload: { item: { id: 'commentary-1', type: 'agentMessage', text: '', phase: 'commentary' } }
    }).block!
    const delta = reduceStreamEvent({
      type: 'item/agentMessage/delta',
      item_id: 'commentary-1',
      payload: { delta: '正在查询', mode: 'append' }
    }).block!

    expect(mergeStreamBlock(started, delta)).toMatchObject({
      content: '正在查询',
      metadata: { mode: 'append' }
    })
  })

  it('renders automatic context compaction as one lightweight lifecycle marker', () => {
    const started = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'compact-1',
      payload: { item: { id: 'compact-1', type: 'contextCompaction' } }
    })
    expect(started.block).toMatchObject({
      id: 'compact-1',
      type: 'compact',
      content: '',
      title: 'running'
    })

    const completed = reduceStreamEvent({
      type: 'item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'compact-1',
      payload: { item: { id: 'compact-1', type: 'contextCompaction' } }
    })
    expect(completed.block).toMatchObject({
      id: 'compact-1',
      type: 'compact',
      content: '上下文已自动压缩',
      title: 'done',
      metadata: { trigger: 'auto', mode: 'replace' }
    })
  })

  it('maps reasoning, plan, tool and data results into their stable lanes', () => {
    const reasoning = reduceStreamEvent({
      type: 'item/reasoning/summaryTextDelta',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'reasoning-1',
      payload: { delta: '先查看数据', mode: 'append' }
    })
    expect(reasoning.block).toMatchObject({ id: 'reasoning-1', type: 'thinking', content: '先查看数据' })

    const plan = reduceStreamEvent({
      type: 'turn/plan/updated',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'plan',
      payload: { plan: [{ step: '查询数据', status: 'inProgress' }] }
    })
    expect(plan.block).toMatchObject({ id: 'plan', type: 'plan', title: '已更新计划' })
    expect(plan.workstation?.plan).toEqual([{ title: '查询数据', detail: undefined, state: 'running' }])

    const tool = reduceStreamEvent({
      type: 'item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'tool-1',
      payload: {
        item: { id: 'tool-1', type: 'dynamicToolCall', tool: 'execute_readonly_sql', status: 'completed', arguments: '{}' }
      }
    })
    expect(tool.block).toMatchObject({ id: 'tool-1', type: 'tool', title: 'done' })
    expect(tool.workstation?.tool?.value).toMatchObject({ name: 'execute_readonly_sql', status: 'ok' })

    const data = reduceStreamEvent({
      type: 'dsh/item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'table-1',
      payload: {
        item: { id: 'table-1', type: 'dataResult', format: 'table', content: { rows: [] }, phase: 'commentary' }
      }
    })
    expect(data.block).toMatchObject({
      id: 'table-1',
      type: 'table',
      metadata: { item_type: 'dataResult' }
    })

    const action = reduceStreamEvent({
      type: 'dsh/item/completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'action-1',
      payload: {
        item: {
          id: 'action-1',
          type: 'dataResult',
          format: 'action',
          content: { type: 'navigate', label: '添加数据源', target: 'project.settings.datasource' }
        }
      }
    })
    expect(action.block).toMatchObject({
      id: 'action-1',
      type: 'action',
      metadata: { item_type: 'dataResult' }
    })
  })

  it('merges persisted fragments of the same resumed turn', () => {
    const messages = mergeServerMessages([
      mapServerMessage({
        id: 'assistant-a',
        role: 'assistant',
        session_id: 'thread-1',
        message_metadata: { turn_id: 'turn-1', turn_status: 'suspended', duration_ms: 100 },
        content_items: [{ id: 'ask-1', type: 'user_input', content: '{}', metadata: { display: true } }]
      }),
      mapServerMessage({
        id: 'assistant-b',
        role: 'assistant',
        session_id: 'thread-1',
        message_metadata: { turn_id: 'turn-1', turn_status: 'completed', duration_ms: 200 },
        content_items: [{ id: 'answer-1', type: 'markdown', content: '完成', metadata: { phase: 'final_answer' } }]
      })
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'assistant-a', turnId: 'turn-1', status: 'completed', durationMs: 300 })
    expect(messages[0].blocks.map((block) => block.id)).toEqual(['ask-1', 'answer-1'])
  })

  it('restores the persisted runtime turn diff with the assistant message', () => {
    const message = mapServerMessage({
      id: 'assistant-diff',
      role: 'assistant',
      session_id: 'thread-1',
      message_metadata: {
        turn_id: 'turn-diff',
        turn_status: 'completed',
        turn_diff: 'diff --git a/a.md b/a.md\n-old\n+new'
      },
      content_items: [{
        id: 'change-1',
        type: 'file_change',
        content: JSON.stringify({ changes: [{ path: 'a.md', kind: 'update' }], status: 'completed' }),
        metadata: { item_type: 'fileChange' }
      }]
    })

    expect(message.turnDiff).toContain('diff --git a/a.md b/a.md')
    expect(message.blocks[0]).toMatchObject({ type: 'file_change', metadata: { item_type: 'fileChange' } })
  })

  it('attaches namespaced file reference annotations without replacing completed message text', () => {
    const patch = reduceStreamEvent({
      type: 'dsh/messageAnnotations/updated',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'message-1',
      payload: {
        textHash: 'sha256:text',
        annotations: [{
          id: 'annotation-1',
          type: 'fileReference',
          range: { start: 0, end: 4, unit: 'unicodeCodePoint' },
          target: { workspaceId: 'thread-1', path: 'README.md' }
        }]
      }
    })
    expect(patch.block).toMatchObject({
      id: 'message-1',
      content: '',
      metadata: { mode: 'append', text_hash: 'sha256:text' }
    })
    const merged = mergeStreamBlock(
      { id: 'message-1', type: 'markdown', content: '查看 README', metadata: {} },
      patch.block!
    )
    expect(merged.content).toBe('查看 README')
    expect(merged.metadata?.annotations).toHaveLength(1)
  })

  it('projects native Codex child-agent lifecycle items without a legacy subtask adapter', () => {
    const started = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'parent-1',
      turn_id: 'turn-1',
      item_id: 'collab-1',
      payload: {
        item: {
          id: 'collab-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: 'parent-1',
          receiverThreadIds: ['child-1'],
          prompt: '检查回归测试',
          model: 'gpt-test',
          reasoningEffort: 'high',
          agentsStates: { 'child-1': { status: 'running', message: null } }
        }
      }
    })
    expect(started.block).toMatchObject({
      id: 'collab-1',
      type: 'delegated_subtask',
      title: 'running',
      metadata: {
        source: 'app-server',
        subtask_title: '创建子任务',
        child_thread_ids: ['child-1'],
        parent_thread_id: 'parent-1'
      }
    })
    expect(JSON.parse(started.block?.content || '{}')).toMatchObject({
      version: 'codex_native_collaboration.v1',
      source: 'app-server',
      child_thread_ids: ['child-1'],
      status: 'running',
      model: 'gpt-test',
      reasoning_effort: 'high'
    })

    const completed = reduceStreamEvent({
      type: 'item/completed',
      thread_id: 'parent-1',
      turn_id: 'turn-1',
      item_id: 'collab-1',
      payload: {
        item: {
          id: 'collab-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'parent-1',
          receiverThreadIds: ['child-1'],
          prompt: '检查回归测试',
          agentsStates: { 'child-1': { status: 'errored', message: '测试失败' } }
        }
      }
    })
    expect(completed.block).toMatchObject({
      id: 'collab-1',
      type: 'delegated_subtask',
      title: 'error'
    })
    expect(JSON.parse(completed.block?.content || '{}')).toMatchObject({
      status: 'failed',
      summary: '测试失败'
    })
  })
})

describe('dshView retention in tool blocks', () => {
  it('keeps call and result views together on one completed tool block', () => {
    const tool = reduceStreamEvent({
      type: 'item/completed',
      thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'tool-combined',
      payload: {
        item: {
          id: 'tool-combined', type: 'dynamicToolCall', tool: 'bash', status: 'completed',
          arguments: '{"command":"pwd"}',
          contentItems: [{ type: 'inputText', text: '/repo' }],
          dshCallView: { for: 'call', view: { card: 'terminal', title: 'pwd', cwd: '/repo' } },
          dshResultView: { for: 'result', view: { card: 'terminal', output: '/repo', exitCode: 0 } }
        }
      }
    })
    expect(tool.block).toMatchObject({ id: 'tool-combined', type: 'tool', title: 'done' })
    expect(tool.block?.metadata?.dshCallView?.view).toMatchObject({ card: 'terminal', cwd: '/repo' })
    expect(tool.block?.metadata?.dshResultView?.view).toMatchObject({ card: 'terminal', output: '/repo', exitCode: 0 })
    expect(tool.block?.metadata?.resultText).toBe('/repo')
  })

  it('keeps a parsed terminal call view on the tool block metadata', () => {
    const tool = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'tool-dsh-1',
      payload: {
        item: {
          id: 'tool-dsh-1',
          type: 'dynamicToolCall',
          tool: 'bash',
          status: 'inProgress',
          arguments: '{"command":"ls"}',
          dshView: { for: 'call', view: { card: 'terminal', title: 'ls -la', cwd: '/tmp' } }
        }
      }
    })
    expect(tool.block?.metadata?.dshView).toMatchObject({
      for: 'call',
      view: { card: 'terminal', title: 'ls -la', cwd: '/tmp' }
    })
    // The label is the DSH presenter's title, not the tool name.
    expect(tool.block?.content).toContain('ls -la')
  })

  it('keeps a generic call view and uses its title as the label', () => {
    const tool = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'tool-dsh-2',
      payload: {
        item: {
          id: 'tool-dsh-2', type: 'dynamicToolCall', tool: 'project_list', status: 'inProgress', arguments: '{}',
          dshView: { for: 'call', view: { card: 'generic', title: 'List projects', kind: 'search' } }
        }
      }
    })
    expect(tool.block?.metadata?.dshView?.view?.card).toBe('generic')
    expect(tool.block?.content).toContain('List projects')
  })

  it('keeps a diff call view', () => {
    const tool = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'tool-dsh-3',
      payload: {
        item: {
          id: 'tool-dsh-3', type: 'dynamicToolCall', tool: 'write', status: 'inProgress', arguments: '{}',
          dshView: { for: 'call', view: { card: 'diff', title: 'Write foo.txt', diffs: [{ path: 'foo.txt', oldText: null, newText: 'hi' }] } }
        }
      }
    })
    expect(tool.block?.metadata?.dshView?.view?.card).toBe('diff')
  })

  it('falls back to TOOL_LABELS when dshView is absent', () => {
    const tool = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'tool-dsh-4',
      payload: {
        item: { id: 'tool-dsh-4', type: 'dynamicToolCall', tool: 'execute_readonly_sql', status: 'inProgress', arguments: '{}' }
      }
    })
    expect(tool.block?.metadata?.dshView).toBeUndefined()
    expect(tool.block?.content).toContain('查询数据库')
  })

  it('tolerates a malformed dshView (missing card) by falling back', () => {
    const tool = reduceStreamEvent({
      type: 'item/started',
      thread_id: 'thread-1', turn_id: 'turn-1', item_id: 'tool-dsh-5',
      payload: {
        item: {
          id: 'tool-dsh-5', type: 'dynamicToolCall', tool: 'grep_tables', status: 'inProgress', arguments: '{}',
          dshView: { for: 'call', view: { title: 'no card here' } }
        }
      }
    })
    // Malformed view is dropped; the tool-name label table provides the fallback.
    expect(tool.block?.metadata?.dshView).toBeUndefined()
    expect(tool.block?.content).toContain('检索表')
  })

  it('history path (mapServerMessage) projects a persisted tool item to the same block shape as live', () => {
    const message = {
      id: 'm1', role: 'assistant', content_items: [
        {
          id: 'tool-hist-1', type: 'dynamicToolCall', tool: 'bash', status: 'completed',
          arguments: '{"command":"pwd"}',
          dshView: { for: 'call', view: { card: 'terminal', title: 'pwd', cwd: '/repo' } }
        }
      ]
    }
    const msg = mapServerMessage(message)
    const block = msg.blocks[0]
    // History tool blocks share the live shape: type 'tool' (not 'dynamicToolCall') + dshView retained.
    expect(block).toMatchObject({ id: 'tool-hist-1', type: 'tool' })
    expect(block.metadata?.dshView).toMatchObject({ for: 'call', view: { card: 'terminal', title: 'pwd', cwd: '/repo' } })
    expect(block.content).toContain('pwd')
  })

  it('history path falls back to the raw item type when the item is not tool-shaped', () => {
    const message = {
      id: 'm2', role: 'assistant', content_items: [
        { id: 'b1', type: 'agentMessage', content: 'hello', status: 'completed' }
      ]
    }
    const msg = mapServerMessage(message)
    expect(msg.blocks[0]).toMatchObject({ id: 'b1', type: 'agentMessage', content: 'hello' })
  })
})
