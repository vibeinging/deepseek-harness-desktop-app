import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RUN_WRITEBACK_PROPOSAL_VERSION = "agent_run_writeback_proposal.v1";
export const RUN_WRITEBACK_RECEIPT_VERSION = "agent_run_writeback_receipt.v1";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function fileHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeFileId(callId) {
  const value = String(callId || "writeback").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "writeback";
  return `${value}-${createHash("sha256").update(String(callId || "writeback")).digest("hex").slice(0, 10)}`;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: "AGENT_RUN_WRITEBACK_CONFLICT" });
}

function documentContent(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function writeImmutable(path, document, { expectedVersion, expectedHashField }) {
  const content = documentContent(document);
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    return {
      document,
      created: true,
      size_bytes: Buffer.byteLength(content, "utf8"),
      file_hash: fileHash(content),
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let existing;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw conflict("运行写回文件不是有效的 JSON");
  }
  if (
    existing?.version !== expectedVersion ||
    existing?.[expectedHashField] !== document?.[expectedHashField]
  ) {
    throw conflict("运行写回文件与当前调用不一致");
  }
  const existingContent = documentContent(existing);
  return {
    document: existing,
    created: false,
    size_bytes: Buffer.byteLength(existingContent, "utf8"),
    file_hash: fileHash(existingContent),
  };
}

export async function stageRunWriteback({
  workspace,
  runId,
  callId,
  toolName,
  projectId,
  argsFingerprint,
  proposal,
} = {}) {
  if (!(workspace?.work && runId && callId && toolName && proposal?.kind)) {
    throw Object.assign(new Error("运行写回草稿缺少工作区或目标信息"), { code: "AGENT_RUN_WRITEBACK_INVALID" });
  }
  const directory = join(workspace.work, "writebacks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const comparable = {
    version: RUN_WRITEBACK_PROPOSAL_VERSION,
    run_id: runId,
    call_id: callId,
    tool_name: toolName,
    project_id: projectId || null,
    args_fingerprint: argsFingerprint || null,
    kind: proposal.kind,
    target: proposal.target || null,
    operation: proposal.operation || null,
    before: proposal.before ?? null,
    proposed_after: proposal.proposed_after ?? null,
    source_files: proposal.source_files || [],
    metadata: proposal.metadata || {},
  };
  const document = {
    ...comparable,
    status: "staged",
    created_at: new Date().toISOString(),
    proposal_hash: hash(comparable),
  };
  const path = join(directory, `${safeFileId(callId)}.proposal.json`);
  const stored = await writeImmutable(path, document, {
    expectedVersion: RUN_WRITEBACK_PROPOSAL_VERSION,
    expectedHashField: "proposal_hash",
  });
  return {
    ...stored,
    path,
    version: stored.document.version,
    proposal_hash: stored.document.proposal_hash,
    kind: stored.document.kind,
    target: stored.document.target,
  };
}

export async function completeRunWriteback({
  workspace,
  runId,
  callId,
  toolName,
  projectId,
  staged,
  actualAfter,
  approvedRequestId = null,
} = {}) {
  if (!(workspace?.artifacts && runId && callId && toolName && staged?.proposal_hash)) {
    throw Object.assign(new Error("运行写回回执缺少草稿引用"), { code: "AGENT_RUN_WRITEBACK_INVALID" });
  }
  const directory = join(workspace.artifacts, "writebacks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proposal = staged.document || {};
  const comparable = {
    version: RUN_WRITEBACK_RECEIPT_VERSION,
    run_id: runId,
    call_id: callId,
    tool_name: toolName,
    project_id: projectId || null,
    proposal_hash: staged.proposal_hash,
    approved_request_id: approvedRequestId || null,
    kind: proposal.kind || staged.kind || null,
    target: proposal.target || staged.target || null,
    operation: proposal.operation || null,
    before: proposal.before ?? null,
    proposed_after: proposal.proposed_after ?? null,
    actual_after: actualAfter ?? null,
  };
  const document = {
    ...comparable,
    status: "applied",
    applied_at: new Date().toISOString(),
    receipt_hash: hash(comparable),
  };
  const path = join(directory, `${safeFileId(callId)}.applied.json`);
  const stored = await writeImmutable(path, document, {
    expectedVersion: RUN_WRITEBACK_RECEIPT_VERSION,
    expectedHashField: "receipt_hash",
  });
  return {
    ...stored,
    path,
    version: stored.document.version,
    receipt_hash: stored.document.receipt_hash,
    proposal_hash: stored.document.proposal_hash,
    kind: stored.document.kind,
    target: stored.document.target,
  };
}

export function runWritebackRef(staged) {
  if (!staged) return null;
  return {
    version: staged.version || null,
    kind: staged.kind || null,
    target: staged.target || null,
    path: staged.path || null,
    proposal_hash: staged.proposal_hash || null,
    receipt_hash: staged.receipt_hash || null,
  };
}

export default {
  RUN_WRITEBACK_PROPOSAL_VERSION,
  RUN_WRITEBACK_RECEIPT_VERSION,
  completeRunWriteback,
  runWritebackRef,
  stageRunWriteback,
};
