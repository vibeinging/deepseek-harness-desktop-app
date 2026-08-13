import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { query, queryOne } from "../../server/src/db.js";
import {
  beginDataPreparationRevision,
  getLatestDataPreparationRevision,
  getLatestCompletedDataPreparationRevision,
  listDataPreparationRevisions,
  transitionDataPreparationRevision,
} from "../../server/src/engine/semantic/data_preparation_revision_store.js";

const db = { query, queryOne };

function projectId(label) {
  return `preparation-${label}-${randomUUID()}`;
}

async function cleanup(projectIds) {
  for (const id of projectIds) {
    await query("DELETE FROM project_data_preparation_revisions WHERE project_id=$1", [id]);
  }
}

test("data preparation revisions increase independently for each project", async (t) => {
  const projectA = projectId("a");
  const projectB = projectId("b");
  t.after(() => cleanup([projectA, projectB]));

  const firstA = await beginDataPreparationRevision(db, {
    projectId: projectA,
    coverageSummary: { documents_total: 4, documents_indexed: 0 },
  });
  const secondA = await beginDataPreparationRevision(db, { projectId: projectA });
  const firstB = await beginDataPreparationRevision(db, { projectId: projectB });

  assert.equal(firstA.status, "running");
  assert.equal(firstA.revision, 1);
  assert.equal(secondA.revision, 2);
  assert.equal(firstB.revision, 1);
  assert.deepEqual(firstA.coverage_summary, { documents_total: 4, documents_indexed: 0 });
  assert.equal(firstA.failure_details, null);
});

test("running transitions to immutable terminal states with JSON summaries", async (t) => {
  const project = projectId("transition");
  t.after(() => cleanup([project]));
  const revision = await beginDataPreparationRevision(db, { projectId: project });

  const completed = await transitionDataPreparationRevision(db, revision.id, "completed", {
    coverageSummary: {
      structured: { tables_total: 3, tables_prepared: 3 },
      unstructured: { documents_total: 2, documents_indexed: 2 },
    },
  });
  assert.equal(completed.status, "completed");
  assert.ok(completed.finished_at);
  assert.deepEqual(completed.coverage_summary.unstructured, {
    documents_total: 2,
    documents_indexed: 2,
  });
  await assert.rejects(
    () => transitionDataPreparationRevision(db, revision.id, "failed", {
      failureDetails: { message: "late error" },
    }),
    (error) => error.code === "DATA_PREPARATION_TRANSITION_INVALID",
  );
});

test("completed preparation runs remain in history when newer runs are partial or failed", async (t) => {
  const project = projectId("latest-completed");
  t.after(() => cleanup([project]));

  const revision1 = await beginDataPreparationRevision(db, { projectId: project });
  await transitionDataPreparationRevision(db, revision1.id, "completed", {
    coverageSummary: { documents_indexed: 5 },
  });
  const revision2 = await beginDataPreparationRevision(db, { projectId: project });
  await transitionDataPreparationRevision(db, revision2.id, "partial", {
    coverageSummary: { documents_indexed: 6, documents_failed: 1 },
    failureDetails: [{ document_id: "doc-7", code: "PARSE_FAILED" }],
  });
  const revision3 = await beginDataPreparationRevision(db, { projectId: project });
  const failed = await transitionDataPreparationRevision(db, revision3.id, "failed", {
    failureDetails: { code: "EMBEDDING_UNAVAILABLE", retryable: true },
  });

  const latest = await getLatestDataPreparationRevision(db, project);
  const latestCompleted = await getLatestCompletedDataPreparationRevision(db, project);
  assert.equal(latest.id, failed.id);
  assert.equal(latest.status, "failed");
  assert.deepEqual(latest.failure_details, { code: "EMBEDDING_UNAVAILABLE", retryable: true });
  assert.equal(latestCompleted.id, revision1.id);
  assert.equal(latestCompleted.revision, 1);
  assert.deepEqual((await listDataPreparationRevisions(db, project)).map((item) => item.revision), [3, 2, 1]);
});

test("failed revisions require details and invalid states are rejected", async (t) => {
  const project = projectId("guards");
  t.after(() => cleanup([project]));
  const revision = await beginDataPreparationRevision(db, { projectId: project });

  await assert.rejects(
    () => transitionDataPreparationRevision(db, revision.id, "failed"),
    (error) => error.code === "DATA_PREPARATION_FAILURE_DETAILS_REQUIRED",
  );
  await assert.rejects(
    () => transitionDataPreparationRevision(db, revision.id, "unknown"),
    (error) => error.code === "DATA_PREPARATION_STATUS_INVALID",
  );

  const running = await transitionDataPreparationRevision(db, revision.id, "running", {
    coverageSummary: { stage: "embedding", processed: 8, total: 10 },
  });
  assert.equal(running.finished_at, null);
  assert.deepEqual(running.coverage_summary, { stage: "embedding", processed: 8, total: 10 });
});
