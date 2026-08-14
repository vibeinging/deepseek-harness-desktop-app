'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const SETTINGS_SCHEMA_VERSION = 1;
const MAX_USER_SKINS = 64;
const MAX_SKINS_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BRAND_FILE_BYTES = 8 * 1024;
const MAX_APPEARANCE_FILE_BYTES = 256 * 1024;
const MAX_BG_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_BG_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const USER_SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROFILE_THEME_ID_PATTERN = /^profile:((?:[a-z0-9._!~*'()-]|%[0-9a-f]{2}){1,440}):[a-z0-9][a-z0-9_-]{0,62}$/i;

function isPersistableActiveSkinId(value) {
  if (USER_SKIN_ID_PATTERN.test(value)) return true;
  if (value.length > 512) return false;
  const match = PROFILE_THEME_ID_PATTERN.exec(value);
  if (!match) return false;
  try {
    return encodeURIComponent(decodeURIComponent(match[1])) === match[1];
  } catch {
    return false;
  }
}

class SettingsStoreError extends Error {
  constructor(message, code = 'SETTINGS_STORE_ERROR') {
    super(message);
    this.name = 'SettingsStoreError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeUpdatedAt(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function settingsError(code, message) {
  return new SettingsStoreError(message, code);
}

function readJsonEnvelope(filePath, { label, maxBytes, normalize }) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return {
      status: 'corrupt',
      error: { code: 'SETTINGS_READ_FAILED', message: `${label}读取失败` },
    };
  }

  if (!stat.isFile()) {
    return {
      status: 'corrupt',
      error: { code: 'SETTINGS_NOT_FILE', message: `${label}不是普通文件` },
    };
  }
  if (stat.size > maxBytes) {
    return {
      status: 'corrupt',
      error: { code: 'SETTINGS_FILE_TOO_LARGE', message: `${label}超过大小上限` },
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { status: 'valid', value: normalize(raw, { loading: true }) };
  } catch (error) {
    const code = error instanceof SettingsStoreError ? error.code : 'SETTINGS_JSON_CORRUPT';
    return {
      status: 'corrupt',
      error: { code, message: error instanceof SettingsStoreError ? error.message : `${label}文件已损坏` },
    };
  }
}

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Windows and some file systems do not support fsync on directories.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function writeFileAtomic(filePath, bytes, { mode = 0o600 } = {}) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, mode); } catch { /* best effort */ }
    fsyncDirectory(dirPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function writeJsonEnvelope(filePath, value, { label, maxBytes }) {
  const payload = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
    throw settingsError('SETTINGS_FILE_TOO_LARGE', `${label}超过大小上限`);
  }
  writeFileAtomic(filePath, payload, { mode: 0o600 });
  return value;
}

function bgImageError(code, message) {
  return settingsError(code, message);
}

function detectBgImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  const prefix = bytes.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

/** 先在同一文件句柄上 stat，再限量异步读取；文件变化或签名不符时失败关闭。 */
async function readValidatedBgImage(filePath, options = {}) {
  const declaredMimeType = String(options.declaredMimeType || '');
  const maxBytes = options.maxBytes ?? MAX_BG_IMAGE_BYTES;
  const openFile = options.openFile || ((target, flags) => fs.promises.open(target, flags));
  if (declaredMimeType && !ALLOWED_BG_IMAGE_TYPES.has(declaredMimeType)) {
    throw bgImageError('BG_IMAGE_TYPE_UNSUPPORTED', '仅支持 PNG、JPEG、WebP 或 GIF 图片');
  }

  let handle;
  try {
    handle = await openFile(path.resolve(filePath), 'r');
    const before = await handle.stat();
    if (!before.isFile()) throw bgImageError('BG_IMAGE_NOT_FILE', '选择的底图不是普通文件');
    if (before.size <= 0) throw bgImageError('BG_IMAGE_EMPTY', '图片文件为空');
    if (before.size > maxBytes) throw bgImageError('BG_IMAGE_TOO_LARGE', '图片不能超过 8MB');

    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) throw bgImageError('BG_IMAGE_READ_INCOMPLETE', '图片读取不完整，请重试');
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw bgImageError('BG_IMAGE_CHANGED', '图片在读取时发生变化，请重试');
    }

    const detected = detectBgImageType(bytes);
    if (!detected || !ALLOWED_BG_IMAGE_TYPES.has(detected.mimeType)) {
      throw bgImageError('BG_IMAGE_CONTENT_INVALID', '文件内容不是支持的图片格式');
    }
    if (declaredMimeType && declaredMimeType !== detected.mimeType) {
      throw bgImageError('BG_IMAGE_TYPE_MISMATCH', '图片类型与文件内容不一致');
    }
    return { bytes, ...detected };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function copyValidatedBgImage({ filePath, declaredMimeType, destinationDir }, options = {}) {
  if (!filePath || !destinationDir) throw bgImageError('BG_IMAGE_PATH_INVALID', '没有可读取的图片文件');
  const image = await readValidatedBgImage(filePath, { ...options, declaredMimeType });
  const hash = createHash('sha256').update(image.bytes).digest('hex').slice(0, 24);
  const destName = `${hash}.${image.extension}`;
  const destPath = path.join(destinationDir, destName);
  if (!fs.existsSync(destPath)) writeFileAtomic(destPath, image.bytes, { mode: 0o600 });
  return `dsh-skin-asset://${destName}`;
}

function normalizeCommonEnvelope(raw, label) {
  if (!isPlainObject(raw)) {
    throw settingsError('SETTINGS_SHAPE_INVALID', `${label}格式不正确`);
  }
  const schemaVersion = raw.schema_version;
  if (schemaVersion !== undefined && schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw settingsError('SETTINGS_SCHEMA_UNSUPPORTED', `${label}版本不受支持`);
  }
  if (schemaVersion === SETTINGS_SCHEMA_VERSION) {
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) {
      throw settingsError('SETTINGS_REVISION_INVALID', `${label}revision 不合法`);
    }
    if (!Number.isSafeInteger(raw.updated_at) || raw.updated_at < 0) {
      throw settingsError('SETTINGS_UPDATED_AT_INVALID', `${label}updated_at 不合法`);
    }
  }
  return {
    schema_version: schemaVersion === SETTINGS_SCHEMA_VERSION ? SETTINGS_SCHEMA_VERSION : 0,
    revision: normalizeRevision(raw.revision),
    updated_at: normalizeUpdatedAt(raw.updated_at),
  };
}

function normalizeSkinsSettings(raw) {
  const common = normalizeCommonEnvelope(raw, '主题设置');
  if (!Array.isArray(raw.userSkins)) {
    throw settingsError('SKINS_PAYLOAD_INVALID', 'userSkins 必须是数组');
  }
  if (raw.userSkins.length > MAX_USER_SKINS) {
    throw settingsError('SKINS_COUNT_EXCEEDED', `自定义主题不能超过 ${MAX_USER_SKINS} 个`);
  }
  const activeSkinId = typeof raw.activeSkinId === 'string' ? raw.activeSkinId.trim() : '';
  if (common.schema_version === SETTINGS_SCHEMA_VERSION && !activeSkinId) {
    throw settingsError('SKINS_ACTIVE_ID_INVALID', '当前皮肤 ID 不能为空');
  }
  if (activeSkinId && !isPersistableActiveSkinId(activeSkinId)) {
    throw settingsError('SKINS_ACTIVE_ID_INVALID', '当前皮肤 ID 不合法');
  }
  // Profile 主题消失时只回退到宿主安全底座，不建立另一份产品主题权威。
  const fallbackSkinId = 'lighting';
  return {
    ...common,
    userSkins: raw.userSkins,
    activeSkinId,
    fallbackSkinId,
  };
}

function normalizeBrandSettings(raw) {
  const common = normalizeCommonEnvelope(raw, '应用名设置');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length > 32) {
    throw settingsError('BRAND_NAME_TOO_LONG', '应用名称不能超过 32 个字符');
  }
  return { ...common, name };
}

function normalizeAppearanceSettings(raw) {
  const common = normalizeCommonEnvelope(raw, '品牌外观设置');
  if (!isPlainObject(raw.appearance)) {
    throw settingsError('APPEARANCE_PAYLOAD_INVALID', 'appearance 必须是对象');
  }
  return { ...common, appearance: raw.appearance };
}

function createSettingsStore({
  skinsPath,
  brandPath,
  appearancePath,
  defaultAppName,
}) {
  if (!skinsPath || !brandPath || !appearancePath) {
    throw new TypeError('skinsPath、brandPath、appearancePath 不能为空');
  }
  const fallbackName = String(defaultAppName || '').trim();

  return {
    loadSkins() {
      return readJsonEnvelope(skinsPath, {
        label: '主题设置',
        maxBytes: MAX_SKINS_FILE_BYTES,
        normalize: normalizeSkinsSettings,
      });
    },

    saveSkins(settings) {
      const normalized = normalizeSkinsSettings({
        ...settings,
        schema_version: SETTINGS_SCHEMA_VERSION,
      });
      return writeJsonEnvelope(skinsPath, normalized, {
        label: '主题设置',
        maxBytes: MAX_SKINS_FILE_BYTES,
      });
    },

    loadBrand() {
      const result = readJsonEnvelope(brandPath, {
        label: '应用名设置',
        maxBytes: MAX_BRAND_FILE_BYTES,
        normalize: normalizeBrandSettings,
      });
      if (result.status === 'valid') {
        result.value.name = result.value.name || fallbackName;
      }
      return result;
    },

    saveBrand(settings) {
      if (!isPlainObject(settings) || typeof settings.name !== 'string') {
        throw settingsError('BRAND_NAME_INVALID', '应用名称必须是字符串');
      }
      const normalized = normalizeBrandSettings({
        ...settings,
        name: settings.name.trim() || fallbackName,
        schema_version: SETTINGS_SCHEMA_VERSION,
      });
      return writeJsonEnvelope(brandPath, normalized, {
        label: '应用名设置',
        maxBytes: MAX_BRAND_FILE_BYTES,
      });
    },

    loadAppearance() {
      return readJsonEnvelope(appearancePath, {
        label: '品牌外观设置',
        maxBytes: MAX_APPEARANCE_FILE_BYTES,
        normalize: normalizeAppearanceSettings,
      });
    },

    saveAppearance(settings) {
      const normalized = normalizeAppearanceSettings({
        ...settings,
        schema_version: SETTINGS_SCHEMA_VERSION,
      });
      return writeJsonEnvelope(appearancePath, normalized, {
        label: '品牌外观设置',
        maxBytes: MAX_APPEARANCE_FILE_BYTES,
      });
    },
  };
}

function saveResult(operation) {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'SETTINGS_WRITE_FAILED',
        message: error instanceof SettingsStoreError ? error.message : '设置写入失败',
      },
    };
  }
}

module.exports = {
  SETTINGS_SCHEMA_VERSION,
  MAX_USER_SKINS,
  MAX_SKINS_FILE_BYTES,
  MAX_BRAND_FILE_BYTES,
  MAX_APPEARANCE_FILE_BYTES,
  MAX_BG_IMAGE_BYTES,
  SettingsStoreError,
  createSettingsStore,
  normalizeSkinsSettings,
  normalizeBrandSettings,
  normalizeAppearanceSettings,
  readJsonEnvelope,
  detectBgImageType,
  readValidatedBgImage,
  copyValidatedBgImage,
  saveResult,
  writeFileAtomic,
};
