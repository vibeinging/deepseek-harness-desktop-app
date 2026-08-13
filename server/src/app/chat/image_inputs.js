import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { ApiError } from "../../errors.js";
import { verifyAndConsumeAttachmentGrant } from "./attachment_grants.js";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_EDGE = 16_384;
const MAX_IMAGE_PIXELS = 100_000_000;
const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

function clean(value) {
  return String(value || "").trim();
}

function isCandidateImagePath(path) {
  const lower = clean(path).toLowerCase();
  return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || detectImageMime(buffer) !== "image/png") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  if (detectImageMime(buffer) !== "image/jpeg") return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if ([0xd8, 0xd9].includes(marker)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (detectImageMime(buffer) !== "image/webp" || buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L" && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function gifDimensions(buffer) {
  if (detectImageMime(buffer) !== "image/gif" || buffer.length < 10) return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === "image/png") return pngDimensions(buffer);
  if (mimeType === "image/jpeg") return jpegDimensions(buffer);
  if (mimeType === "image/webp") return webpDimensions(buffer);
  if (mimeType === "image/gif") return gifDimensions(buffer);
  return null;
}

function validateImageDimensions(dimensions) {
  const width = Number(dimensions?.width || 0);
  const height = Number(dimensions?.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ApiError("图片结构损坏，无法读取尺寸", 400);
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
    throw new ApiError("图片尺寸过大，请缩小后再发送", 400);
  }
  return { width, height };
}

async function inspectLocalImage(rawPath, attachmentGrant) {
  const requestedPath = clean(rawPath);
  if (!requestedPath || !isAbsolute(requestedPath)) throw new ApiError("图片路径必须是绝对路径", 400);
  verifyAndConsumeAttachmentGrant(requestedPath, attachmentGrant);
  let resolved;
  let fileStat;
  try {
    resolved = await realpath(requestedPath);
    fileStat = await stat(resolved);
  } catch {
    throw new ApiError("图片不存在或无法读取", 400);
  }
  if (!fileStat.isFile()) throw new ApiError("图片路径不是文件", 400);
  if (fileStat.size <= 0 || fileStat.size > MAX_IMAGE_BYTES) throw new ApiError("单张图片必须小于 20 MB", 400);
  let bytes;
  try {
    bytes = await readFile(resolved);
  } catch {
    throw new ApiError("图片不存在或无法读取", 400);
  }
  if (bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES) throw new ApiError("单张图片必须小于 20 MB", 400);
  const mimeType = detectImageMime(bytes);
  if (!mimeType) throw new ApiError("只支持真实的 PNG、JPEG、WebP 或 GIF 图片", 400);
  const dimensions = validateImageDimensions(imageDimensions(bytes, mimeType));
  return {
    path: resolved,
    mime_type: mimeType,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: dimensions.width || null,
    height: dimensions.height || null,
  };
}

function normalizeDetail(value) {
  return ["auto", "low", "high", "original"].includes(value) ? value : undefined;
}

export async function prepareImageTurnInput(input = [], attachments = []) {
  const rawInput = Array.isArray(input) ? input.filter((item) => item && typeof item === "object") : [];
  const candidates = [];
  const seenRequested = new Set();
  for (const item of rawInput) {
    if (item.type !== "localImage") continue;
    const path = clean(item.path);
    if (!path || seenRequested.has(path)) continue;
    seenRequested.add(path);
    candidates.push({
      path,
      detail: normalizeDetail(item.detail),
      attachmentGrant: clean(item.attachmentGrant || item.attachment_grant),
    });
  }
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const path = clean(attachment?.path);
    if (!path || attachment?.is_dir || attachment?.isDir || seenRequested.has(path) || !isCandidateImagePath(path)) continue;
    seenRequested.add(path);
    candidates.push({
      path,
      attachmentGrant: clean(attachment?.attachmentGrant || attachment?.attachment_grant),
    });
  }
  if (candidates.length > MAX_IMAGES) throw new ApiError(`每轮最多添加 ${MAX_IMAGES} 张图片`, 400);

  const images = [];
  const seenReal = new Set();
  let totalBytes = 0;
  for (const candidate of candidates) {
    const inspected = await inspectLocalImage(candidate.path, candidate.attachmentGrant);
    if (seenReal.has(inspected.path)) continue;
    seenReal.add(inspected.path);
    totalBytes += inspected.size_bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new ApiError("每轮图片总大小不能超过 40 MB", 400);
    images.push({ ...inspected, requested_path: candidate.path, detail: candidate.detail });
  }

  const withoutLocalImages = rawInput.filter((item) => item.type !== "localImage");
  const normalizedInput = [
    ...withoutLocalImages,
    ...images.map((image) => ({
      type: "localImage",
      path: image.path,
      mediaType: image.mime_type,
      name: basename(image.path),
      sizeBytes: image.size_bytes,
      sha256: image.sha256,
      ...(image.detail ? { detail: image.detail } : {}),
    })),
  ];
  const metadataByPath = new Map(images.flatMap((image) => [
    [image.path, image],
    [image.requested_path, image],
  ]));
  const enrichedAttachments = (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    const { attachmentGrant: _camelGrant, attachment_grant: _snakeGrant, ...safeAttachment } = attachment || {};
    const rawPath = clean(attachment?.path);
    const matched = metadataByPath.get(rawPath);
    return matched ? {
      ...safeAttachment,
      path: matched.path,
      mime_type: matched.mime_type,
      size_bytes: matched.size_bytes,
      sha256: matched.sha256,
      width: matched.width,
      height: matched.height,
      kind: "image",
    } : safeAttachment;
  });
  return { input: normalizedInput, attachments: enrichedAttachments, images };
}

export const IMAGE_INPUT_LIMITS = Object.freeze({
  max_images: MAX_IMAGES,
  max_image_bytes: MAX_IMAGE_BYTES,
  max_total_image_bytes: MAX_TOTAL_IMAGE_BYTES,
  max_image_edge: MAX_IMAGE_EDGE,
  max_image_pixels: MAX_IMAGE_PIXELS,
});
