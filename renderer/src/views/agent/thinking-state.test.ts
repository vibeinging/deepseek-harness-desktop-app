import { describe, expect, it } from 'vitest'
import {
  partitionAssistantBlocks,
  partitionAssistantDisplayBlocks,
  processDetailBlocks,
  resolveProcessExpanded,
  resolveThinkingExpanded,
  summarizeAssistantProcess
} from './thinking-state'

describe('assistant process expansion', () => {
  it('defaults to expanded so process content is visible without a click', () => {
    expect(resolveProcessExpanded(undefined, true)).toBe(true)
    expect(resolveProcessExpanded(undefined, false)).toBe(true)
  })

  it('keeps the user choice when the stream state changes', () => {
    expect(resolveProcessExpanded(false, true)).toBe(false)
    expect(resolveProcessExpanded(true, false)).toBe(true)
  })
})

describe('nested thinking expansion', () => {
  it('defaults to expanded inside a process so reasoning is immediately visible', () => {
    expect(resolveThinkingExpanded(undefined, true, true)).toBe(true)
    expect(resolveThinkingExpanded(undefined, false, true)).toBe(true)
  })

  it('keeps the user choice independently from the outer process', () => {
    expect(resolveThinkingExpanded(true, true, true)).toBe(true)
    expect(resolveThinkingExpanded(false, false, true)).toBe(false)
  })

  it('preserves the standalone thinking behavior', () => {
    expect(resolveThinkingExpanded(undefined, true, false)).toBe(true)
    expect(resolveThinkingExpanded(undefined, false, false)).toBe(true)
  })
})

describe('assistant process partition', () => {
  it('keeps failed and skipped plan states in the completed summary', () => {
    const blocks = [{
      id: 'plan-1',
      type: 'plan',
      content: JSON.stringify([
        { title: '查询数据', status: 'completed' },
        { title: '校验口径', status: 'failed' },
        { title: '备用来源', status: 'skipped' }
      ])
    }]

    expect(summarizeAssistantProcess(blocks, false).completedLabel)
      .toBe('1/3 已完成 · 1 项失败 · 1 项跳过')
  })

  it('keeps skill selection in the summary without repeating it in the expanded details', () => {
    const blocks = [
      {
        id: 'skill:query-project-data',
        type: 'status',
        content: '使用能力 query-project-data',
        metadata: { item_type: 'skill', msg_category: 'status' }
      },
      { id: 'thinking-1', type: 'thinking', content: '先理解用户问题' }
    ]

    const partitioned = partitionAssistantBlocks(blocks)

    expect(partitioned.processBlocks.map((block) => block.id)).toEqual([
      'skill:query-project-data',
      'thinking-1'
    ])
    expect(processDetailBlocks(partitioned.processBlocks).map((block) => block.id)).toEqual([
      'thinking-1'
    ])
    expect(summarizeAssistantProcess(blocks, true).runningLabel).toBe('使用能力 query-project-data')
  })

  it('keeps plan state in the summary without repeating the full plan in the process body', () => {
    const plan = {
      id: 'plan-1',
      type: 'plan',
      content: JSON.stringify([{ step: '查询数据', status: 'in_progress' }]),
      metadata: { item_type: 'plan' }
    }

    expect(processDetailBlocks([plan]).map((block) => block.id)).toEqual([])
    expect(summarizeAssistantProcess([plan], true).runningLabel).toBe('第 1/1 步 · 查询数据')
  })

  it('groups thinking and intermediate text while keeping the canonical answer visible', () => {
    const blocks = [
      { id: 'think-1', type: 'thinking', content: '先检查数据' },
      { id: 'note-1', type: 'markdown', content: '我先查询数据库。', metadata: { item_type: 'agentMessage', phase: 'commentary' } },
      { id: 'tool-1', type: 'tool', content: '查询数据库' },
      { id: 'result-1', type: 'tool_result', content: '4 rows' },
      { id: 'answer-1', type: 'markdown', content: '最终有 4 名员工。', metadata: { item_type: 'agentMessage', answer_status: 'accepted' } }
    ]

    const partitioned = partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' })

    expect(partitioned.processBlocks.map((block) => block.id)).toEqual([
      'think-1',
      'note-1',
      'tool-1',
      'result-1'
    ])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['answer-1'])
  })

  it('keeps structured results and user actions outside the process group', () => {
    const blocks = [
      { id: 'think-1', type: 'thinking', content: '生成图表' },
      { id: 'chart-1', type: 'json', content: '{}', metadata: { item_type: 'dataResult', phase: 'final_answer' } },
      { id: 'confirm-1', type: 'confirm', content: '确认写入' },
      { id: 'action-1', type: 'action', content: '{"target":"project.settings.datasource"}' },
      { id: 'change-1', type: 'file_change', content: '{"changes":[{"path":"sum.js"}]}' }
    ]

    const partitioned = partitionAssistantBlocks(blocks)

    expect(partitioned.processBlocks.map((block) => block.id)).toEqual(['think-1'])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['chart-1', 'confirm-1', 'action-1', 'change-1'])
  })

  it('keeps generated media outside the collapsed process for current and legacy messages', () => {
    const blocks = [
      { id: 'tool-1', type: 'tool', content: 'image_gen {}' },
      {
        id: 'image-1',
        type: 'image',
        content: 'data:image/png;base64,aW1hZ2U=',
        metadata: { item_type: 'dataResult', phase: 'commentary', source_tool_call_id: 'tool-1' }
      },
      {
        id: 'audio-1',
        type: 'audio',
        content: 'data:audio/mpeg;base64,YXVkaW8=',
        metadata: { item_type: 'dataResult', phase: 'commentary', source_tool_call_id: 'tool-1' }
      },
      { id: 'answer-1', type: 'markdown', content: '图片已生成。', metadata: { answer_status: 'accepted' } }
    ]

    const partitioned = partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' })
    expect(partitioned.processBlocks.map((block) => block.id)).toEqual(['tool-1'])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['image-1', 'audio-1', 'answer-1'])
  })

  it('places the completed answer before generated media without moving source cards', () => {
    const blocks = [
      { id: 'memory-1', type: 'global_memory', content: '{}' },
      { id: 'image-1', type: 'image', content: 'data:image/png;base64,aW1hZ2U=' },
      { id: 'answer-1', type: 'markdown', content: '图片已生成。', metadata: { answer_status: 'accepted' } }
    ]

    const completed = partitionAssistantDisplayBlocks(blocks, true, { status: 'accepted', itemId: 'answer-1' })
    expect(completed.resultBlocks.map((block) => block.id)).toEqual(['memory-1', 'answer-1', 'image-1'])
  })

  it('keeps every structured deliverable outside the process group', () => {
    const blocks = [
      { id: 'tool-1', type: 'tool', content: 'create_report {}' },
      {
        id: 'file-1',
        type: 'file',
        content: '{"name":"report.pdf"}',
        metadata: { item_type: 'dataResult', phase: 'commentary', result_role: 'deliverable' }
      },
      {
        id: 'table-1',
        type: 'table',
        content: '{}',
        metadata: { item_type: 'dataResult', result_role: 'intermediate' }
      }
    ]

    const partitioned = partitionAssistantBlocks(blocks)
    expect(partitioned.processBlocks.map((block) => block.id)).toEqual(['tool-1', 'table-1'])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['file-1'])
  })

  it('hides legacy project-memory blocks while keeping user-facing source cards visible', () => {
    const blocks = [
      { id: 'think-1', type: 'thinking', content: '准备回答' },
      { id: 'project-memory', type: 'project_memory', content: '{}', metadata: { item_type: 'dataResult', phase: 'commentary' } },
      { id: 'global-memory', type: 'global_memory', content: '{}', metadata: { item_type: 'dataResult', phase: 'commentary' } },
      { id: 'web-sources', type: 'web_sources', content: '{}', metadata: { item_type: 'dataResult', phase: 'commentary' } }
    ]

    const partitioned = partitionAssistantBlocks(blocks)
    expect(partitioned.processBlocks.map((block) => block.id)).toEqual(['think-1'])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual([
      'global-memory',
      'web-sources'
    ])
  })

  it('keeps delegated subtasks inside the process group', () => {
    const blocks = [
      { id: 'subtask-1', type: 'subtask', content: '正在检查表结构', metadata: { item_type: 'subtask' } },
      { id: 'answer-1', type: 'markdown', content: '检查完成', metadata: { answer_status: 'accepted' } }
    ]

    const partitioned = partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' })
    expect(partitioned.processBlocks.map((block) => block.id)).toEqual(['subtask-1'])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['answer-1'])
  })

  it('folds intermediate tables and status text into the process around a canonical answer', () => {
    const blocks = [
      { id: 'think-1', type: 'thinking', content: '查询数据' },
      {
        id: 'table-1',
        type: 'table',
        content: '{}',
        metadata: { item_type: 'dataResult', result_role: 'intermediate' }
      },
      {
        id: 'status-1',
        type: 'text',
        content: '正在分析展示方式…',
        metadata: { item_type: 'agentMessage', phase: 'commentary' }
      },
      {
        id: 'format-answer',
        type: 'markdown',
        content: '**共有 4 名员工。**',
        metadata: { item_type: 'agentMessage', phase: 'commentary' }
      },
      { id: 'think-2', type: 'thinking', content: '准备回答' },
      {
        id: 'answer-1',
        type: 'markdown',
        content: '共有 4 名员工。',
        metadata: { item_type: 'agentMessage', answer_status: 'accepted' }
      }
    ]

    const partitioned = partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' })

    expect(partitioned.processBlocks.map((block) => block.id)).toEqual([
      'think-1',
      'table-1',
      'status-1',
      'format-answer',
      'think-2'
    ])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['answer-1'])
  })

  it('treats only an explicitly accepted simple answer as the final result', () => {
    const blocks = [{ id: 'answer-1', type: 'markdown', content: '你好！', metadata: { answer_status: 'accepted' } }]
    const partitioned = partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' })

    expect(partitioned.processBlocks).toEqual([])
    expect(partitioned.resultBlocks).toEqual(blocks)
  })

  it('uses the canonical answer id after the last tool', () => {
    const blocks = [
      { id: 'tool-1', type: 'tool', content: '查询数据库' },
      {
        id: 'status-after-tool',
        type: 'markdown',
        content: '正在整理结果。',
        metadata: { item_type: 'agentMessage', phase: 'commentary' }
      },
      {
        id: 'answer-1',
        type: 'markdown',
        content: '最终有 4 名员工。',
        metadata: { item_type: 'agentMessage', answer_status: 'accepted' }
      }
    ]

    const partitioned = partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' })
    expect(partitioned.processBlocks.map((block) => block.id)).toEqual(['tool-1', 'status-after-tool'])
    expect(partitioned.resultBlocks.map((block) => block.id)).toEqual(['answer-1'])
  })

  it('does not promote a commentary message without a canonical answer', () => {
    const blocks = [
      { id: 'think-1', type: 'thinking', content: '准备回答' },
      {
        id: 'progress-1',
        type: 'markdown',
        content: '正在整理。',
        metadata: { item_type: 'agentMessage', phase: 'commentary' }
      },
      {
        id: 'local-answer',
        type: 'markdown',
        content: '本地模型的完整回答。',
        metadata: { item_type: 'agentMessage', phase: 'commentary' }
      }
    ]

    const running = partitionAssistantDisplayBlocks(blocks, false)
    expect(running.processBlocks.map((block) => block.id)).toEqual(['think-1', 'progress-1', 'local-answer'])
    expect(running.resultBlocks).toEqual([])

    const completed = partitionAssistantDisplayBlocks(blocks, true)
    expect(completed.processBlocks.map((block) => block.id)).toEqual(['think-1', 'progress-1', 'local-answer'])
    expect(completed.resultBlocks).toEqual([])
  })

  it('does not guess an answer when the current backend turn says answer is missing', () => {
    const blocks = [
      { id: 'progress-1', type: 'markdown', content: '过程消息。', metadata: { item_type: 'agentMessage', phase: 'commentary' } },
      { id: 'local-answer', type: 'markdown', content: '完整回答。', metadata: { item_type: 'agentMessage', phase: 'commentary' } }
    ]

    const completed = partitionAssistantDisplayBlocks(blocks, true, { status: 'missing', itemId: null })
    expect(completed.processBlocks.map((block) => block.id)).toEqual(['progress-1', 'local-answer'])
    expect(completed.resultBlocks).toEqual([])
  })

  it('does not promote an old final_answer phase when canonical answer is missing', () => {
    const blocks = [
      {
        id: 'old-answer',
        type: 'markdown',
        content: '旧框架回答。',
        metadata: { item_type: 'agentMessage', phase: 'final_answer' }
      }
    ]

    const completed = partitionAssistantDisplayBlocks(blocks, true, { status: 'missing', itemId: null })
    expect(completed.processBlocks.map((block) => block.id)).toEqual(['old-answer'])
    expect(completed.resultBlocks).toEqual([])
  })

  it('uses the exact accepted answer item without phase metadata', () => {
    const blocks = [
      { id: 'answer-1', type: 'markdown', content: '已验收回答。', metadata: { item_type: 'agentMessage' } }
    ]

    const completed = partitionAssistantDisplayBlocks(blocks, true, { status: 'accepted', itemId: 'answer-1' })
    expect(completed.processBlocks).toEqual([])
    expect(completed.resultBlocks.map((block) => block.id)).toEqual(['answer-1'])
  })

  it('keeps equal text when the blocks have different result meaning', () => {
    const blocks = [
      {
        id: 'summary-1',
        type: 'json',
        title: '结果卡片',
        content: '共有 4 名员工。',
        metadata: { item_type: 'dataResult', phase: 'final_answer' }
      },
      {
        id: 'answer-1',
        type: 'markdown',
        content: '共有 4 名员工。',
        metadata: { item_type: 'agentMessage', phase: 'final_answer' }
      }
    ]

    expect(partitionAssistantBlocks(blocks, { status: 'accepted', itemId: 'answer-1' }).resultBlocks.map((block) => block.id)).toEqual(['summary-1', 'answer-1'])
  })
})

describe('assistant process summary', () => {
  it('shows plan progress and the active tool while running', () => {
    const blocks = [
      {
        id: 'plan',
        type: 'plan',
        content: JSON.stringify([
          { step: '检查数据', status: 'completed' },
          { step: '查询员工', status: 'inProgress' },
          { step: '整理答案', status: 'pending' }
        ]),
        metadata: { item_type: 'plan' }
      },
      {
        id: 'tool-1',
        type: 'tool',
        title: 'running',
        content: '查询数据库 {"database_name":"员工库"}',
        metadata: { tool_call_id: 'tool-1', item_type: 'dynamicToolCall' }
      }
    ]

    expect(summarizeAssistantProcess(blocks, true)).toMatchObject({
      planSteps: 3,
      completedSteps: 1,
      currentStep: 2,
      toolCalls: 1,
      currentAction: '查询数据库',
      runningLabel: '第 2/3 步 · 查询数据库'
    })
  })

  it('counts stable tool calls and data results without counting tool output twice', () => {
    const blocks = [
      {
        id: 'plan',
        type: 'plan',
        content: JSON.stringify([
          { title: '查询数据', state: 'done' },
          { title: '生成结果', state: 'done' }
        ])
      },
      { id: 'tool-1', type: 'tool', content: '查询数据库', metadata: { tool_call_id: 'tool-1' } },
      { id: 'result:tool-1', type: 'tool_result', content: '4 rows', metadata: { tool_call_id: 'tool-1' } },
      { id: 'table-1', type: 'table', content: '{}', metadata: { item_type: 'dataResult' } }
    ]

    expect(summarizeAssistantProcess(blocks, false)).toMatchObject({
      planSteps: 2,
      completedSteps: 2,
      currentStep: 2,
      toolCalls: 1,
      dataResults: 1,
      completedLabel: '2/2 已完成 · 1 次操作 · 1 个结果'
    })
  })

  it('uses a quiet fallback for reasoning-only runs and ignores broken plan JSON', () => {
    const blocks = [
      { id: 'plan', type: 'plan', content: '{broken' },
      { id: 'thinking-1', type: 'thinking', content: '内部推理内容' }
    ]

    expect(summarizeAssistantProcess(blocks, true)).toMatchObject({
      planSteps: 0,
      currentStep: null,
      currentAction: '正在思考',
      runningLabel: '正在思考'
    })
    expect(summarizeAssistantProcess(blocks, false).completedLabel).toBe('')
  })

  it('prefers the newest commentary after a completed tool', () => {
    const blocks = [
      { id: 'tool-1', type: 'tool', title: 'done', content: '查询数据库' },
      {
        id: 'commentary-1',
        type: 'markdown',
        content: '正在整理结果。',
        metadata: { phase: 'commentary', item_type: 'agentMessage' }
      }
    ]

    expect(summarizeAssistantProcess(blocks, true).runningLabel).toBe('正在整理结果。')
  })
})
