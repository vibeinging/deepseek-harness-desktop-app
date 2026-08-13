import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  detectImageMime,
  prepareImageTurnInput,
} from "../../server/src/app/chat/image_inputs.js";
import {
  dshPromptContent,
  normalizeDshPromptError,
} from "../../server/src/engine/dsh_runtime/prompt_content.js";
import {
  clearAttachmentGrantsForTests,
} from "../../server/src/app/chat/attachment_grants.js";
import { buildUserContentItems } from "../../server/src/app/chat/message_blocks.js";
import { runtimeCapabilitiesFromConfig } from "../../server/src/engine/agent_kernel/runtime_parameters.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ONE_PIXEL_GIF = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
const require = createRequire(import.meta.url);
const { createAttachmentGrant: createDesktopAttachmentGrant } = require("../../electron/attachment-grants.js");

test("supported local image attachments become validated localImage turn inputs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const resolvedImagePath = await realpath(imagePath);

  const prepared = await prepareImageTurnInput(
    [{ type: "text", text: "读取截图" }, { type: "localImage", path: imagePath }],
    [{ path: imagePath, name: "screen.png", is_dir: false }],
  );

  assert.equal(prepared.images.length, 1);
  assert.equal(prepared.images[0].mime_type, "image/png");
  assert.equal(prepared.images[0].width, 1);
  assert.equal(prepared.images[0].height, 1);
  assert.match(prepared.images[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(prepared.input, [
    { type: "text", text: "读取截图" },
    {
      type: "localImage",
      path: resolvedImagePath,
      mediaType: "image/png",
      name: "screen.png",
      sizeBytes: ONE_PIXEL_PNG.length,
      sha256: prepared.images[0].sha256,
    },
  ]);
  assert.equal(prepared.attachments[0].kind, "image");
  assert.equal(prepared.attachments[0].mime_type, "image/png");
});

test("validated local images become official DSH prompt parts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-prompt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);

  const prepared = await prepareImageTurnInput([
    { type: "text", text: "读取截图" },
    { type: "localImage", path: imagePath },
  ]);
  const content = await dshPromptContent(prepared.input);
  assert.deepEqual(content, [
    { type: "text", text: "读取截图" },
    { type: "image", mediaType: "image/png", data: ONE_PIXEL_PNG.toString("base64"), name: "screen.png" },
  ]);
});

test("DSH prompt conversion refuses an image that bypassed local validation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-unvalidated-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  await assert.rejects(
    dshPromptContent([{ type: "localImage", path: imagePath }]),
    (error) => error?.code === "DSH_IMAGE_INPUT_INVALID",
  );
});

test("DSH prompt conversion refuses bytes changed after local validation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-changed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const prepared = await prepareImageTurnInput([{ type: "localImage", path: imagePath }]);
  await writeFile(imagePath, Buffer.concat([ONE_PIXEL_PNG, Buffer.from([0])]));
  await assert.rejects(
    dshPromptContent(prepared.input),
    (error) => error?.code === "DSH_IMAGE_INPUT_CHANGED",
  );
});

test("DSH image rejection keeps its reason and uses product copy", () => {
  const original = Object.assign(new Error("Model does not support image input"), {
    code: "attachment-error",
    details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" },
  });
  const normalized = normalizeDshPromptError(original);
  assert.equal(normalized.message, "当前模型不支持图片，请切换到支持图片输入的模型");
  assert.equal(normalized.code, "attachment-error");
  assert.equal(normalized.details.reason, "MODEL_DOES_NOT_SUPPORT_IMAGES");
  assert.equal(normalized.cause, original);
});

test("image validation uses file bytes instead of trusting a png extension", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-spoof-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakePath = join(dir, "not-an-image.png");
  await writeFile(fakePath, "plain text");

  await assert.rejects(
    prepareImageTurnInput([{ type: "localImage", path: fakePath }], []),
    /只支持真实的 PNG、JPEG、WebP 或 GIF 图片/,
  );
});

test("GIF follows the same DSH image admission path as PNG, JPEG and WebP", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-gif-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "pixel.gif");
  await writeFile(imagePath, ONE_PIXEL_GIF);
  const prepared = await prepareImageTurnInput([{ type: "localImage", path: imagePath }], []);
  assert.equal(prepared.images[0].mime_type, "image/gif");
  assert.equal(prepared.images[0].width, 1);
  assert.equal(prepared.images[0].height, 1);
  const [content] = await dshPromptContent(prepared.input);
  assert.equal(content.mediaType, "image/gif");
  assert.equal(content.data, ONE_PIXEL_GIF.toString("base64"));
});

test("image validation rejects oversized pixel dimensions before model upload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-dimensions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oversized = Buffer.from(ONE_PIXEL_PNG);
  oversized.writeUInt32BE(20_000, 16);
  oversized.writeUInt32BE(20_000, 20);
  const imagePath = join(dir, "oversized.png");
  await writeFile(imagePath, oversized);
  await assert.rejects(
    prepareImageTurnInput([{ type: "localImage", path: imagePath }], []),
    /图片尺寸过大/,
  );
});

test("packaged desktop image reads require a path-bound one-time native grant", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-grant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const resolvedImagePath = await realpath(imagePath);
  const secret = "test-attachment-grant-secret-with-enough-entropy";
  const previousSecret = process.env.DSH_ATTACHMENT_GRANT_SECRET;
  process.env.DSH_ATTACHMENT_GRANT_SECRET = secret;
  clearAttachmentGrantsForTests();
  t.after(() => {
    clearAttachmentGrantsForTests();
    if (previousSecret === undefined) delete process.env.DSH_ATTACHMENT_GRANT_SECRET;
    else process.env.DSH_ATTACHMENT_GRANT_SECRET = previousSecret;
  });

  await assert.rejects(
    prepareImageTurnInput([{ type: "localImage", path: resolvedImagePath }], []),
    /未经过桌面选择/,
  );
  const grant = createDesktopAttachmentGrant(resolvedImagePath, secret);
  const prepared = await prepareImageTurnInput([{
    type: "localImage",
    path: resolvedImagePath,
    attachmentGrant: grant,
  }], []);
  assert.equal(prepared.images.length, 1);
  assert.deepEqual(prepared.input, [{
    type: "localImage",
    path: resolvedImagePath,
    mediaType: "image/png",
    name: "screen.png",
    sizeBytes: ONE_PIXEL_PNG.length,
    sha256: prepared.images[0].sha256,
  }]);
  await assert.rejects(
    prepareImageTurnInput([{
      type: "localImage",
      path: resolvedImagePath,
      attachmentGrant: grant,
    }], []),
    /授权已使用/,
  );
});

test("image MIME detection and model capability stay explicit", async () => {
  const [source, mainSource, runtimeSource] = await Promise.all([
    readFile(new URL("../../electron/preload.js", import.meta.url), "utf8"),
    readFile(new URL("../../electron/main.js", import.meta.url), "utf8"),
    readFile(new URL("../../server/src/engine/agent_kernel/agent_runtime.js", import.meta.url), "utf8"),
  ]);
  assert.equal(detectImageMime(ONE_PIXEL_PNG), "image/png");
  assert.equal(runtimeCapabilitiesFromConfig({ extra_config: { supports_image_input: true } }).supports_image_input, true);
  assert.equal(runtimeCapabilitiesFromConfig({ extra_config: {} }).supports_image_input, false);
  assert.match(source, /savePastedImageAttachment/);
  assert.match(source, /save-pasted-image-attachment/);
  assert.match(mainSource, /DSH_ATTACHMENT_GRANT_SECRET/);
  assert.match(mainSource, /authorizeAgentAttachmentRequest/);
  assert.match(mainSource, /registerNativeAttachmentPath/);
  assert.match(mainSource, /dsh-prompt\$/);
  assert.match(mainSource, /'\.gif'/);
  assert.match(runtimeSource, /delete runtimeEnv\.DSH_ATTACHMENT_GRANT_SECRET/);
});

test("validated image metadata survives message persistence projection", () => {
  const items = buildUserContentItems("读取截图", [{
    path: "/tmp/screen.png",
    name: "screen.png",
    mime_type: "image/png",
    size_bytes: 68,
    width: 1,
    height: 1,
    sha256: "a".repeat(64),
    kind: "image",
  }]);
  assert.equal(items[0].type, "attachment");
  assert.deepEqual(items[0].metadata, {
    path: "/tmp/screen.png",
    name: "screen.png",
    is_dir: false,
    mime_type: "image/png",
    size_bytes: 68,
    width: 1,
    height: 1,
    sha256: "a".repeat(64),
    kind: "image",
  });
});
