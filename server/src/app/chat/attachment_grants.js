import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../../errors.js";

const MAX_GRANT_AGE_MS = 10 * 60_000;
const spentGrants = new Map();

function clean(value) {
  return String(value || "").trim();
}

function signature(secret, payloadSegment) {
  return createHmac("sha256", secret).update(payloadSegment).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function pruneSpent(now) {
  for (const [grantId, expiresAt] of spentGrants) {
    if (expiresAt <= now) spentGrants.delete(grantId);
  }
}

/**
 * Packaged desktop runs always provide DSH_ATTACHMENT_GRANT_SECRET. Standalone
 * developer servers omit it so direct API/eval image fixtures keep working.
 */
export function verifyAndConsumeAttachmentGrant(path, token, {
  secret = process.env.DSH_ATTACHMENT_GRANT_SECRET,
  now = Date.now(),
} = {}) {
  const signingSecret = clean(secret);
  if (!signingSecret) return { enforced: false, grantId: null };
  const rawToken = clean(token);
  const [payloadSegment, suppliedSignature, extra] = rawToken.split(".");
  if (!payloadSegment || !suppliedSignature || extra !== undefined) {
    throw new ApiError("图片附件未经过桌面选择，请重新添加", 400);
  }
  if (!safeEqual(signature(signingSecret, payloadSegment), suppliedSignature)) {
    throw new ApiError("图片附件授权无效，请重新添加", 400);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("图片附件授权无效，请重新添加", 400);
  }
  const expiresAt = Number(payload?.exp || 0);
  const issuedAt = Number(payload?.iat || 0);
  const grantId = clean(payload?.jti);
  if (
    payload?.v !== 1
    || !grantId
    || clean(payload?.path) !== clean(path)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(issuedAt)
    || issuedAt > now + 30_000
    || expiresAt <= now
    || expiresAt - issuedAt > MAX_GRANT_AGE_MS
  ) {
    throw new ApiError("图片附件授权已过期或与文件不匹配，请重新添加", 400);
  }
  pruneSpent(now);
  if (spentGrants.has(grantId)) throw new ApiError("图片附件授权已使用，请重新添加", 400);
  spentGrants.set(grantId, expiresAt);
  return { enforced: true, grantId };
}

export function clearAttachmentGrantsForTests() {
  spentGrants.clear();
}
