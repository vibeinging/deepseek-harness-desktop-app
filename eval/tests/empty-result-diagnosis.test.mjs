import test from 'node:test';
import assert from 'node:assert/strict';

import { EmptyResultDiagnoser } from '../../server/src/engine/tools/empty_result_diagnosis.js';

function mockDataSources() {
  return {
    get_data_source_by_name() {
      return {
        source_type: 'SQLite',
        async query() {
          return { success: true, data: [{ _exists: 1 }] };
        },
      };
    },
  };
}

test('exact identifier empty SQL is treated as real no-data', async () => {
  const diag = await new EmptyResultDiagnoser().diagnose(
    'execute_readonly_sql',
    {
      source_name: 'kdd-structured',
      sql: "SELECT SCR_ABBR FROM main.ads_zszq_bond_hold_df WHERE BUSI_DATE=20241231 AND ACC_NUM='449.COMBI' AND HLDP_VOL > 0",
    },
    mockDataSources(),
    'project-1',
  );

  assert.equal(diag.diagnosis_type, 'no_data');
  assert.equal(diag.details.exact_identifier_filter, true);
  assert.match(diag.message, /不要改用名称 LIKE/);
});

test('non-identifier empty SQL remains adjustable', async () => {
  const diag = await new EmptyResultDiagnoser().diagnose(
    'execute_readonly_sql',
    {
      source_name: 'kdd-structured',
      sql: 'SELECT * FROM main.ads_zszq_bond_hold_df WHERE BUSI_DATE=20241231 AND HLDP_VOL > 999999999',
    },
    mockDataSources(),
    'project-1',
  );

  assert.equal(diag.diagnosis_type, 'condition_too_strict');
});

test('identifier column joins are not treated as exact identifier filters', async () => {
  const diag = await new EmptyResultDiagnoser().diagnose(
    'execute_readonly_sql',
    {
      source_name: 'kdd-structured',
      sql: `
        SELECT f.SCR_NAME
        FROM main.ads_zszq_fund_hold_df f
        JOIN main.dim_comm_ivsm_acc_df d ON f.ACC_NUM = d.IVSM_ACC_NUM
        WHERE d.DEPT_NAME = '投资研究部' AND f.BUSI_DATE = 20241231
      `,
    },
    mockDataSources(),
    'project-1',
  );

  assert.equal(diag.diagnosis_type, 'condition_too_strict');
});

test('intermediate empty result diagnoses the referenced table instead of the whole datasource', async () => {
  const diag = await new EmptyResultDiagnoser().diagnose(
    'execute_readonly_sql',
    {
      source_name: 'intermediate_session',
      sql: "SELECT * FROM r_docs WHERE event_id = 'missing'",
    },
    {
      get_data_source_by_name() {
        return {
          source_type: 'intermediate_data_source',
          async query(sql) {
            assert.match(sql, /COUNT\(\*\).*"r_docs"/);
            return { success: true, data: [{ __row_count: 18 }] };
          },
        };
      },
    },
    'project-1',
  );

  assert.equal(diag.diagnosis_type, 'condition_too_strict');
  assert.equal(diag.details.table_name, 'r_docs');
  assert.equal(diag.details.row_count, 18);
  assert.match(diag.message, /有 18 行/);
  assert.match(diag.message, /稳定实体键/);
  assert.doesNotMatch(diag.message, /中间数据源 .* 为空/);
});
