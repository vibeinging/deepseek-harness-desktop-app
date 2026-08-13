const APPROVAL_MODE_SETTINGS = Object.freeze({
  ask: Object.freeze({
    mode: "ask",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  }),
  auto: Object.freeze({
    mode: "auto",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  }),
  unattended: Object.freeze({
    mode: "unattended",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  }),
  full: Object.freeze({
    mode: "full",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  }),
});

export function normalizeApprovalMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return Object.hasOwn(APPROVAL_MODE_SETTINGS, mode) ? mode : "ask";
}

export function approvalSettingsForMode(value) {
  return APPROVAL_MODE_SETTINGS[normalizeApprovalMode(value)];
}

export default approvalSettingsForMode;
