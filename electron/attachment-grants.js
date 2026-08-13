'use strict';

const { createHmac, randomUUID } = require('node:crypto');

function createAttachmentGrant(path, secret, {
  now = Date.now(),
  ttlMs = 5 * 60_000,
  grantId = randomUUID(),
} = {}) {
  const payloadSegment = Buffer.from(JSON.stringify({
    v: 1,
    jti: grantId,
    path: String(path || '').trim(),
    iat: now,
    exp: now + ttlMs,
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  return `${payloadSegment}.${signature}`;
}

module.exports = { createAttachmentGrant };
