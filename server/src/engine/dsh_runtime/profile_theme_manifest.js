import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PROFILE_THEME_SCHEMA_VERSION = 1;
export const MAX_PROFILE_THEME_RUNTIME_ID_LENGTH = 512;

const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_THEMES_PER_BUNDLE = 16;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._/@-]{1,320}$/;
const SAFE_HEX_COLOR_PATTERN = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const TOP_LEVEL_FIELDS = new Set(["schema_version", "themes"]);
const THEME_FIELDS = new Set([
  "id",
  "name",
  "description",
  "base",
  "vars",
  "mantineColors",
  "extraCss",
  "dark",
  "appearance",
]);
const SCHEME_FIELDS = new Set(["vars", "mantineColors", "extraCss"]);
const APPEARANCE_FIELDS = new Set([
  "appName",
  "bgColor",
  "bgImage",
  "bgImageSize",
  "bgOpacity",
  "panelOpacity",
  "dark",
]);
const APPEARANCE_DARK_FIELDS = new Set(["bgColor", "bgImage", "bgImageSize", "bgOpacity", "panelOpacity"]);
const BG_IMAGE_SIZE_VALUES = new Set(["cover", "contain", "center"]);
const BUILTIN_THEME_IDS = new Set(["lighting"]);
const ALLOWED_COLOR_VARIABLES = new Set(["--el-color-primary"]);
const ALLOWED_BG_PRESETS = new Set([
  "none",
  "aurora",
  "dawn",
  "deep-sea",
  "forest",
  "twilight",
  "mint",
  "graphite",
  "peach",
  "galaxy",
]);

function themeError(message, code = "DSH_PROFILE_THEME_INVALID", details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function inside(rootPath, candidatePath) {
  const path = relative(rootPath, candidatePath);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizeHexColor(value, field) {
  if (typeof value !== "string" || !SAFE_HEX_COLOR_PATTERN.test(value.trim())) {
    throw themeError(`${field} 必须是 #RGB 或 #RRGGBB 十六进制颜色`, "DSH_PROFILE_THEME_COLOR_INVALID");
  }
  const body = value.trim().slice(1).toLowerCase();
  return body.length === 3
    ? `#${body.split("").map((part) => part + part).join("")}`
    : `#${body}`;
}

function asString(value, field, max) {
  if (typeof value !== "string" || !value.trim()) {
    throw themeError(`${field} 必须是非空字符串`);
  }
  const normalized = value.trim();
  if (normalized.length > max || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw themeError(`${field} 含不允许的字符或超过 ${max} 个字符`);
  }
  return normalized;
}

function rejectUnknownFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw themeError(`${field}.${key} 不是支持的字段`);
  }
}

function asVars(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw themeError(`${field} 必须是对象`);
  }
  const out = {};
  for (const [key, color] of Object.entries(value)) {
    if (!ALLOWED_COLOR_VARIABLES.has(key)) {
      throw themeError(`${field} 不允许修改颜色变量 "${key}"`, "DSH_PROFILE_THEME_VAR_NOT_ALLOWED");
    }
    out[key] = normalizeHexColor(color, `${field}["${key}"]`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asMantineColors(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 10) {
    throw themeError(`${field} 必须是 10 个颜色值`, "DSH_PROFILE_THEME_COLORS_INVALID");
  }
  return value.map((color, index) => normalizeHexColor(color, `${field}[${index}]`));
}

function rejectRawCss(value, field) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") throw themeError(`${field} 必须是字符串`);
  if (value.trim()) {
    throw themeError(`${field} 不允许包含原始 CSS`, "DSH_PROFILE_THEME_RAW_CSS_FORBIDDEN");
  }
}

function asColorPair(rawVars, rawColors, field) {
  let vars = asVars(rawVars, `${field}.vars`);
  const mantineColors = asMantineColors(rawColors, `${field}.mantineColors`);
  const primary = vars?.["--el-color-primary"];
  if (primary && !mantineColors) {
    throw themeError(`${field} 修改主色时必须同时提供 Mantine 十阶色板`, "DSH_PROFILE_THEME_PRIMARY_COLORS_REQUIRED");
  }
  if (primary && mantineColors && primary !== mantineColors[6]) {
    throw themeError(`${field}.mantineColors[6] 必须与主色相同`, "DSH_PROFILE_THEME_PRIMARY_COLOR_MISMATCH");
  }
  if (!primary && mantineColors) vars = { "--el-color-primary": mantineColors[6] };
  return { vars, mantineColors };
}

function asScheme(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw themeError(`${field} 必须是对象`);
  rejectUnknownFields(value, SCHEME_FIELDS, field);
  rejectRawCss(value.extraCss, `${field}.extraCss`);
  const pair = asColorPair(value.vars, value.mantineColors, field);
  if (!pair.vars && !pair.mantineColors) return undefined;
  return pair;
}

function asPercent(value, field, minimum = 0) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > 100) {
    throw themeError(`${field} 必须是 ${minimum}-100 之间的数字`);
  }
  return value;
}

function asBgImage(value, field) {
  if (value === undefined || value === null) return undefined;
  const image = asString(value, field, 64);
  if (!ALLOWED_BG_PRESETS.has(image)) {
    throw themeError(`${field} 只能使用 dsh-work 内置背景预设`, "DSH_PROFILE_THEME_BG_IMAGE_FORBIDDEN");
  }
  return image;
}

function asBgImageSize(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!BG_IMAGE_SIZE_VALUES.has(value)) throw themeError(`${field} 必须是 cover、contain 或 center`);
  return value;
}

function asAppearance(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw themeError(`${field} 必须是对象`);
  rejectUnknownFields(value, APPEARANCE_FIELDS, field);
  if (Object.hasOwn(value, "appName")) {
    throw themeError(`${field}.appName 不允许由 Profile Bundle 设置`, "DSH_PROFILE_THEME_APP_NAME_FORBIDDEN");
  }
  const out = {};
  if (value.bgColor !== undefined && value.bgColor !== null) out.bgColor = normalizeHexColor(value.bgColor, `${field}.bgColor`);
  const bgImage = asBgImage(value.bgImage, `${field}.bgImage`);
  if (bgImage) out.bgImage = bgImage;
  const bgImageSize = asBgImageSize(value.bgImageSize, `${field}.bgImageSize`);
  if (bgImageSize) out.bgImageSize = bgImageSize;
  const bgOpacity = asPercent(value.bgOpacity, `${field}.bgOpacity`);
  if (bgOpacity !== undefined) out.bgOpacity = bgOpacity;
  const panelOpacity = asPercent(value.panelOpacity, `${field}.panelOpacity`, 60);
  if (panelOpacity !== undefined) out.panelOpacity = panelOpacity;
  if (value.dark !== undefined && value.dark !== null) {
    if (!value.dark || typeof value.dark !== "object" || Array.isArray(value.dark)) {
      throw themeError(`${field}.dark 必须是对象`);
    }
    rejectUnknownFields(value.dark, APPEARANCE_DARK_FIELDS, `${field}.dark`);
    const dark = {};
    if (value.dark.bgColor !== undefined && value.dark.bgColor !== null) {
      dark.bgColor = normalizeHexColor(value.dark.bgColor, `${field}.dark.bgColor`);
    }
    const darkImage = asBgImage(value.dark.bgImage, `${field}.dark.bgImage`);
    if (darkImage) dark.bgImage = darkImage;
    const darkImageSize = asBgImageSize(value.dark.bgImageSize, `${field}.dark.bgImageSize`);
    if (darkImageSize) dark.bgImageSize = darkImageSize;
    const darkBgOpacity = asPercent(value.dark.bgOpacity, `${field}.dark.bgOpacity`);
    if (darkBgOpacity !== undefined) dark.bgOpacity = darkBgOpacity;
    const darkPanelOpacity = asPercent(value.dark.panelOpacity, `${field}.dark.panelOpacity`, 60);
    if (darkPanelOpacity !== undefined) dark.panelOpacity = darkPanelOpacity;
    if (Object.keys(dark).length > 0) out.dark = dark;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTheme(value, index, ids) {
  const field = `themes[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw themeError(`${field} 必须是对象`);
  rejectUnknownFields(value, THEME_FIELDS, field);
  const id = asString(value.id, `${field}.id`, 64);
  if (!ID_PATTERN.test(id)) throw themeError(`${field}.id 格式不合法`, "DSH_PROFILE_THEME_ID_INVALID");
  if (BUILTIN_THEME_IDS.has(id) || ids.has(id)) {
    throw themeError(`${field}.id 与内置主题或同一 Bundle 的主题冲突`, "DSH_PROFILE_THEME_ID_CONFLICT");
  }
  ids.add(id);
  const name = asString(value.name, `${field}.name`, 64);
  const description = value.description === undefined || value.description === null
    ? undefined
    : asString(value.description, `${field}.description`, 512);
  const base = value.base === undefined || value.base === null
    ? "lighting"
    : asString(value.base, `${field}.base`, 64);
  if (!BUILTIN_THEME_IDS.has(base)) throw themeError(`${field}.base 必须是内置主题 id`);
  rejectRawCss(value.extraCss, `${field}.extraCss`);
  const pair = asColorPair(value.vars, value.mantineColors, field);
  const dark = asScheme(value.dark, `${field}.dark`);
  const appearance = asAppearance(value.appearance, `${field}.appearance`);
  if (!pair.vars && !pair.mantineColors && !dark && !appearance) {
    throw themeError(`${field} 至少需要颜色、暗色或外观配置`, "DSH_PROFILE_THEME_EMPTY");
  }
  return {
    manifest_id: id,
    name,
    builtIn: false,
    source: "profile",
    ...(description ? { description } : {}),
    base,
    ...(pair.vars ? { vars: pair.vars } : {}),
    ...(pair.mantineColors ? { mantineColors: pair.mantineColors } : {}),
    ...(dark ? { dark } : {}),
    ...(appearance ? { appearance } : {}),
  };
}

/** Validate a dsh-work theme descriptor after its JSON boundary. */
export function normalizeProfileThemeDescriptor(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw themeError("主题描述必须是 JSON 对象");
  rejectUnknownFields(raw, TOP_LEVEL_FIELDS, "主题描述");
  if (raw.schema_version !== PROFILE_THEME_SCHEMA_VERSION) {
    throw themeError(`主题描述 schema_version 必须为 ${PROFILE_THEME_SCHEMA_VERSION}`, "DSH_PROFILE_THEME_SCHEMA_VERSION");
  }
  if (!Array.isArray(raw.themes) || raw.themes.length === 0 || raw.themes.length > MAX_THEMES_PER_BUNDLE) {
    throw themeError(`主题描述 themes 必须包含 1-${MAX_THEMES_PER_BUNDLE} 个主题`);
  }
  const ids = new Set();
  return raw.themes.map((theme, index) => normalizeTheme(theme, index, ids));
}

/** Read the explicit package.json#dshWork.themes descriptor from one Profile Bundle. */
export function readProfileThemeDescriptor(packageDir, manifest) {
  const declared = manifest?.dshWork?.themes;
  if (declared === undefined) return { manifest_path: null, themes: [] };
  if (typeof declared !== "string" || !declared.startsWith("./")) {
    throw themeError(`${manifest?.name || "Profile Bundle"} 的 dshWork.themes 必须是包内相对路径`);
  }
  let realRoot;
  let descriptorPath;
  try {
    realRoot = realpathSync(packageDir);
    const declaredPath = resolve(packageDir, declared);
    if (!inside(realRoot, declaredPath)) {
      throw themeError(`${manifest?.name || "Profile Bundle"} 的主题描述不能越过包目录`, "DSH_PROFILE_THEME_PATH_OUTSIDE_ROOT");
    }
    descriptorPath = realpathSync(declaredPath);
  } catch (error) {
    if (error?.code === "DSH_PROFILE_THEME_PATH_OUTSIDE_ROOT") throw error;
    throw themeError(`${manifest?.name || "Profile Bundle"} 的主题描述无法读取：${error?.message || error}`);
  }
  if (!inside(realRoot, descriptorPath)) {
    throw themeError(`${manifest?.name || "Profile Bundle"} 的主题描述不能越过包目录`, "DSH_PROFILE_THEME_PATH_OUTSIDE_ROOT");
  }
  const info = statSync(descriptorPath);
  if (!info.isFile() || info.size > MAX_DESCRIPTOR_BYTES) {
    throw themeError(`${manifest?.name || "Profile Bundle"} 的主题描述必须是小于 256KB 的普通文件`);
  }
  const text = readFileSync(descriptorPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw themeError(`${manifest?.name || "Profile Bundle"} 的主题描述超过 256KB`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw themeError(`${manifest?.name || "Profile Bundle"} 的主题描述 JSON 无效：${error?.message || error}`);
  }
  return { manifest_path: declared, themes: normalizeProfileThemeDescriptor(raw) };
}

/** Build the stable dsh-work renderer id for one Profile-owned theme. */
export function profileThemeRuntimeId(packageName, manifestId) {
  const source = String(packageName || "").trim();
  const declared = String(manifestId || "").trim();
  if (!BUNDLE_ID_PATTERN.test(source) || !ID_PATTERN.test(declared)) return "";
  const runtimeId = `profile:${encodeURIComponent(source)}:${declared}`;
  return runtimeId.length <= MAX_PROFILE_THEME_RUNTIME_ID_LENGTH ? runtimeId : "";
}

/** Merge theme descriptors in Profile order and attach Bundle provenance for the renderer trust boundary. */
export function aggregateProfileThemes(bundles, descriptorErrors = []) {
  const themes = [];
  const errors = [...descriptorErrors];
  const ids = new Set();
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    const packageName = String(bundle?.package_name || "").trim();
    const sourceBundle = Object.freeze({
      package_name: packageName,
      name: String(bundle?.display_name || packageName).trim(),
      version: typeof bundle?.version === "string" ? bundle.version : null,
      manifest_path: String(bundle?.manifest_path || "").trim(),
    });
    for (const theme of Array.isArray(bundle?.themes) ? bundle.themes : []) {
      const id = profileThemeRuntimeId(packageName, theme?.manifest_id);
      if (!id || ids.has(id)) {
        errors.push(Object.freeze({
          code: id ? "DSH_PROFILE_THEME_ID_CONFLICT" : "DSH_PROFILE_THEME_RUNTIME_ID_INVALID",
          theme_id: id || null,
          manifest_id: theme?.manifest_id || null,
          message: id ? `Profile 主题 id 冲突，已停用：${id}` : `Profile 主题缺少有效的 Bundle 来源：${theme?.manifest_id || "unknown"}`,
          source_bundle: sourceBundle,
        }));
        continue;
      }
      ids.add(id);
      themes.push(Object.freeze({ ...theme, id, source_bundle: sourceBundle }));
    }
  }
  return Object.freeze({
    profile_themes: Object.freeze(themes),
    profile_theme_errors: Object.freeze(errors),
  });
}
