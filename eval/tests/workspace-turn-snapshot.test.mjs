import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beginWorkspaceTurnSnapshot } from "../../server/src/engine/agents/workspace_turn_snapshot.js";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-workspace-snapshot-test-"));
  await writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n", "utf8");
  await writeFile(path.join(root, "untouched.txt"), "original\n", "utf8");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Dsh Test"]);
  git(root, ["config", "user.email", "test@dsh.local"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

test("workspace Turn snapshot reports a clean tracked shell write", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await beginWorkspaceTurnSnapshot({ roots: [{ id: "workspace", path: root }] });
  t.after(() => snapshot.dispose());

  await writeFile(path.join(root, "a.txt"), "one\ntwo\nchanged\n", "utf8");
  const summary = await snapshot.finish();

  assert.equal(summary.source, "workspace_snapshot");
  assert.equal(summary.reviewable, true);
  assert.equal(summary.reversible, true);
  assert.deepEqual(summary.changes.map(({ path: file, kind }) => [file, kind]), [["a.txt", "update"]]);
  assert.match(summary.unifiedDiff, /-three\n\+changed/);
  assert.ok(summary.diffHash);
  assert.equal(git(root, ["status", "--porcelain"]), "M a.txt", "real Git index remains untouched");
});

test("workspace Turn snapshot subtracts pre-existing dirty and untracked changes exactly", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.txt"), "one\npreexisting\nthree\n", "utf8");
  await writeFile(path.join(root, "old-untracked.txt"), "before\n", "utf8");
  const snapshot = await beginWorkspaceTurnSnapshot({ roots: [{ id: "workspace", path: root }] });
  t.after(() => snapshot.dispose());

  await writeFile(path.join(root, "a.txt"), "one\npreexisting\nturn-change\n", "utf8");
  await writeFile(path.join(root, "old-untracked.txt"), "after\n", "utf8");
  await writeFile(path.join(root, "new.txt"), "created\n", "utf8");
  const summary = await snapshot.finish();

  assert.deepEqual(
    summary.changes.map(({ path: file, kind }) => [file, kind]).sort(),
    [["a.txt", "update"], ["new.txt", "create"], ["old-untracked.txt", "update"]],
  );
  assert.match(summary.unifiedDiff, /-three\n\+turn-change/);
  assert.doesNotMatch(summary.unifiedDiff, /^-two$|^\+preexisting$/m);
  assert.match(summary.unifiedDiff, /-before\n\+after/);
});

test("workspace Turn snapshot emits no change when a write is restored before completion", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readFile(path.join(root, "a.txt"), "utf8");
  const snapshot = await beginWorkspaceTurnSnapshot({ roots: [{ id: "workspace", path: root }] });
  t.after(() => snapshot.dispose());

  await writeFile(path.join(root, "a.txt"), "temporary\n", "utf8");
  await writeFile(path.join(root, "a.txt"), before, "utf8");
  const summary = await snapshot.finish();
  assert.deepEqual(summary.changes, []);
  assert.equal(summary.unifiedDiff, "");
  assert.equal(summary.diffHash, null);
});

test("workspace Turn snapshot safely reports non-Git file paths without inventing a patch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-workspace-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "a.txt"), "before\n", "utf8");
  const snapshot = await beginWorkspaceTurnSnapshot({ roots: [{ id: "workspace", path: root }] });
  t.after(() => snapshot.dispose());

  await writeFile(path.join(root, "nested", "a.txt"), "after\n", "utf8");
  const summary = await snapshot.finish();
  assert.deepEqual(summary.changes.map(({ path: file, kind }) => [file, kind]), [["nested/a.txt", "update"]]);
  assert.equal(summary.reviewable, false);
  assert.equal(summary.reversible, false);
  assert.equal(summary.unifiedDiff, "");
});
