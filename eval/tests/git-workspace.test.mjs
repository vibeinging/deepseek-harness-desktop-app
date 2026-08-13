import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  isGitRepository,
  getHeadCommit,
} from "../../server/src/engine/agents/git_workspace.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root) {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

test("isGitRepository detects a git repo and rejects non-repos", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-git-detect-"));
  const notRepo = await mkdtemp(path.join(tmpdir(), "dsh-notrepo-"));
  try {
    await initGitRepo(repo);
    assert.equal(await isGitRepository(repo), true);
    assert.equal(await isGitRepository(notRepo), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(notRepo, { recursive: true, force: true });
  }
});

test("createWorktree creates an isolated checkout under .dsh-worktrees/", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-create-"));
  try {
    await initGitRepo(repo);
    const result = await createWorktree(repo, { branchName: "feature/test-1", id: "abc123" });
    // realpathSync both sides so macOS /var -> /private/var doesn't break the assertion.
    const { realpathSync } = await import("node:fs");
    assert.ok(result.path.endsWith(path.join(".dsh-worktrees", "abc123")));
    assert.equal(result.branch, "feature/test-1");
    assert.ok(existsSync(result.path));
    assert.ok(existsSync(path.join(result.path, "README.md")));
    const { stdout: mainStatus } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    assert.equal(mainStatus.trim(), "", "managed Worktrees must not dirty the main checkout");

    // The worktree should be listed.
    const listed = await listWorktrees(repo);
    const found = listed.find((entry) => entry.path === result.path);
    assert.ok(found, "worktree should appear in listWorktrees");
    assert.equal(found.branch, "feature/test-1");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("changes in the worktree do not affect the main checkout", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-isolation-"));
  try {
    await initGitRepo(repo);
    const { path: wtPath } = await createWorktree(repo, { branchName: "isolation-test" });
    // Edit a file in the worktree.
    await writeFile(path.join(wtPath, "README.md"), "changed in worktree\n", "utf8");
    // Main checkout is unaffected.
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "hello\n");
    assert.equal(await readFile(path.join(wtPath, "README.md"), "utf8"), "changed in worktree\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree deletes the directory and prunes", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-remove-"));
  try {
    await initGitRepo(repo);
    const { path: wtPath } = await createWorktree(repo, { branchName: "remove-test" });
    assert.ok(existsSync(wtPath));
    await removeWorktree(repo, wtPath);
    assert.ok(!existsSync(wtPath), "worktree directory should be gone");
    const listed = await listWorktrees(repo);
    assert.equal(listed.find((entry) => entry.path === wtPath), undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("createWorktree rejects a non-git directory", async () => {
  const notRepo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-nongit-"));
  try {
    await assert.rejects(
      createWorktree(notRepo, { branchName: "fail" }),
      (error) => error?.status === 409,
    );
  } finally {
    await rm(notRepo, { recursive: true, force: true });
  }
});

test("createWorktree rejects invalid branch names instead of silently rewriting them", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-sanitize-"));
  try {
    await initGitRepo(repo);
    await assert.rejects(
      createWorktree(repo, { branchName: "feat; rm -rf /" }),
      (error) => error?.status === 400 && error?.code === "WORKTREE_BRANCH_INVALID",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("createWorktree supports a valid long branch name up to the product limit", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-long-"));
  try {
    await initGitRepo(repo);
    const branchName = `feature/${"a".repeat(112)}`;
    assert.equal(branchName.length, 120);
    const result = await createWorktree(repo, { branchName });
    assert.equal(result.branch, branchName);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("createWorktree rejects an option-like base ref before invoking git worktree add", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-base-ref-"));
  try {
    await initGitRepo(repo);
    await assert.rejects(
      createWorktree(repo, { branchName: "feature/base-ref", baseBranch: "--detach" }),
      (error) => error?.status === 400 && error?.code === "WORKTREE_BASE_INVALID",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree refuses paths outside the managed worktree directory", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-scope-"));
  try {
    await initGitRepo(repo);
    await assert.rejects(
      removeWorktree(repo, repo),
      (error) => error?.status === 409 && error?.code === "WORKTREE_PATH_OUT_OF_SCOPE",
    );
    assert.ok(existsSync(path.join(repo, "README.md")));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("createWorktree rejects a repository subfolder so the Agent write scope cannot widen", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "dsh-worktree-subfolder-"));
  try {
    await initGitRepo(repo);
    const nested = path.join(repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    await assert.rejects(
      createWorktree(nested, { branchName: "feature/subfolder" }),
      (error) => error?.status === 409 && error?.code === "WORKTREE_REPOSITORY_ROOT_REQUIRED",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
