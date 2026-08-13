import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { promptDshQueue, readDshAttachment } from "../../server/src/app/chat/dsh_protocol.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function ownedContext() {
  return {
    userId: "local-user",
    queryOne: async () => ({
      id: "app-session-1",
      project_id: "project-1",
      created_by: "local-user",
      session_config: JSON.stringify({
        dsh_runtime_session_id: "dsh-session-1",
        dsh_runtime_cwd: "/workspace",
      }),
    }),
  };
}

function attachmentClient() {
  const calls = [];
  return {
    calls,
    start: async () => {},
    registerProductHostSession: () => {},
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") {
        return { workspace: { workspaceId: "workspace-1", path: payload.path } };
      }
      if (method === "session.create") return { sessionId: payload.sessionId };
      if (method === "session.attachment") {
        return {
          attachment: { mediaType: "image/png" },
          data: Buffer.from("image-bytes").toString("base64"),
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("dsh-work reads a durable image through the owning DSH Session", async () => {
  const client = attachmentClient();
  const result = await readDshAttachment(ownedContext(), {
    params: { sid: "app-session-1", attachmentId: "sha256:abc" },
  }, { client });

  assert.equal(result._binary, true);
  assert.equal(result.headers["content-type"], "image/png");
  assert.equal(result.data.toString(), "image-bytes");
  assert.deepEqual(client.calls.at(-1), {
    method: "session.attachment",
    payload: { sessionId: "dsh-session-1", attachmentId: "sha256:abc" },
  });
});

test("dsh-work refuses attachment reads outside the local Session owner", async () => {
  const client = attachmentClient();
  const ctx = { userId: "other-user", queryOne: async () => null };
  await assert.rejects(
    readDshAttachment(ctx, {
      params: { sid: "app-session-1", attachmentId: "sha256:abc" },
    }, { client }),
    (error) => error?.status === 404,
  );
  assert.equal(client.calls.length, 0);
});

test("DSH queue and steer prompts carry validated images through the rc.2 wire", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-prompt-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const client = attachmentClient();
  client.request = async (method, payload) => {
    client.calls.push({ method, payload });
    if (method === "workspace.create") {
      return { workspace: { workspaceId: "workspace-1", path: payload.path } };
    }
    if (method === "session.create") return { sessionId: payload.sessionId };
    if (method === "session.prompt") return { accepted: true };
    throw new Error(`unexpected ${method}`);
  };

  const result = await promptDshQueue(ownedContext(), {
    params: { pid: "project-1", threadId: "app-session-1" },
    body: {
      mode: "steer",
      input: [{ type: "text", text: "检查截图" }, { type: "localImage", path: imagePath }],
      attachments: [{ path: imagePath, name: "screen.png", mime_type: "image/png" }],
    },
  }, { client });

  assert.equal(result.data.accepted, true);
  const prompt = client.calls.at(-1);
  assert.equal(prompt.method, "session.prompt");
  assert.equal(prompt.payload.mode, "steer");
  assert.match(prompt.payload.content[0].text, /检查截图/);
  assert.match(prompt.payload.content[0].text, /screen\.png/);
  assert.deepEqual(prompt.payload.content[1], {
    type: "image",
    mediaType: "image/png",
    data: ONE_PIXEL_PNG.toString("base64"),
    name: "screen.png",
  });
});
