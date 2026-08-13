import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import { readRunEnvironmentSnapshot } from '../../server/src/engine/agents/run_environment_snapshot.js';
import { createAgentRuntime } from '../../server/src/engine/agents/agent_run_runtime.js';
import { removeRunnerRunDirectory } from '../../server/src/engine/runner/run_paths.js';

const ctx = { query, queryOne };

async function deleteRunFacts(runId) {
  for (const table of ['agent_pending_inputs', 'agent_run_events', 'agent_tool_calls', 'agent_artifacts', 'agent_evidence_bundles']) {
    await query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
  }
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
  await removeRunnerRunDirectory(runId).catch(() => {});
}

test('run environment snapshot is immutable, secret-free and comparable across runs', async (t) => {
  const suffix = randomUUID();
  const projectId = `environment-project-${suffix}`;
  const connectionId = `environment-connection-${suffix}`;
  const bindingId = `environment-binding-${suffix}`;
  const ruleId = `environment-rule-${suffix}`;
  const metricIds = ['sql', 'pdf', 'formula'].map((type) => `environment-metric-${type}-${suffix}`);
  const runIds = [1, 2, 3].map((index) => `environment-${index}-${suffix}`);
  const databasePath = `/private/secret/customer-${suffix}.duckdb`;
  const databasePassword = `db-password-${suffix}`;
  const modelSecret = `model-api-key-${suffix}`;
  const modelBase = `https://secret-model-${suffix}.example.com`;

  t.after(async () => {
    for (const runId of runIds) await deleteRunFacts(runId);
    await query('DELETE FROM metric_execution_plans WHERE project_id=$1', [projectId]);
    await query('DELETE FROM metric_definitions WHERE project_id=$1', [projectId]);
    await query('DELETE FROM project_rules WHERE id=$1', [ruleId]);
    await query('DELETE FROM business_data_sources WHERE id=$1', [bindingId]);
    await query('DELETE FROM database_connections WHERE id=$1', [connectionId]);
    await query('DELETE FROM projects WHERE id=$1', [projectId]);
  });

  await query(
    `INSERT INTO projects (id, name, description, status, created_at, updated_at)
     VALUES ($1,$2,'环境快照测试','active',now(),now())`,
    [projectId, `环境快照 ${suffix}`],
  );
  await query(
    `INSERT INTO database_connections
       (id, project_id, name, db_type, database, password, schema_config, business_rules, created_at, updated_at)
     VALUES ($1,$2,'订单库','duckdb',$3,$4,'{"schemas":["main"]}','只允许读取订单',now(),now())`,
    [connectionId, projectId, databasePath, databasePassword],
  );
  await query(
    `INSERT INTO business_data_sources
       (id, project_id, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,'database_connection',$3,now(),now())`,
    [bindingId, projectId, connectionId],
  );
  await query(
    `INSERT INTO project_rules
       (id, project_id, rule_type, content, version, created_at, updated_at)
     VALUES ($1,$2,'query','金额必须大于零','v1',now(),now())`,
    [ruleId, projectId],
  );
  await query(
    `INSERT INTO metric_definitions
       (id, project_id, name, is_active, created_at, updated_at)
     VALUES
       ($1,$4,'SQL金额',true,now(),now()),
       ($2,$4,'常量金额',true,now(),now()),
       ($3,$4,'公式金额',true,now(),now())`,
    [...metricIds, projectId],
  );
  await query(
    `INSERT INTO metric_execution_plans
       (id, project_id, metric_id, plan_type, spec, evidence_policy,
        priority, version, is_active, created_at, updated_at)
     VALUES
       ($1,$7,$4,'sql','{"sql_template":"SELECT 1 AS value"}','{}',100,1,true,now(),now()),
       ($2,$7,$5,'formula','{"expression":"a","operands":{"a":{"value":1}}}','{"require_evidence":false}',100,1,true,now(),now()),
       ($3,$7,$6,'formula','{"expression":"a+b","operands":{"a":{"value":1},"b":{"value":2}}}','{"require_evidence":false}',100,1,true,now(),now())`,
    [`default:${metricIds[0]}`, `default:${metricIds[1]}`, `default:${metricIds[2]}`, ...metricIds, projectId],
  );

  const capture = async (runId) => {
    const runtime = createAgentRuntime({
      ctx,
      stream: null,
      runId,
      sessionId: `session-${suffix}`,
      projectId,
      userId: 'environment-test',
      skill: 'query-project-data',
      mode: 'environment_test',
    });
    await runtime.createRun();
    return runtime.captureEnvironment({
      selectedModel: {
        id: `model-${suffix}`,
        model_name: 'test-model',
        category: 'PRIMARY',
        api_format: 'responses',
        api_key: modelSecret,
        api_base: modelBase,
        extra_config: { reasoning_effort: 'high', private_token: modelSecret },
      },
      approvalMode: 'auto',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: {
        mode: 'workspace-write',
        system_enforced: true,
        network: 'blocked',
        write_scope: 'run-workspace-only',
      },
    });
  };

  const first = await capture(runIds[0]);
  const persistedText = await readFile(first.path, 'utf8');
  const persisted = JSON.parse(persistedText);
  assert.equal(first.version, 'agent_run_environment.v3');
  assert.match(first.snapshot_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await readRunEnvironmentSnapshot(runIds[0])).snapshot_hash, first.snapshot_hash);
  assert.equal(persisted.environment.project.id, projectId);
  assert.equal(persisted.permissions.approval_mode, 'auto');
  assert.equal(persisted.permissions.approval_policy, 'on-request');
  assert.equal(persisted.permissions.approvals_reviewer, 'auto_review');
  assert.equal(persisted.environment.project_rules[0].content, '金额必须大于零');
  assert.ok(persisted.environment.semantic.metrics.every((metric) => (
    !Object.hasOwn(metric, 'execution_type')
    && !Object.hasOwn(metric, 'execution_spec')
    && !Object.hasOwn(metric, 'sql_template')
  )));
  assert.deepEqual(
    persisted.environment.semantic.metric_execution_plans.map((plan) => plan.plan_type).sort(),
    ['formula', 'formula', 'sql'],
  );
  assert.deepEqual(persisted.environment.runtime, { kind: 'dsh_profile', profile: 'web' });
  assert.equal(persisted.environment.plugins, undefined);
  assert.equal(persisted.environment.mcp, undefined);
  assert.equal(persisted.environment.agents, undefined);
  assert.equal(persisted.environment.data_sources.connections[0].database, undefined);
  assert.match(persisted.environment.data_sources.connections[0].location_hash, /^sha256:[a-f0-9]{64}$/);
  for (const secret of [databasePath, databasePassword, modelSecret, modelBase]) {
    assert.equal(persistedText.includes(secret), false, `环境快照不得落盘敏感值：${secret}`);
  }

  const second = await capture(runIds[1]);
  assert.equal(second.snapshot_hash, first.snapshot_hash, '同一项目配置和权限跨运行得到同一指纹');

  await query(
    `UPDATE project_rules SET content='金额必须大于零，退款单单独统计', version='v2', updated_at=now() WHERE id=$1`,
    [ruleId],
  );
  const third = await capture(runIds[2]);
  assert.notEqual(third.snapshot_hash, first.snapshot_hash, '项目规则变化会改变环境指纹');
  assert.equal(third.environment.project_rules[0].content, '金额必须大于零，退款单单独统计');

  const runFact = await queryOne(
    `SELECT environment_snapshot_path, environment_snapshot_version, environment_snapshot_hash
       FROM agent_runs WHERE id=$1`,
    [runIds[2]],
  );
  assert.equal(runFact.environment_snapshot_path, third.path);
  assert.equal(runFact.environment_snapshot_version, third.version);
  assert.equal(runFact.environment_snapshot_hash, third.snapshot_hash);
});
