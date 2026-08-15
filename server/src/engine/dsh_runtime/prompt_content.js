import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

function inputError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Preserve DSH attachment reason codes while presenting actionable product copy. */
export function normalizeDshPromptError(error) {
  if (error?.code !== "attachment-error") return error;
  const reason = String(error?.details?.reason || "attachment-error");
  let message;
  switch (reason) {
    case "MODEL_DOES_NOT_SUPPORT_IMAGES":
      message = "当前模型不支持图片，请切换到支持图片输入的模型";
      break;
    case "SUBAGENT_IMAGE_UNSUPPORTED":
      message = "当前子任务不能接收图片，请在主对话中发送";
      break;
    case "IMAGE_TOO_MANY_PIXELS":
      message = "图片分辨率过大，请压缩后重试";
      break;
    case "INVALID_IMAGE":
    case "IMAGE_TYPE_MISMATCH":
      message = "图片格式无效，请改用 PNG、JPEG、WebP 或 GIF";
      break;
    case "TOO_MANY_IMAGES":
      message = "图片数量超过 DSH 当前限制，请减少后重试";
      break;
    case "IMAGE_TOO_LARGE":
      message = "单张图片超过 DSH 当前限制，请压缩后重试";
      break;
    case "IMAGES_TOO_LARGE":
      message = "图片总大小超过 DSH 当前限制，请减少后重试";
      break;
    default:
      message = `图片发送失败（${reason}）`;
      break;
  }
  const normalized = new Error(message, { cause: error });
  normalized.code = error.code;
  normalized.details = { ...(error.details || {}), reason };
  return normalized;
}

/** Convert validated App turn input into the official DSH prompt wire. */
export async function dshPromptContent(input, { fallbackText = "" } = {}) {
  const items = Array.isArray(input) ? input : [];
  const content = [];
  for (const item of items) {
    if (item?.type === "text") {
      const text = String(item.text || "");
      if (text) content.push({ type: "text", text });
      continue;
    }
    if (item?.type === "localImage") {
      const path = String(item.path || "").trim();
      const mediaType = String(item.mediaType || item.mimeType || item.mime_type || "").trim();
      const expectedSize = Number(item.sizeBytes || item.size_bytes || 0);
      const expectedSha256 = String(item.sha256 || "").trim().toLowerCase();
      if (!path
        || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)
        || !Number.isSafeInteger(expectedSize)
        || expectedSize <= 0
        || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw inputError("图片必须先通过 DeepSeek Harness Desktop App 本地文件校验", "DSH_IMAGE_INPUT_INVALID");
      }
      const data = await readFile(path);
      const actualSha256 = createHash("sha256").update(data).digest("hex");
      if (data.length !== expectedSize || actualSha256 !== expectedSha256) {
        throw inputError("图片在本地校验后发生变化，请重新选择", "DSH_IMAGE_INPUT_CHANGED");
      }
      content.push({
        type: "image",
        mediaType,
        data: data.toString("base64"),
        name: String(item.name || basename(path)).trim() || basename(path),
      });
      continue;
    }
    throw inputError(`当前 DSH 不支持输入类型 ${String(item?.type || "unknown")}`, "DSH_INPUT_TYPE_UNSUPPORTED");
  }
  if (!content.length && fallbackText) content.push({ type: "text", text: String(fallbackText) });
  if (!content.length) throw inputError("请输入内容", "DSH_PROMPT_EMPTY");
  return content;
}
