import { chat } from "./llm.js";

function shortError(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 300);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class AiOutputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiOutputValidationError";
  }
}

export class AiCapabilityError extends Error {
  constructor(message, { code = "AI_CAPABILITY_FAILED", cause = null, attempts = 0 } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AiCapabilityError";
    this.code = code;
    this.attempts = attempts;
  }
}

/**
 * Run one structured AI capability behind a common trust boundary.
 *
 * `chat()` guarantees only that the response can be parsed as JSON. The validator
 * supplied here is responsible for checking business references, enums and limits.
 * Validation failures are sent back to the model once, then surfaced as an explicit
 * capability failure instead of being saved as a successful result.
 */
export async function runStructuredAi({
  messages,
  schema,
  validate,
  projectId,
  callSite,
  temperature = 0.1,
  maxTokens = 3000,
  maxAttempts = 2,
  chatFn = chat,
}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new TypeError("messages 不能为空");
  }
  if (typeof validate !== "function") {
    throw new TypeError("validate 必须是函数");
  }
  if (!projectId) throw new TypeError("projectId 不能为空");
  if (!callSite) throw new TypeError("callSite 不能为空");

  const baseMessages = messages.map((item) => ({ ...item }));
  let attemptMessages = baseMessages;
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    try {
      const raw = await chatFn(attemptMessages, {
        response_model: schema,
        response_format: { type: "json_object" },
        temperature,
        max_tokens: maxTokens,
        max_retries: 1,
        transport_retries: 0,
        project_id: projectId,
        call_site: callSite,
      });
      if (!isPlainObject(raw)) {
        throw new AiOutputValidationError("模型必须返回 JSON 对象");
      }
      return { data: validate(raw), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const outputInvalid = error instanceof AiOutputValidationError || error?.code === "LLM_JSON_INVALID";
      attemptMessages = outputInvalid
        ? [
          ...baseMessages,
          {
            role: "user",
            content: `上一次输出未通过服务端校验：${shortError(error)}。请只修正 JSON 数据，不要添加解释。`,
          },
        ]
        : baseMessages;
    }
  }

  // Report the terminal failure. A validation failure followed by a network/model
  // failure must not tell users to fix output data when the model is unavailable.
  const code = lastError instanceof AiOutputValidationError || lastError?.code === "LLM_JSON_INVALID"
    ? "AI_OUTPUT_INVALID"
    : "AI_MODEL_UNAVAILABLE";
  const message = code === "AI_OUTPUT_INVALID"
    ? "模型返回的数据未通过校验，请稍后重试"
    : "AI 模型暂时不可用，请检查项目模型配置后重试";
  throw new AiCapabilityError(message, {
    code,
    cause: lastError,
    attempts: Math.max(1, maxAttempts),
  });
}
