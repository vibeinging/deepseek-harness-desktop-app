import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { makeCtx } from "../../server/src/ctx.js";
import { query, queryOne } from "../../server/src/db.js";
import {
  activateProjectWorktree,
  createProjectWorktree,
  deactivateProjectWorktrees,
  listProjectWorktrees,
  removeProjectWorktree,
} from "../../server/src/app/projects/worktrees.js";
import {
  listWorktrees,
  resolveActiveWorktree,
} from "../../server/src/engine/agents/git_workspace.js";
import {
  applyWorkspaceEdit,
  getCurrentWorkspaceDiff,
} from "../../server/src/engine/agents/workspace_change_provider.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

async function createProjectFixture(t, { git = true } = {}) {
  const projectId = randomUUID();
  const ownerId = `worktree-owner-${randomUUID()}`;
  const memberId = `worktree-member-${randomUUID()}`;
  const outsiderId = `worktree-outsider-${randomUUID()}`;
  const root = await mkdtemp(path.join(tmpdir(), "dsh-project-worktrees-"));
  if (git) await initGitRepo(root);

  await query(
    `INSERT INTO projects (id,name,status,created_at,updated_at)
     VALUES ($1,'Worktree 测试项目','active',now(),now())`,
    [projectId],
  );
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$3,$4,1,now(),now()),($2,$3,$5,0,now(),now())`,
    [randomUUID(), randomUUID(), projectId, ownerId, memberId],
  );
  await query(
    `INSERT INTO project_source_folders
       (id,project_id,local_path,display_name,access_mode,sort_order,created_at,updated_at)
     VALUES ($1,$2,$3,'repo','write',0,now(),now())`,
    [randomUUID(), projectId, root],
  );

  t.after(async () => {
    await query("DELETE FROM workspace_action_records WHERE project_id=$1", [projectId]).catch(() => undefined);
    await query("DELETE FROM sessions WHERE project_id=$1", [projectId]).catch(() => undefined);
    await query("DELETE FROM project_worktrees WHERE project_id=$1", [projectId]).catch(() => undefined);
    await query("DELETE FROM project_source_folders WHERE project_id=$1", [projectId]).catch(() => undefined);
    await query("DELETE FROM project_members WHERE project_id=$1", [projectId]).catch(() => undefined);
    await query("DELETE FROM projects WHERE id=$1", [projectId]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  return {
    projectId,
    ownerId,
    memberId,
    outsiderId,
    root,
    ownerCtx: makeCtx({ userId: ownerId }),
    memberCtx: makeCtx({ userId: memberId }),
    outsiderCtx: makeCtx({ userId: outsiderId }),
  };
}

test("worktree endpoints use project_members: members can read, owners mutate, outsiders cannot read", async (t) => {
  const fixture = await createProjectFixture(t);

  const memberList = await listProjectWorktrees(fixture.memberCtx, { params: { id: fixture.projectId } });
  assert.deepEqual(memberList.data.items, []);
  assert.equal(memberList.data.git_repository, true);
  assert.equal(memberList.data.write_target_path, fixture.root);

  await assert.rejects(
    createProjectWorktree(fixture.memberCtx, {
      params: { id: fixture.projectId },
      body: { branchName: "feature/member-denied" },
    }),
    (error) => error?.status === 403,
  );
  const created = await createProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId },
    body: { branchName: "feature/owner-created" },
  });
  assert.equal(
    (await listProjectWorktrees(fixture.memberCtx, { params: { id: fixture.projectId } })).data.items[0]?.id,
    created.data.id,
  );
  for (const operation of [
    activateProjectWorktree(fixture.memberCtx, {
      params: { id: fixture.projectId, worktreeId: created.data.id },
    }),
    deactivateProjectWorktrees(fixture.memberCtx, { params: { id: fixture.projectId } }),
    removeProjectWorktree(fixture.memberCtx, {
      params: { id: fixture.projectId, worktreeId: created.data.id },
    }),
  ]) {
    await assert.rejects(operation, (error) => error?.status === 403);
  }
  await assert.rejects(
    listProjectWorktrees(fixture.outsiderCtx, { params: { id: fixture.projectId } }),
    (error) => error?.status === 404,
  );
});

test("create/list/activate/deactivate/remove keep one active path and drive the Agent cwd resolver", async (t) => {
  const fixture = await createProjectFixture(t);
  const first = await createProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId },
    body: { branchName: "feature/worktree-one" },
  });
  const second = await createProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId },
    body: { branchName: "feature/worktree-two" },
  });

  assert.equal(first.data.project_id, fixture.projectId);
  assert.equal(first.data.source_folder_path, fixture.root);
  assert.equal(first.data.base_commit?.length, 40);
  assert.equal(first.data.active, false);
  assert.equal(first.data.available, true);
  assert.equal(Object.hasOwn(first.data, "projectId"), false);

  // Old corrupted databases may contain multiple active rows. The resolver
  // fails closed, while the next activation repairs the invariant atomically.
  await query("UPDATE project_worktrees SET active=1 WHERE project_id=$1", [fixture.projectId]);
  assert.equal(await resolveActiveWorktree({ query }, fixture.projectId), null);

  const activated = await activateProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId, worktreeId: first.data.id },
  });
  assert.equal(activated.data.path, first.data.path);
  assert.equal(await resolveActiveWorktree({ query }, fixture.projectId), first.data.path);
  const activeRows = await query(
    "SELECT id FROM project_worktrees WHERE project_id=$1 AND active=1 AND archived_at IS NULL",
    [fixture.projectId],
  );
  assert.deepEqual(activeRows.map((row) => row.id), [first.data.id]);

  const listed = await listProjectWorktrees(fixture.ownerCtx, { params: { id: fixture.projectId } });
  assert.equal(listed.data.items.length, 2);
  assert.equal(listed.data.items.find((item) => item.id === first.data.id)?.active, true);
  assert.equal(listed.data.items.every((item) => item.available), true);

  const deactivated = await deactivateProjectWorktrees(fixture.ownerCtx, { params: { id: fixture.projectId } });
  assert.deepEqual(deactivated.data, { active: false, path: fixture.root });
  assert.equal(await resolveActiveWorktree({ query }, fixture.projectId), null);

  await activateProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId, worktreeId: second.data.id },
  });
  await assert.rejects(
    removeProjectWorktree(fixture.ownerCtx, {
      params: { id: fixture.projectId, worktreeId: second.data.id },
    }),
    (error) => error?.status === 409 && error?.code === "WORKTREE_ACTIVE",
  );
  await deactivateProjectWorktrees(fixture.ownerCtx, { params: { id: fixture.projectId } });
  await removeProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId, worktreeId: second.data.id },
  });
  assert.equal(await resolveActiveWorktree({ query }, fixture.projectId), null);
  assert.equal((await listWorktrees(fixture.root)).some((item) => item.path === second.data.path), false);

  await removeProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId, worktreeId: first.data.id },
  });
  assert.deepEqual((await listProjectWorktrees(fixture.ownerCtx, { params: { id: fixture.projectId } })).data.items, []);
});

test("create rejects duplicate branches and option-like base refs with stable errors", async (t) => {
  const fixture = await createProjectFixture(t);
  await createProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId },
    body: { branchName: "feature/no-duplicate" },
  });
  await assert.rejects(
    createProjectWorktree(fixture.ownerCtx, {
      params: { id: fixture.projectId },
      body: { branchName: "feature/no-duplicate" },
    }),
    (error) => error?.status === 409 && error?.code === "WORKTREE_ALREADY_EXISTS",
  );
  await assert.rejects(
    createProjectWorktree(fixture.ownerCtx, {
      params: { id: fixture.projectId },
      body: { branchName: "feature/base-injection", baseBranch: "--detach" },
    }),
    (error) => error?.status === 400 && error?.code === "WORKTREE_BASE_INVALID",
  );
});

test("a database insert failure removes the newly-created worktree and branch", async (t) => {
  const fixture = await createProjectFixture(t);
  const failingCtx = {
    ...fixture.ownerCtx,
    queryOne: async (sql, params = []) => {
      if (String(sql).includes("INSERT INTO project_worktrees")) throw new Error("forced insert failure");
      return queryOne(sql, params);
    },
  };

  await assert.rejects(
    createProjectWorktree(failingCtx, {
      params: { id: fixture.projectId },
      body: { branchName: "feature/compensated" },
    }),
    (error) => error?.status === 500 && error?.code === "WORKTREE_PERSIST_FAILED",
  );
  assert.deepEqual(await listWorktrees(fixture.root), []);
  const { stdout } = await execFileAsync("git", ["branch", "--list", "feature/compensated"], { cwd: fixture.root });
  assert.equal(stdout.trim(), "");
});

test("listing a non-Git write target returns an explicit capability state", async (t) => {
  const fixture = await createProjectFixture(t, { git: false });
  const result = await listProjectWorktrees(fixture.ownerCtx, { params: { id: fixture.projectId } });
  assert.equal(result.data.git_repository, false);
  assert.deepEqual(result.data.items, []);
  await assert.rejects(
    createProjectWorktree(fixture.ownerCtx, {
      params: { id: fixture.projectId },
      body: { branchName: "feature/not-git" },
    }),
    (error) => error?.status === 409,
  );
});

test("Diff and line editing use the same active Worktree root as Agent execution", async (t) => {
  const fixture = await createProjectFixture(t);
  const sessionId = randomUUID();
  await query(
    `INSERT INTO sessions
       (id,project_id,created_by,title,action_type,status,created_at,updated_at)
     VALUES ($1,$2,$3,'Worktree Diff','agentic_chat','active',now(),now())`,
    [sessionId, fixture.projectId, fixture.ownerId],
  );
  const created = await createProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId },
    body: { branchName: "feature/diff-root" },
  });
  await activateProjectWorktree(fixture.ownerCtx, {
    params: { id: fixture.projectId, worktreeId: created.data.id },
  });
  await writeFile(path.join(created.data.path, "README.md"), "changed in worktree\n", "utf8");

  const diff = await getCurrentWorkspaceDiff(fixture.ownerCtx, {
    params: { threadId: sessionId },
  });
  assert.equal(diff.data.workspaceRoot, created.data.path);
  assert.match(diff.data.diff, /changed in worktree/);

  const edited = await applyWorkspaceEdit(fixture.ownerCtx, {
    params: { threadId: sessionId, turnId: "current-workspace" },
    body: {
      action: "apply_edit",
      requestId: randomUUID(),
      path: "README.md",
      lineNumber: 1,
      newLineText: "edited through review",
      expectedWorkspaceDiffHash: diff.data.diffHash,
    },
  });
  assert.equal(edited.data.workspaceRoot, created.data.path);
  assert.equal(await readFile(path.join(created.data.path, "README.md"), "utf8"), "edited through review\n");
  assert.equal(await readFile(path.join(fixture.root, "README.md"), "utf8"), "hello\n");
});
