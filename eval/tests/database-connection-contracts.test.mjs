import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { query, queryOne } from "../../server/src/db.js";
import {
  createDatabase,
  testConnection,
  updateDatabase,
} from "../../server/src/app/datasource/connections.js";
import { PluginRegistry } from "../../server/src/engine/datasources/plugins/index.js";

function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

test("database updates merge extra_config without writing redacted placeholders", async (context) => {
  const projectId = id("connection-contract-project");
  const connectionId = id("connection-contract-db");
  context.after(() => query("DELETE FROM database_connections WHERE id=$1", [connectionId]));

  await query(
    `INSERT INTO database_connections
       (id, project_id, name, db_type, host, port, username, password, database, extra_config, created_at, updated_at)
     VALUES ($1,$2,'Oracle SID','Oracle','db.example.test',1521,'reader','stored-password','ORCL',$3,now(),now())`,
    [connectionId, projectId, JSON.stringify({
      retrieval_mode: "table",
      table_limit: 5,
      oracle_conn_type: "sid",
      headers: { Authorization: "Bearer stored-secret" },
      credential_bundle: { token: "stored-token" },
    })],
  );

  await updateDatabase({ query, queryOne }, {
    params: { pid: projectId, cid: connectionId },
    body: {
      name: "Oracle SID updated",
      extra_config: {
        retrieval_mode: "column",
        table_limit: 12,
        oracle_conn_type: "********",
        headers: { Authorization: "********" },
        credential_bundle: "********",
      },
    },
  });

  const row = await queryOne("SELECT extra_config FROM database_connections WHERE id=$1", [connectionId]);
  const extra = JSON.parse(row.extra_config);
  assert.equal(extra.retrieval_mode, "column");
  assert.equal(extra.table_limit, 12);
  assert.equal(extra.oracle_conn_type, "sid");
  assert.equal(extra.headers.Authorization, "Bearer stored-secret");
  assert.deepEqual(extra.credential_bundle, { token: "stored-token" });
});

test("connection test reuses a project-owned password without exposing it", async (context) => {
  const projectId = id("connection-test-project");
  const otherProjectId = id("connection-test-other-project");
  const connectionId = id("connection-test-db");
  const password = "stored-password-value";
  context.after(() => query("DELETE FROM database_connections WHERE id=$1", [connectionId]));

  await query(
    `INSERT INTO database_connections
       (id, project_id, name, db_type, host, port, username, password, database, extra_config, created_at, updated_at)
     VALUES ($1,$2,'Postgres','PostgreSQL','db.example.test',5432,'reader',$3,'analytics',$4,now(),now())`,
    [connectionId, projectId, password, JSON.stringify({ retrieval_mode: "table", table_limit: 5 })],
  );

  const plugin = PluginRegistry.get("PostgreSQL");
  const originalTestConnection = plugin.testConnection;
  const originalGetSchemas = plugin.getSchemas;
  let captured = null;
  let calls = 0;
  plugin.testConnection = async (config) => {
    calls += 1;
    captured = config;
    return {
      success: true,
      message: `连接成功 ${config.password}`,
      password: config.password,
      connection_info: { host: config.host, password: config.password, nested: { token: "leak" } },
    };
  };
  plugin.getSchemas = async () => [];
  context.after(() => {
    plugin.testConnection = originalTestConnection;
    plugin.getSchemas = originalGetSchemas;
  });

  const body = {
    connection_id: connectionId,
    db_type: "PostgreSQL",
    host: "db.example.test",
    port: 5432,
    username: "reader",
    password: "",
    database: "analytics",
    extra_config: { retrieval_mode: "column" },
  };
  const result = await testConnection({ query, queryOne }, { params: { pid: projectId }, body });
  assert.equal(captured.password, password);
  assert.equal(captured.extra_config.retrieval_mode, "column");
  assert.doesNotMatch(JSON.stringify(result.data), /stored-password-value|"token"|"password"/);
  assert.match(result.data.message, /\*{8}/);

  const changed = await testConnection({ query, queryOne }, {
    params: { pid: projectId },
    body: { ...body, host: "other.example.test" },
  });
  assert.equal(changed.data.success, false);
  assert.match(changed.data.message, /重新输入密码/);
  assert.equal(calls, 1);

  await assert.rejects(
    testConnection({ query, queryOne }, { params: { pid: otherProjectId }, body }),
    (error) => error?.status === 404,
  );
  assert.equal(calls, 1);
});

test("remote database creation rejects missing host, port, or username", async () => {
  await assert.rejects(
    createDatabase({ userId: "owner", query, queryOne }, {
      params: { pid: id("invalid-connection-project") },
      body: { name: "Invalid Doris", db_type: "Doris", database: "analytics" },
    }),
    (error) => error?.status === 400 && /host/.test(error.message),
  );
});
