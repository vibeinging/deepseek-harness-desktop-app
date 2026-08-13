import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compactAgentSession } from "../../server/src/app/chat/agent_misc.js";
import { listSessionMessages } from "../../server/src/app/reads/reads_session.js";

test("session history query is scoped to project and owner", async () => {
  let captured = null;
  await listSessionMessages(
    {
      userId: "user-1",
      query: async (sql, params) => {
        captured = { sql, params };
        return [];
      },
    },
    { params: { pid: "project-1", sid: "session-1" } },
  );

  assert.match(captured.sql, /JOIN sessions s ON s\.id=sm\.session_id/);
  assert.match(captured.sql, /s\.project_id=\$2 AND s\.created_by=\$3/);
  assert.deepEqual(captured.params, ["session-1", "project-1", "user-1"]);
});

test("manual compaction rejects a session outside the current project owner scope", async () => {
  await assert.rejects(
    compactAgentSession(
      { userId: "user-1", queryOne: async () => null },
      { params: { pid: "project-1", sid: "session-other" } },
    ),
    (error) => error?.status === 404,
  );
});

test("manual compaction delegates to the bound DSH Session", async () => {
  const calls = [];
  const client = {
    start: async () => {},
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") return { workspace: { workspaceId: "w1", path: "/repo" } };
      if (method === "session.create") return { sessionId: "dsh-1" };
      if (method === "workspace.addSession") return { added: true };
      if (method === "command.execute") return { matched: true, command: { kind: "success", text: "Compacted 8 history items." } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await compactAgentSession({
    userId: "user-1",
    queryOne: async (sql) => (
      sql.includes("SELECT id FROM sessions")
        ? { id: "app-1" }
        : {
            id: "app-1",
            project_id: "project-1",
            created_by: "user-1",
            session_config: JSON.stringify({ dsh_runtime_session_id: "dsh-1", dsh_runtime_cwd: "/repo" }),
          }
    ),
  }, { params: { pid: "project-1", sid: "app-1" } }, { client });
  assert.equal(result.data.compacted, true);
  assert.deepEqual(calls.find((call) => call.method === "command.execute")?.payload, {
    sessionId: "dsh-1",
    line: "/compact",
  });
});

test("chat markdown rendering uses the shared HTML sanitizer", async () => {
  const [conversationRoot, assistantContent, markdownConfig] = await Promise.all([
    readFile(new URL("../../renderer/src/views/agent/AgentConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../renderer/src/views/agent/conversation/AssistantContent.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../renderer/src/utils/markdownConfig.ts", import.meta.url), "utf8"),
  ]);
  const conversation = `${conversationRoot}\n${assistantContent}`;

  assert.match(conversation, /renderSafeMarkdown\(normalized\)/);
  assert.doesNotMatch(conversation, /marked\.parse\(normalized\)/);
  assert.match(markdownConfig, /createDOMPurify/);
  assert.match(markdownConfig, /renderer:\s*\{[\s\S]*html\(token/);
  assert.match(markdownConfig, /FORBID_TAGS: \['iframe', 'form', 'object', 'embed', 'style'\]/);
});
