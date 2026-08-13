import assert from 'node:assert/strict';
import test from 'node:test';

import { GrepMetricsTool } from '../../server/src/engine/tools/grep_metrics_tool.js';
import { MetricService } from '../../server/src/engine/semantic/metric_service.js';
import { MetricViewService } from '../../server/src/engine/semantic/metric_view_service.js';

test('metric keyword retrieval applies stable limit and offset', async () => {
  const rows = ['D', 'B', 'C', 'A'].map((name) => ({
    id: `metric-${name}`,
    name,
    description: '',
    aliases: [],
    sql_template: 'SELECT 1',
    related_tables: [],
    related_columns: {},
    code_knowledge: null,
    source_id: null,
    source_type: null,
  }));
  const ctx = { query: async () => rows, queryOne: async () => null };
  const result = await MetricService.search_metrics(ctx, {
    query_text: '', project_id: 'project-1', limit: 2, offset: 1,
  });
  assert.deepEqual(result.map((item) => item.name), ['B', 'C']);
});

test('metric hybrid retrieval keeps an exact unembedded metric visible', async () => {
  const embedded = {
    id: 'metric-embedded',
    name: '其他税费',
    description: '向量已生成但不是用户要找的指标',
    aliases: [],
    sql_template: 'SELECT 1',
    related_tables: [],
    related_columns: {},
    code_knowledge: null,
    source_id: null,
    source_type: null,
  };
  const exactUnembedded = {
    ...embedded,
    id: 'metric-new',
    name: '附加税合计',
    description: '刚创建、尚未生成向量的公式指标',
  };
  const ctx = {
    query: async (sql) => (String(sql).includes('vexdb_cosine_distance')
      ? [{ ...embedded, distance: 0.01 }]
      : [embedded, exactUnembedded]),
    queryOne: async () => null,
  };
  const result = await MetricService.search_metrics(ctx, {
    query_text: '附加税合计', project_id: 'project-1', limit: 1, query_embedding: [1, 0],
  });
  assert.deepEqual(result.map((item) => item.name), ['附加税合计']);
});

test('metric retrieval ranks a full name phrase before partial token matches without score gating', async () => {
  const base = {
    description: '', aliases: [], sql_template: 'SELECT 1', related_tables: [],
    related_columns: {}, code_knowledge: null, source_id: null, source_type: null,
  };
  const rows = [
    { ...base, id: 'payable', name: '城市维护建设税本期应纳税额' },
    { ...base, id: 'basis', name: '城市维护建设税计税依据（增值税税额）' },
  ];
  const result = await MetricService.search_metrics({ query: async () => rows, queryOne: async () => null }, {
    query_text: '城市维护建设税计税依据', project_id: 'project-1', limit: 2,
  });
  assert.deepEqual(result.map((item) => item.id), ['basis', 'payable']);
  assert.equal(Object.keys(result[0]).includes('_matchRank'), false);
});

test('metric retrieval does not disguise database failures as no candidates', async () => {
  const failure = new Error('metric database offline');
  await assert.rejects(
    MetricService.search_metrics({ query: async () => { throw failure; }, queryOne: async () => null }, {
      query_text: '附加税', project_id: 'project-1', limit: 2,
    }),
    /metric database offline/,
  );
});

test('metric view retrieval has no fixed similarity cutoff and supports offset', async () => {
  const rows = ['D', 'B', 'C', 'A'].map((name) => ({
    id: `view-${name}`,
    name,
    description: '',
    aliases: [],
    source_id: null,
    tables: [],
    fixed_predicates: [],
    query_dimensions: [],
    time_dimension: null,
    projections: [],
    group_by: [],
    sort_spec: {},
    status: 'active',
  }));
  const ctx = {
    query: async (sql) => (String(sql).includes('FROM metric_view_definitions') ? rows : []),
    queryOne: async () => null,
  };
  const result = await MetricViewService.search(ctx, {
    query_text: '', project_id: 'project-1', limit: 2, offset: 1,
  });
  assert.deepEqual(result.map((item) => item.name), ['B', 'C']);
  assert.deepEqual(result.map((item) => item.similarity), [0, 0]);
});

test('metric view hybrid retrieval keeps an exact unembedded view visible', async () => {
  const base = {
    description: '',
    aliases: [],
    source_id: null,
    tables: [],
    fixed_predicates: [],
    query_dimensions: [],
    time_dimension: null,
    projections: [],
    group_by: [],
    sort_spec: {},
    status: 'active',
  };
  const embedded = { ...base, id: 'view-embedded', name: '其他视图' };
  const exactUnembedded = { ...base, id: 'view-new', name: '附加税明细' };
  const ctx = {
    query: async (sql) => (String(sql).includes('vexdb_cosine_distance')
      ? [{ ...embedded, distance: 0.01 }]
      : [embedded, exactUnembedded]),
    queryOne: async () => null,
  };
  const result = await MetricViewService.search(ctx, {
    query_text: '附加税明细', project_id: 'project-1', limit: 1, query_embedding: [1, 0],
  });
  assert.deepEqual(result.map((item) => item.name), ['附加税明细']);
});

test('metric view retrieval does not disguise database failures as no candidates', async () => {
  const failure = new Error('metric view database offline');
  await assert.rejects(
    MetricViewService.search({ query: async () => { throw failure; }, queryOne: async () => null }, {
      query_text: '附加税', project_id: 'project-1', limit: 2,
    }),
    /metric view database offline/,
  );
});

test('align_metric paginates after merging scalar metrics and table views', async () => {
  const originalMetricSearch = MetricService.search_metrics;
  const originalViewSearch = MetricViewService.search;
  let received = null;
  MetricService.search_metrics = async (_ctx, options) => {
    received = options;
    return ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({
      id: `metric-${name}`,
      name,
      description: `${name}口径`,
      aliases: [],
      related_tables: [],
      related_columns: {},
      code_knowledge: null,
      similarity: 0,
    }));
  };
  MetricViewService.search = async () => [];
  try {
    const dbCtx = { query: async () => [], queryOne: async () => null };
    const result = await new GrepMetricsTool().execute({ project_id: 'project-1', db_ctx: dbCtx }, {
      question: '指标', limit: 2, offset: 4,
    });
    assert.equal(received.limit, 7);
    assert.equal(received.offset, 0);
    assert.deepEqual(result.data.candidates.map((item) => item.name), ['E', 'F']);
    assert.equal(result.data.candidates[0].definition_kind, 'metric');
    assert.equal(result.data.candidates[0].output_shape, 'scalar');
    assert.equal(result.data.candidates[0].similarity, undefined);
    assert.equal(result.data.has_more, true);
    assert.equal(result.data.next_offset, 6);
  } finally {
    MetricService.search_metrics = originalMetricSearch;
    MetricViewService.search = originalViewSearch;
  }
});

test('align_metric exposes multiple plan types as a summary without leaking plan rules', async () => {
  const originalMetricSearch = MetricService.search_metrics;
  const originalViewSearch = MetricViewService.search;
  MetricService.search_metrics = async () => [{
    id: 'metric-multi-plan',
    name: '城市维护建设税计税依据',
    description: '统一业务口径',
    aliases: ['城建税计税依据'],
    related_tables: [],
    related_columns: {},
  }];
  MetricViewService.search = async () => [];
  try {
    const dbCtx = {
      async query(sql) {
        if (!String(sql).includes('metric_execution_plans')) return [];
        return [
          {
            metric_id: 'metric-multi-plan', plan_type: 'sql', priority: 10, version: 2,
            spec: JSON.stringify({
              sql_template: 'SELECT secret_amount FROM secret_table',
              parameters: [{ name: 'period', type: 'string', required: true, description: '所属期' }],
              result: { unit: '人民币元' },
            }),
            evidence_policy: JSON.stringify({ require_evidence: true }),
          },
          {
            metric_id: 'metric-multi-plan', plan_type: 'formula', priority: 20, version: 1,
            spec: JSON.stringify({ expression: 'a + b', operands: { a: { value: 1 }, b: { value: 2 } } }),
            evidence_policy: '{}',
          },
        ];
      },
      async queryOne() { return null; },
    };
    const result = await new GrepMetricsTool().execute({ project_id: 'project-1', db_ctx: dbCtx }, {
      question: '城建税计税依据', limit: 5,
    });
    const candidate = result.data.candidates[0];
    assert.equal(candidate.plan_type, 'sql');
    assert.deepEqual(candidate.available_plan_types, ['sql', 'formula']);
    assert.deepEqual(candidate.required_parameters, [{
      name: 'period', type: 'string', required: true, description: '所属期', allowed_values: [],
    }]);
    assert.equal(candidate.sql_template, undefined);
    assert.equal(candidate.execution_spec, undefined);
    assert.doesNotMatch(JSON.stringify(candidate), /secret_amount/);
  } finally {
    MetricService.search_metrics = originalMetricSearch;
    MetricViewService.search = originalViewSearch;
  }
});

test('align_metric returns table views without leaking their SQL structure', async () => {
  const originalMetricSearch = MetricService.search_metrics;
  const originalViewSearch = MetricViewService.search;
  let received = null;
  MetricService.search_metrics = async () => [];
  MetricViewService.search = async (_ctx, options) => {
    received = options;
    return ['A', 'B', 'C'].map((name) => ({
      definition: {
        metric_id: `view-${name}`,
        name: `${name}视图`,
        description: `${name}业务口径`,
        descriptions: [`${name}完整业务口径`],
        aliases: [],
        source_id: null,
        tables: [],
        projections: [],
        fixed_predicates: [{ field: 'status', operator: '=', value: 'active' }],
        group_by: [{ field: 'region' }],
        sort_spec: { order_by: ['region'] },
        query_dimensions: [],
        time_dimension: null,
      },
      similarity: 0.01,
      name: `${name}视图`,
      aliases: [],
      description: `${name}业务口径`,
      source_id: null,
    }));
  };
  try {
    const dbCtx = { query: async () => [], queryOne: async () => null };
    const result = await new GrepMetricsTool().execute({ project_id: 'project-1', db_ctx: dbCtx }, {
      question: '查看业务', limit: 2, offset: 0,
    });
    assert.equal(received.limit, 3);
    assert.equal(received.offset, 0);
    assert.deepEqual(result.data.candidates.map((item) => item.definition_id), ['view-A', 'view-B']);
    assert.equal(result.data.candidates[0].definition_kind, 'query_view');
    assert.equal(result.data.candidates[0].output_shape, 'table');
    assert.equal(result.data.candidates[0].description, 'A业务口径');
    assert.equal(result.data.candidates[0].fixed_predicates, undefined);
    assert.equal(result.data.candidates[0].tables, undefined);
    assert.equal(result.data.has_more, true);
    assert.equal(result.data.next_offset, 2);
    assert.equal(result.data.executed, undefined);
  } finally {
    MetricService.search_metrics = originalMetricSearch;
    MetricViewService.search = originalViewSearch;
  }
});

test('align_metric keeps scalar and table output shapes visible on the same candidate page', async () => {
  const originalMetricSearch = MetricService.search_metrics;
  const originalViewSearch = MetricViewService.search;
  MetricService.search_metrics = async () => ['A', 'B', 'C', 'D'].map((name, index) => ({
    id: `metric-${name}`, name: `${name}指标`, description: '命中用户问题', aliases: [], similarity: 1 - index * 0.1,
  }));
  MetricViewService.search = async () => [{
    definition: {
      metric_id: 'view-detail', name: '业务明细', descriptions: ['多行明细'], aliases: [],
      query_dimensions: [], time_dimension: null, projections: [],
    },
    name: '业务明细', description: '多行明细', aliases: [], similarity: 0.01,
  }];
  try {
    const result = await new GrepMetricsTool().execute({
      project_id: 'project-1', db_ctx: { query: async () => [], queryOne: async () => null },
    }, { question: 'A指标', limit: 3, offset: 0 });
    assert.deepEqual(result.data.candidates.map((item) => item.output_shape), ['scalar', 'table', 'scalar']);
  } finally {
    MetricService.search_metrics = originalMetricSearch;
    MetricViewService.search = originalViewSearch;
  }
});
