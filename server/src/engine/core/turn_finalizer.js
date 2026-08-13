/**
 * The single decision point for a turn's user-facing answer.
 *
 * Runtime owns the terminal item id. Capability plugins only return whether
 * their own completion contract passed. The fields below are the only answer
 * contract used by the application.
 */

const NARRATIVE_ITEM_TYPES = new Set(["text", "markdown", "agentMessage"]);

function clean(value) {
  return String(value || "").trim();
}

function textFromItem(item) {
  const content = String(item?.content ?? "").trim();
  return content || String(item?.text ?? "").trim();
}

function isReasoningItem(item) {
  return item?.type === "reasoning" || item?.metadata?.item_type === "reasoning";
}

export function hasSubstantiveAnswerText(value) {
  return /[\p{L}\p{N}]/u.test(String(value || "").normalize("NFKC"));
}

export function invalidateNonSubstantiveNarrativeItems(items = []) {
  const invalid = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!NARRATIVE_ITEM_TYPES.has(String(item?.type || ""))) continue;
    const text = textFromItem(item);
    if (!text || isReasoningItem(item) || hasSubstantiveAnswerText(text)) continue;
    invalid.push({ ...item, original_text: text });
    item.content = "";
    if (Object.hasOwn(item, "text")) item.text = "";
    item.metadata = {
      ...(item.metadata || {}),
      display: false,
      protocol_violation: "NON_SUBSTANTIVE_NARRATIVE",
    };
  }
  return invalid;
}

/** Close any visible in-progress blocks when a turn can no longer continue. */
export function finalizeTerminalContentItems(items = [], turnStatus = "completed") {
  if (!Array.isArray(items) || !["interrupted", "failed"].includes(turnStatus)) return items;
  const title = turnStatus === "interrupted" ? "stopped" : "error";
  const status = turnStatus === "interrupted" ? "interrupted" : "failed";
  for (const item of items) {
    const itemStatus = String(item?.metadata?.status || item?.title || "").toLowerCase();
    const itemType = String(item?.type || "");
    const pendingApproval = ["confirm", "approval"].includes(itemType)
      && !["approved", "rejected", "stopped", "error"].includes(itemStatus);
    if (!pendingApproval && !["running", "inprogress", "in_progress", "requested"].includes(itemStatus)) continue;
    item.title = title;
    item.is_streaming = false;
    item.is_complete = true;
    item.metadata = { ...(item.metadata || {}), status };
    if (["file_change", "delegated_subtask", "user_input"].includes(itemType)) {
      try {
        const payload = JSON.parse(String(item.content || "{}"));
        item.content = JSON.stringify({ ...payload, status });
      } catch {
        // Keep the original visible content when an old history payload is not JSON.
      }
    }
  }
  return items;
}

export function resolveTurnAnswerCandidate(items = [], { answerItemId = "" } = {}) {
  const id = clean(answerItemId);
  if (!id) return null;
  const item = (Array.isArray(items) ? items : []).find((candidate) => String(candidate?.id || "") === id);
  if (!item || !NARRATIVE_ITEM_TYPES.has(String(item.type || ""))) return null;
  if (isReasoningItem(item)) return null;
  // Runtime's terminal item id is authoritative. A streamed item can retain an
  // earlier commentary phase even after the Runtime selects it as the terminal
  // answer, so phase must not override the explicit terminal identity.
  const text = textFromItem(item);
  if (!hasSubstantiveAnswerText(text)) return null;
  return { item, itemId: id, text };
}

function applyCanonicalAnswerPresentation(item, accepted, answerSource, reasonCode, reasonMessage) {
  if (!item) return null;
  const metadata = { ...(item.metadata || {}) };
  for (const key of ["phase", "msg_category", "result_role", "resultRole", "candidate_status"]) {
    delete metadata[key];
  }
  item.metadata = {
    ...metadata,
    display: accepted,
    answer_status: accepted ? "accepted" : "rejected",
    ...(accepted && answerSource ? { answer_source: answerSource } : {}),
    ...(reasonCode ? { answer_rejection_code: reasonCode } : {}),
    ...(reasonMessage ? { answer_rejection_message: reasonMessage } : {}),
  };
  return item;
}

export function finalizeTurnStatus(turnStatus, finalization) {
  const status = String(turnStatus || "failed");
  return status === "completed" && finalization?.accepted !== true ? "failed" : status;
}

export function finalizeTurnAnswer({
  items = [],
  answerItemId = "",
  turnStatus = "failed",
  capabilityStatus = turnStatus,
  answerSource = "runtime_terminal",
  rejectionCode = "",
  rejectionMessage = "",
} = {}) {
  const candidate = resolveTurnAnswerCandidate(items, { answerItemId });
  const accepted = Boolean(
    candidate
    && String(turnStatus) === "completed"
    && String(capabilityStatus) === "completed",
  );
  const reasonCode = accepted
    ? null
    : clean(rejectionCode) || (
      String(turnStatus) !== "completed"
        ? `TURN_${String(turnStatus || "failed").toUpperCase()}`
        : String(capabilityStatus) !== "completed"
          ? "TURN_CAPABILITY_REJECTED"
          : "TURN_ANSWER_MISSING"
    );
  const item = applyCanonicalAnswerPresentation(
    candidate?.item || null,
    accepted,
    answerSource,
    reasonCode,
    rejectionMessage,
  );
  return {
    status: accepted ? "accepted" : candidate ? "rejected" : "missing",
    accepted,
    answerItemId: candidate?.itemId || null,
    answerText: accepted ? candidate.text : "",
    answerSource: accepted ? answerSource : null,
    rejectionCode: accepted ? null : reasonCode,
    rejectionMessage: accepted ? null : clean(rejectionMessage) || null,
    item,
  };
}

export function answerMetadata(finalization = null) {
  if (!finalization) {
    return {
      answer_status: "missing",
      answer_item_id: null,
      answer_source: null,
      answer_rejection_code: "TURN_ANSWER_MISSING",
      answer_rejection_message: null,
    };
  }
  return {
    answer_status: finalization.status,
    answer_item_id: finalization.answerItemId || null,
    answer_source: finalization.answerSource || null,
    answer_rejection_code: finalization.rejectionCode || null,
    answer_rejection_message: finalization.rejectionMessage || null,
  };
}

export { NARRATIVE_ITEM_TYPES };

export default {
  answerMetadata,
  finalizeTerminalContentItems,
  finalizeTurnAnswer,
  finalizeTurnStatus,
  hasSubstantiveAnswerText,
  invalidateNonSubstantiveNarrativeItems,
  resolveTurnAnswerCandidate,
};
