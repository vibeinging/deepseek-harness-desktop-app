// Thin provider adapters: raw platform payload -> normalized IM Gateway event.
//
// Only message normalization is done here; no platform SDK, long-connection lifecycle, or agent execution.
// Incoming platform messages should call these entries, then be routed through gateway.handleConnectorEvent.
import { handleConnectorEvent } from "./gateway.js";

const parseJson = (value, fallback = {}) => {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const first = (...values) => {
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (s) return s;
  }
  return "";
};

function normalizeFeishu(body = {}) {
  const event = body.event || body;
  const header = body.header || event.header || {};
  const message = event.message || body.message || {};
  const sender = event.sender || body.sender || {};
  const senderId = sender.sender_id || sender.id || sender || {};
  const content = parseJson(message.content || event.content || body.content, {});
  const text = first(content.text, content.content, event.text, body.text, body.message_text);
  return {
    event_id: first(header.event_id, message.message_id, body.event_id),
    message_id: first(message.message_id, body.message_id, body.msg_id),
    external_user_id: first(senderId.open_id, senderId.user_id, sender.open_id, sender.user_id, body.external_user_id),
    external_union_id: first(senderId.union_id, sender.union_id, body.external_union_id) || null,
    chat_id: first(message.chat_id, event.chat_id, body.chat_id) || null,
    chat_type: first(message.chat_type, event.chat_type, body.chat_type) === "group" ? "group" : first(message.chat_id, event.chat_id, body.chat_id) ? "group" : "dm",
    text,
    raw: body,
  };
}

function normalizeWecom(body = {}) {
  const event = body.event || body;
  const from = event.from || body.from || {};
  const message = event.message || body.message || event;
  const text = first(
    message.Content,
    message.content,
    event.Content,
    event.content,
    event.text,
    body.text,
  );
  const chatId = first(message.ChatId, message.chatid, message.chat_id, event.ChatId, event.chatid, event.chat_id, body.chat_id);
  return {
    event_id: first(message.MsgId, message.msgid, message.msg_id, message.message_id, event.MsgId, event.msgid, body.event_id),
    message_id: first(message.MsgId, message.msgid, message.msg_id, message.message_id, body.message_id),
    external_user_id: first(
      message.FromUserName,
      message.from_user,
      message.from_userid,
      event.FromUserName,
      event.from_user,
      event.from_userid,
      from.userid,
      from.user_id,
      body.external_user_id,
    ),
    external_union_id: first(message.unionid, event.unionid, from.unionid, body.external_union_id) || null,
    chat_id: chatId || null,
    chat_type: chatId ? "group" : "dm",
    text,
    raw: body,
  };
}

export async function handleFeishuEvent(ctx, input) {
  return handleConnectorEvent(ctx, {
    ...input,
    body: normalizeFeishu(input.body || {}),
  });
}

export async function handleWecomEvent(ctx, input) {
  return handleConnectorEvent(ctx, {
    ...input,
    body: normalizeWecom(input.body || {}),
  });
}
