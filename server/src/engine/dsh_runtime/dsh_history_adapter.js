// Cold-history adapter: project a DSH `session.history` response onto the
// dsh-work message format the renderer already consumes (the same shape
// listSessionMessages returns from the local session_messages table).
//
// DSH session.history is the authoritative source — the events + projections
// are the session log replayed through the same presenters that computed the
// live ToolEventView. This adapter folds those events into assistant/user
// messages using the SAME id-generation rules as DshEventAdapter, so a block
// produced from history has the identical id as the same event delivered live
// on the mux stream. That id stability is what lets the renderer dedupe when a
// live stream resumes after a cold recovery.

import {
  assistantItemId,
  reasoningItemId,
  turnIdFrom,
  toolCallItemFromEvent,
  toolResultItemFromEvent,
  workspaceEventFromToolResult,
  textFromBlocks,
  reasoningFromBlocks,
  planStepFromTodo,
  dshTurnStatus,
} from "./event_adapter.js";

/**
 * Fold DSH history events into dsh-work messages.
 *
 * Events arrive in seq order (oldest first). turn/start opens a turn group;
 * every event until turn/end (or the next turn/start) folds into ONE assistant
 * message whose content_items are the per-event items. user/message events
 * become standalone user messages.
 *
 * @param {object} input
 * @param {Array<{ event: object, view?: object }>} input.entries - DSH HistoryEntry[] from session.history.
 * @param {object} [input.projections] - the tail-page SessionProjectionsBlock values (todos/title/...).
 * @param {string} input.sessionId - the DSH runtime session id (used for stable item ids).
 * @param {string} [input.appSessionId] - owning dsh-work Session used for authorized attachment reads.
 * @param {string} [input.asOfSeq] - the projections.asOfSeq (last folded seq).
 * @returns {{ messages: object[], pendingInteractions: object[], planTodos: object[]|null, lastSeq: number, title: string|null }}
 */
export function dshEventsToMessages({ entries, projections, sessionId, appSessionId = null }) {
  const messages = [];
  const pendingInteractions = [];
  let lastSeq = -1;
  let currentTurn = null; // { turnId, turnNum, startedAt, items, status }
  const projectionValues = projections?.values || {};
  const planTodos = Array.isArray(projectionValues.todos) ? projectionValues.todos : null;
  const title = typeof projectionValues.title === "string" ? projectionValues.title : null;

  const flushTurn = () => {
    if (currentTurn === null) return;
    // Skip SYNTHETIC turns that accumulated no visible content. Synthetic
    // turns are opened by the adapter for events that arrive before the first
    // turn/start (e.g. permission/preset, sandbox/mode, approval/policy,
    // agent/inbox/spliced) — session initialization noise the user never
    // chose to see. Real turns (opened by an explicit turn/start) are kept
    // even when empty, because they may carry a legitimate interrupted/
    // aborted status the renderer needs to display.
    if (currentTurn.items.length === 0 && !currentTurn.explicit) {
      currentTurn = null;
      return;
    }
    const status = currentTurn.status || "completed";
    messages.push({
      id: currentTurn.turnId,
      session_id: sessionId,
      role: "assistant",
      content_items: currentTurn.items,
      message_metadata: {
        message_id: currentTurn.turnId,
        thread_id: sessionId,
        turn_id: currentTurn.turnId,
        run_id: currentTurn.turnId,
        turn_status: status,
        started_at: currentTurn.startedAt ? new Date(currentTurn.startedAt).toISOString() : null,
        completed_at: currentTurn.completedAt ? new Date(currentTurn.completedAt).toISOString() : null,
        dsh_recovery: true,
        dsh_last_seq: lastSeq,
        ...(planTodos ? { dsh_plan_todos: planTodos } : {}),
      },
      sequence_number: messages.length + 1,
      created_at: currentTurn.startedAt ? new Date(currentTurn.startedAt).toISOString() : new Date().toISOString(),
      timestamp: currentTurn.startedAt ? new Date(currentTurn.startedAt).toISOString() : new Date().toISOString(),
    });
    currentTurn = null;
  };

  for (const entry of entries) {
    const event = entry?.event;
    if (!event || typeof event !== "object") continue;
    if (typeof event.seq === "number") lastSeq = Math.max(lastSeq, event.seq);
    const view = entry.view || null;
    const turnNum = event.data?.turn ?? event.seq;

    // user/message → standalone user message. DSH logs both the initial prompt
    // and steer messages after turn/start, so a user row must not close the
    // open assistant Turn; only turn/end or the next turn/start does that.
    if (event.type === "user/message") {
      // DSH tags the origin of each message via `source.kind`. Only
      // kind==="user" is a real human-typed message; "plugin" (runtime
      // context snapshots), "skill-catalog" (skill reminders), and other
      // system kinds are DSH-internal context the user never wrote — skip
      // them so they don't appear as fake user bubbles in chat history.
      const sourceKind = String(event.data?.source?.kind || "").trim();
      if (sourceKind && sourceKind !== "user") continue;
      // DSH user/message event data shape: { content: [...], role, source, id }
      // — there is NO `message` wrapper (unlike assistant/message which nests
      // under data.message.content). Try both paths so the adapter is robust
      // to either shape.
      const contentBlocks = event.data?.content || event.data?.message?.content;
      const text = textFromBlocks(contentBlocks);
      const userItemId = `dsh:${sessionId}:user:${event.seq}`;
      const imageItems = (Array.isArray(contentBlocks) ? contentBlocks : []).flatMap((block, index) => {
        const attachment = block?.type === "image" ? block.attachment : null;
        const attachmentId = String(attachment?.attachmentId || "").trim();
        const mediaType = String(attachment?.mediaType || "").trim();
        if (!(attachmentId && mediaType.startsWith("image/"))) return [];
        const sha256 = attachmentId.startsWith("sha256:") ? attachmentId.slice("sha256:".length) : "";
        const name = String(attachment?.name || `image-${index + 1}`).trim();
        return [{
          id: `${userItemId}:image:${index}`,
          type: "attachment",
          content: name,
          display_type: "file",
          metadata: {
            path: `dsh-attachment:${attachmentId}`,
            name,
            mime_type: mediaType,
            size_bytes: Number(attachment?.bytes || 0) || null,
            width: Number(attachment?.width || 0) || null,
            height: Number(attachment?.height || 0) || null,
            kind: "image",
            dsh_attachment_id: attachmentId,
            dsh_session_id: sessionId,
            ...(appSessionId ? { dsh_app_session_id: appSessionId } : {}),
            ...(sha256 ? { sha256 } : {}),
          },
        }];
      });
      messages.push({
        id: userItemId,
        session_id: sessionId,
        role: "user",
        content_items: [
          ...imageItems,
          ...(text ? [{ id: userItemId, type: "inputText", text, status: "completed" }] : []),
        ],
        message_metadata: {
          message_id: userItemId,
          thread_id: sessionId,
          dsh_prompt_rpc_id: String(event.data?.source?.rpcId || "").trim() || null,
          dsh_recovery: true,
        },
        sequence_number: messages.length + 1,
        created_at: event.time ? new Date(Number(event.time)).toISOString() : new Date().toISOString(),
        timestamp: event.time ? new Date(Number(event.time)).toISOString() : new Date().toISOString(),
      });
      continue;
    }

    // turn/start → open a new assistant turn group.
    if (event.type === "turn/start") {
      flushTurn();
      currentTurn = {
        turnId: turnIdFrom(sessionId, event),
        turnNum,
        startedAt: Number(event.time || Date.now()),
        completedAt: null,
        items: [],
        status: "inProgress",
        explicit: true,
      };
      continue;
    }

    // turn/end → close the current turn with its terminal status.
    if (event.type === "turn/end") {
      if (currentTurn !== null) {
        currentTurn.completedAt = Number(event.time || Date.now());
        currentTurn.status = dshTurnStatus(event.data?.reason);
      }
      flushTurn();
      continue;
    }

    // All other events fold into the current turn. If no turn is open (e.g.
    // events before the first turn/start), open a synthetic one so the items
    // are not lost.
    if (currentTurn === null) {
      currentTurn = {
        turnId: turnIdFrom(sessionId, event),
        turnNum,
        startedAt: Number(event.time || Date.now()),
        completedAt: null,
        items: [],
        status: "inProgress",
        explicit: false,
      };
    }

    foldEventIntoTurn(currentTurn, event, view, sessionId);
  }
  // Flush a still-open turn (history fetched mid-turn: no turn/end yet).
  flushTurn();

  return { messages, pendingInteractions, planTodos, lastSeq, title };
}

/** Fold one DSH event into the current turn's content_items (same shape DshEventAdapter emits). */
function foldEventIntoTurn(turn, event, view, sessionId) {
  const upsertItem = (item) => {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) turn.items[index] = item;
    else turn.items.push(item);
  };
  switch (event.type) {
    case "assistant/message": {
      const content = event.data?.message?.content;
      const reasoning = reasoningFromBlocks(content);
      if (reasoning) {
        upsertItem({
          id: reasoningItemId(sessionId, event),
          type: "thinking",
          content: reasoning,
          status: "completed",
        });
      }
      const text = textFromBlocks(content);
      if (text) {
        upsertItem({
          id: assistantItemId(sessionId, event),
          type: "agentMessage",
          // `content` is the field the renderer's mapServerMessage reads
          // (matching the persisted item shape from AgentStreamAdapter).
          content: text,
          status: "completed",
        });
      }
      break;
    }
    case "tool/call": {
      turn.items.push(toolCallItemFromEvent(event, view));
      break;
    }
    case "tool/result": {
      const itemId = String(event.data?.message?.source?.callId || `dsh-tool:${event.seq ?? ""}`);
      const index = turn.items.findIndex((item) => item.id === itemId && item.type === "dynamicToolCall");
      const callItem = index >= 0 ? turn.items[index] : null;
      const resultItem = toolResultItemFromEvent(event, view, callItem);
      if (index >= 0) turn.items[index] = resultItem;
      else turn.items.push(resultItem);
      const workspaceEvent = workspaceEventFromToolResult(event, callItem);
      if (workspaceEvent) {
        turn.items.push({
          id: `${itemId}:workspace-event`,
          type: "workspace_event",
          content: JSON.stringify(workspaceEvent),
          metadata: { display: false, workspace_event: workspaceEvent },
        });
      }
      break;
    }
    case "todo/write": {
      const steps = (event.data?.todos || []).map(planStepFromTodo);
      turn.items.push({
        id: `dsh:${sessionId}:plan:${event.seq}`,
        type: "plan",
        status: "completed",
        // `content` carries the serialized steps so the renderer's
        // normalizePlanSteps(block.content) can fold them on cold recovery;
        // `steps` is the structured form for direct consumers.
        content: JSON.stringify(steps),
        steps,
      });
      break;
    }
    // assistant/chunk is the raw token stream; history uses assistant/message for the final text.
    // Other event types (step/start, request/header, etc.) carry no user-visible content item.
    default:
      break;
  }
}
