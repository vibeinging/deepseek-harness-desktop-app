import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
const require = createRequire(import.meta.url);
const Database = require("../../server/node_modules/better-sqlite3");

import { explicitLegacyModelCapabilities } from "../../server/src/engine/agent_kernel/legacy_model_capability_migration.js";

test("legacy inferred capabilities become explicit saved configuration once", () => {
  const migrated = explicitLegacyModelCapabilities("qwen3.7-plus", {
    supports_image_input: true,
    agent_runtime: { reasoning_effort: "medium" },
  });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.extraConfig.agent_runtime.context_window, 1_000_000);
  assert.equal(migrated.extraConfig.agent_runtime.reasoning_effort, "medium");
  assert.equal(migrated.extraConfig.supports_image_input, true);
});

test("explicit user capability choices always win over legacy defaults", () => {
  const migrated = explicitLegacyModelCapabilities("qwen3.7-plus", {
    supports_image_input: false,
    agent_runtime: { context_window: 128_000 },
  });
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.extraConfig, {
    supports_image_input: false,
    agent_runtime: { context_window: 128_000 },
  });
});

test("missing legacy image declaration is made explicit without changing the context window", () => {
  const migrated = explicitLegacyModelCapabilities("qwen3.7-plus", {
    agent_runtime: { context_window: 128_000 },
  });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.extraConfig.agent_runtime.context_window, 128_000);
  assert.equal(migrated.extraConfig.supports_image_input, true);
});

test("dated legacy aliases are migrated without adding name inference to the current catalog", () => {
  const migrated = explicitLegacyModelCapabilities("qwen3.7-plus-2026-07-31", {});
  assert.equal(migrated.changed, true);
  assert.equal(migrated.extraConfig.agent_runtime.context_window, 1_000_000);
  assert.equal(migrated.extraConfig.supports_image_input, true);
});

test("legacy root context_window is normalized without changing the user value", () => {
  const migrated = explicitLegacyModelCapabilities("qwen3.7-plus", {
    context_window: 512_000,
    supports_image_input: false,
    agent_runtime: { supports_parallel_tool_calls: true },
  });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.extraConfig.agent_runtime.context_window, 512_000);
  assert.equal(migrated.extraConfig.agent_runtime.supports_parallel_tool_calls, true);
  assert.equal(migrated.extraConfig.supports_image_input, false);
});

test("current runtime does not infer capabilities for unrelated model names", () => {
  const migrated = explicitLegacyModelCapabilities("future-model", {});
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.extraConfig, {});
});

test("database migration persists explicit capabilities without changing model ordering timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-model-capability-"));
  const databasePath = join(directory, "local.db");
  const schemaPath = new URL("../../server/db/schema.sql", import.meta.url);
  const seeded = new Database(databasePath);
  seeded.exec(readFileSync(schemaPath, "utf8"));
  const timestamp = "2026-07-01T12:34:56.000Z";
  seeded.prepare(`
    INSERT INTO llm_models (
      id, model_name, display_name, category, is_enabled,
      extra_config, created_at, updated_at
    ) VALUES (?, ?, ?, 'PRIMARY', 0, ?, ?, ?)
  `).run(
    "legacy-qwen",
    "qwen3.7-plus",
    "Legacy Qwen",
    JSON.stringify({ context_window: 640_000, supports_image_input: true }),
    timestamp,
    timestamp,
  );
  seeded.prepare(`
    INSERT INTO llm_models (
      id, model_name, display_name, category, is_enabled,
      extra_config, created_at, updated_at
    ) VALUES (?, ?, ?, 'PRIMARY', 0, ?, ?, ?)
  `).run(
    "malformed-qwen",
    "qwen3.7-plus-2026-07-31",
    "Malformed Qwen",
    "not-json",
    timestamp,
    timestamp,
  );
  seeded.close();

  const previousDatabasePath = process.env.DB_SQLITE_PATH;
  process.env.DB_SQLITE_PATH = databasePath;
  try {
    const databaseModule = await import(`../../server/src/db.js?legacy-capability-test=${Date.now()}`);
    const row = databaseModule.sqlite.prepare(
      "SELECT extra_config, updated_at FROM llm_models WHERE id=?",
    ).get("legacy-qwen");
    const marker = databaseModule.sqlite.prepare(
      "SELECT 1 AS applied FROM app_schema_migrations WHERE id=?",
    ).get("2026-08-explicit-legacy-model-capabilities-v1");
    const extraConfig = JSON.parse(row.extra_config);
    assert.equal(extraConfig.agent_runtime.context_window, 640_000);
    assert.equal(row.updated_at, timestamp);
    assert.equal(marker.applied, 1);
    const malformed = databaseModule.sqlite.prepare(
      "SELECT extra_config, updated_at FROM llm_models WHERE id=?",
    ).get("malformed-qwen");
    assert.equal(JSON.parse(malformed.extra_config).agent_runtime.context_window, 1_000_000);
    assert.equal(JSON.parse(malformed.extra_config).supports_image_input, true);
    assert.equal(malformed.updated_at, timestamp);
    databaseModule.closeDatabase();

    // A second startup sees the migration marker and leaves saved config
    // unchanged, proving the migration is idempotent.
    const secondModule = await import(`../../server/src/db.js?legacy-capability-second=${Date.now()}`);
    const second = secondModule.sqlite.prepare(
      "SELECT extra_config, updated_at FROM llm_models WHERE id=?",
    ).get("malformed-qwen");
    assert.deepEqual(second, malformed);
    assert.equal(secondModule.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM app_schema_migrations WHERE id=?",
    ).get("2026-08-explicit-legacy-model-capabilities-v1").count, 1);
    secondModule.closeDatabase();
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DB_SQLITE_PATH;
    else process.env.DB_SQLITE_PATH = previousDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  }
});
