import { basename, dirname } from "node:path";

import { artifactActionsFor } from "./artifact_actions.js";
import { publishProjectArtifact } from "./project_artifact_store.js";

function clean(value) {
  return String(value || "").trim();
}

function contractFor(tool = {}) {
  const value = tool.output_contract;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    role: value.role === "intermediate" ? "intermediate" : "deliverable",
    surface: ["inline", "workspace", "both"].includes(value.surface) ? value.surface : "inline",
    persistence: value.persistence === "library" ? "library" : "none",
    kind: clean(value.kind) || "file",
    pathField: clean(value.path_field || value.pathField),
    trustedGeneratedPath: value.trusted_generated_path === true,
  };
}

function source(agentContext, callId) {
  return {
    sessionId: agentContext?.session_id || null,
    turnId: agentContext?.runtime_turn_id || agentContext?.runtime?.turnId || agentContext?.task_id || null,
    runId: agentContext?.runtime?.runId || agentContext?.task_id || null,
    itemId: callId || null,
    toolCallId: callId || null,
  };
}

function resultDetails(result) {
  return result?.details && typeof result.details === "object" && !Array.isArray(result.details)
    ? result.details
    : {};
}

async function recordArtifact(agentContext, callId, artifact, toolName) {
  const version = artifact?.current_version;
  if (!artifact || !version || typeof agentContext?.runtime?.recordArtifact !== "function") return;
  await agentContext.runtime.recordArtifact({
    callId: callId || null,
    kind: "library_artifact",
    path: version.snapshot_path || null,
    mimeType: version.mime_type || null,
    sizeBytes: version.size_bytes || null,
    sha256: version.sha256 || null,
    metadata: {
      project_artifact_id: artifact.id,
      project_artifact_version_id: version.id || null,
      version_number: version.version_number || null,
      generated_by: toolName,
    },
  }).catch(() => null);
}

/**
 * Apply one host-wide output contract after a dynamic tool succeeds.
 *
 * The tool keeps owning how content is created. This layer only decides whether
 * the result is a deliverable, where it appears, and whether it enters Library.
 * Publication failure never hides an already-created inline result.
 */
export async function deliverToolOutput({ agentContext, tool, result, callId } = {}) {
  const contract = contractFor(tool);
  if (!contract || !result || result?.isError === true || result?.success === false || result?.details?.success === false) {
    return result;
  }

  const details = resultDetails(result);
  const existingArtifact = details.artifact && typeof details.artifact === "object" ? details.artifact : null;
  const path = contract.pathField ? clean(details[contract.pathField]) : "";
  const temporary = agentContext?.temporary === true || agentContext?.input_data?.temporary === true;
  let artifact = existingArtifact;
  let warning = null;
  let persistence = contract.persistence;

  if (temporary && persistence === "library") persistence = "none";
  if (!artifact && persistence === "library" && path) {
    try {
      const allowedRoots = [...new Set([
        ...(contract.trustedGeneratedPath ? [dirname(path)] : []),
        agentContext?.workspace_write_root,
        ...(Array.isArray(agentContext?.workspace_roots) ? agentContext.workspace_roots : []),
      ].map(clean).filter(Boolean))];
      const published = await publishProjectArtifact(agentContext.db, {
        userId: agentContext?.user_id || "",
        projectId: agentContext?.project_id || "",
        sourcePath: path,
        allowedRoots,
        name: basename(path),
        kind: contract.kind,
        description: `由 ${tool?.name || "工具"} 创建`,
        changeSummary: "创建产物",
        source: source(agentContext, callId),
        metadata: { generated_by: tool?.name || null },
      });
      artifact = published.artifact;
      await recordArtifact(agentContext, callId, artifact, tool?.name || null);
    } catch (cause) {
      warning = `产物已生成，但保存到 Library 失败：${cause?.message || String(cause)}`;
    }
  }

  const deliveryPath = path || artifact?.current_version?.snapshot_path || null;
  const outputDelivery = {
    role: contract.role,
    surface: contract.surface,
    persistence,
    kind: contract.kind,
    path: deliveryPath,
    actions: artifactActionsFor({ kind: contract.kind, path: deliveryPath }),
    artifact_id: artifact?.id || null,
    artifact_version_id: artifact?.current_version?.id || null,
    temporary,
    status: warning ? "publication_failed" : artifact ? "published" : persistence === "none" ? "inline_only" : "not_materialized",
  };
  const hostActions = Array.isArray(details.host_actions) ? details.host_actions.slice() : [];
  if (artifact && !hostActions.some((action) => action?.event?.artifact_id === artifact.id)) {
    hostActions.push({
      type: "workspace_event",
      event: {
        type: "workspace_event",
        event: "artifact_published",
        project_id: agentContext?.project_id || null,
        artifact_id: artifact.id,
        artifact,
        open: false,
      },
    });
  }
  return {
    ...result,
    details: {
      ...details,
      ...(artifact ? { artifact } : {}),
      ...(warning ? { artifact_warning: warning } : {}),
      ...(hostActions.length ? { host_actions: hostActions } : {}),
      output_delivery: outputDelivery,
    },
  };
}

export default deliverToolOutput;
