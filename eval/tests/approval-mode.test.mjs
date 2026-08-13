import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalSettingsForMode,
  normalizeApprovalMode,
} from "../../server/src/engine/agents/approval_mode.js";

test("approval modes map to Agent approval and reviewer settings", () => {
  assert.deepEqual(approvalSettingsForMode("ask"), {
    mode: "ask",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  assert.deepEqual(approvalSettingsForMode("auto"), {
    mode: "auto",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  });
  assert.deepEqual(approvalSettingsForMode("unattended"), {
    mode: "unattended",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  });
  assert.deepEqual(approvalSettingsForMode("full"), {
    mode: "full",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  assert.equal(normalizeApprovalMode("unknown"), "ask");
});
