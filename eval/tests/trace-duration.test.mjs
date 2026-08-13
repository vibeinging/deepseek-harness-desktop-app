import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRuntimeTokenUsageAccumulator,
  normalizeTrace,
  runtimeTraceToolPayload,
} from '../../server/src/app/traces/yitrace_service.js'

const RUN_START_MS = 1_700_000_000_000

function fakeDb() {
  return {
    span: async () => null,
  }
}

test('normalizeTrace keeps wall time instead of adding nested span durations', async () => {
  const trace = {
    summary: {
      traceId: 'trace-1',
      externalTraceId: 'run-1',
      durMs: 2_300,
    },
    spans: [
      {
        id: 'root',
        externalSpanId: 'dsh-run',
        kind: 'agent',
        name: 'Dsh',
        depth: 0,
        startMs: 1_300,
        durMs: 1_000,
      },
      {
        id: 'agent',
        externalSpanId: `dsh-agent:WorkspaceAgent:${RUN_START_MS}:1`,
        externalParentSpanId: 'dsh-run',
        kind: 'agent',
        name: 'WorkspaceAgent',
        depth: 1,
        startMs: 0,
        durMs: 800,
      },
      {
        id: 'llm',
        externalSpanId: `dsh-llm:dsh-agent:WorkspaceAgent:${RUN_START_MS}:1:call:${RUN_START_MS + 700}:1`,
        externalParentSpanId: `dsh-agent:WorkspaceAgent:${RUN_START_MS}:1`,
        kind: 'llm',
        name: 'LLM query',
        depth: 2,
        startMs: 800,
        durMs: 500,
      },
    ],
  }
  const run = {
    status: 'completed',
    created_at: new Date(RUN_START_MS).toISOString(),
    finished_at: new Date(RUN_START_MS + 1_000).toISOString(),
  }

  const normalized = await normalizeTrace(fakeDb(), 'run-1', trace, run.status, new Map(), [], run)

  assert.equal(normalized.durMs, 1_000)
  assert.equal(normalized.spans.find((span) => span.depth === 0).durMs, 1_000)
  assert.equal(normalized.spans.find((span) => span.name === 'WorkspaceAgent').startMs, 0)
  assert.equal(normalized.spans.find((span) => span.id === 'llm').startMs, 200)
  assert.ok(normalized.spans.every((span) => Number.isInteger(span.startMs)))
  assert.ok(normalized.spans.every((span) => span.startMs + span.durMs <= normalized.durMs))
})

test('normalizeTrace falls back to the root span duration without run timestamps', async () => {
  const trace = {
    summary: { traceId: 'trace-2', externalTraceId: 'run-2', durMs: 2_300 },
    spans: [
      {
        id: 'root',
        externalSpanId: 'dsh-run',
        kind: 'agent',
        name: 'Dsh',
        depth: 0,
        startMs: 1_300,
        durMs: 1_000,
      },
      {
        id: 'agent',
        externalSpanId: 'legacy-agent',
        externalParentSpanId: 'dsh-run',
        kind: 'agent',
        name: 'Legacy Agent',
        depth: 1,
        startMs: 0,
        durMs: 800,
      },
    ],
  }

  const normalized = await normalizeTrace(fakeDb(), 'run-2', trace)

  assert.equal(normalized.durMs, 1_000)
  assert.equal(normalized.spans.find((span) => span.depth === 0).durMs, 1_000)
})

test('runtime token usage sums each App Server completion once', () => {
  const usage = createRuntimeTokenUsageAccumulator()
  usage.observe({
    total: {
      inputTokens: 120,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 12,
      totalTokens: 150,
    },
    last: {
      inputTokens: 120,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 12,
      totalTokens: 150,
    },
  })
  usage.observe({
    total: {
      inputTokens: 120,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 12,
      totalTokens: 150,
    },
    last: {
      inputTokens: 120,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 12,
      totalTokens: 150,
    },
  })
  usage.observe({
    total: {
      inputTokens: 200,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 5,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 250,
    },
    last: {
      inputTokens: 80,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 8,
      totalTokens: 100,
    },
  })

  assert.deepEqual(usage.snapshot(), {
    inputTokens: 200,
    outputTokens: 50,
    totalTokens: 250,
    cachedTokens: 60,
    cacheWriteTokens: 5,
    reasoningOutputTokens: 20,
    costUsd: 0,
  })
})

test('runtime native and MCP items become trace tool payloads', () => {
  assert.deepEqual(runtimeTraceToolPayload({
    id: 'cmd-1',
    type: 'commandExecution',
    command: 'pwd',
    aggregatedOutput: '/tmp/workspace',
  }), {
    tool_call_id: 'cmd-1',
    id: 'cmd-1',
    name: 'command_execution',
    input: 'pwd',
    result_preview: '/tmp/workspace',
    skill: undefined,
    attrs: { runtime_item_type: 'commandExecution', tool_source: 'agent_runtime' },
  })
  assert.deepEqual(runtimeTraceToolPayload({
    id: 'mcp-1',
    type: 'mcpToolCall',
    tool: 'search',
    arguments: { q: 'trace' },
    result: 'ok',
  }), {
    tool_call_id: 'mcp-1',
    id: 'mcp-1',
    name: 'search',
    input: { q: 'trace' },
    result_preview: 'ok',
    skill: undefined,
    attrs: { runtime_item_type: 'mcpToolCall', tool_source: 'mcp' },
  })
  assert.equal(runtimeTraceToolPayload({ id: 'answer-1', type: 'agentMessage' }), null)
})
