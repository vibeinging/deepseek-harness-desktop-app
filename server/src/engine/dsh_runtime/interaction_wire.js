export function acceptedDshDecision(decision) {
  if (decision === true) return true;
  if (decision === false || decision == null) return false;
  if (typeof decision === "string") {
    return ["accept", "acceptForSession", "acceptAlways", "allowed-once", "allowed-session"].includes(decision);
  }
  return Boolean(decision.acceptWithExecpolicyAmendment || decision.applyNetworkPolicyAmendment);
}

export function dshQuestionAnswers(questions, response) {
  return (Array.isArray(questions) ? questions : []).map((question) => {
    const raw = response?.answers?.[question.id];
    const values = Array.isArray(raw?.answers) ? raw.answers : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    const input = values.map((value) => String(value));
    const labels = new Set((question.options || []).map((option) => String(option.label)));
    const selected = input.filter((value) => labels.has(value));
    const custom = input.filter((value) => !labels.has(value)).join("\n").trim();
    return {
      id: String(question.id),
      selected,
      ...(custom ? { custom } : {}),
    };
  });
}
