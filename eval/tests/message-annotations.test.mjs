import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFileReferenceAnnotations,
  locateFileReference,
} from "../../server/src/engine/agents/message_annotations.js";

test("completed message file links become relative structured annotations with stable anchors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-annotation-"));
  try {
    const filePath = path.join(root, "docs", "guide.md");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
    await writeFile(filePath, "first\nsecond\nthird\n", "utf8");
    const text = `请查看 [使用说明](${filePath}#L2) 和 \`docs/guide.md:3\`。`;
    const projection = await buildFileReferenceAnnotations({
      text,
      cwd: root,
      sessionId: "session-1",
      runtimeThreadId: "runtime-thread-1",
      turnId: "turn-1",
      itemId: "message-1",
    });

    assert.match(projection.textHash, /^sha256:/);
    assert.deepEqual(
      projection.annotations.map((item) => [item.displayText, item.target.path, item.target.lineStart]),
      [["使用说明", "docs/guide.md", 2], ["docs/guide.md:3", "docs/guide.md", 3]],
    );
    assert.equal(projection.annotations.some((item) => JSON.stringify(item).includes(root)), false);
    assert.ok(projection.annotations.every((item) => item.target.blobHash && item.target.selectedTextHash));

    await writeFile(filePath, "intro\nfirst\nsecond\nthird\n", "utf8");
    const anchored = await locateFileReference(root, projection.annotations[0].target);
    assert.equal(anchored.locationStatus, "anchored");
    assert.equal(anchored.lineStart, 3);

    await writeFile(filePath, "first\nsecond\nthird\n", "utf8");
    const movedPath = path.join(root, "docs", "moved.md");
    await rename(filePath, movedPath);
    const moved = await locateFileReference(root, projection.annotations[0].target);
    assert.equal(moved.locationStatus, "moved");
    assert.equal(moved.path, "docs/moved.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external links and workspace escapes never become local file annotations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-annotation-boundary-"));
  try {
    const projection = await buildFileReferenceAnnotations({
      text: "[官网](https://example.com) `../secret.txt`",
      cwd: root,
      sessionId: "session-1",
      runtimeThreadId: "runtime-thread-1",
      turnId: "turn-1",
      itemId: "message-1",
    });
    assert.deepEqual(projection.annotations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
