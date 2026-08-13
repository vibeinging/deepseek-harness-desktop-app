import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const GENERATIVE_UI_SCHEMA_VERSION = 1;

export const GENERATIVE_UI_LIMITS = Object.freeze({
  maxBytes: 128 * 1024,
  maxNodes: 128,
  maxDepth: 8,
  maxChildren: 32,
  maxStringLength: 4_000,
  maxMarkdownLength: 20_000,
  maxVisibleTextLength: 40_000,
  maxTables: 4,
  maxTableColumns: 24,
  maxTableRows: 200,
  maxCharts: 4,
  maxChartRows: 200,
  maxChartSeries: 8,
  maxForms: 4,
  maxFormFields: 24,
  maxSelectOptions: 50,
  maxInputLength: 2_000,
});

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-zA-Z0-9+/=]+$/;
const SAFE_LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const BLOCKED_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const C0_CONTROL = /[\u0000-\u001f\u007f]/;
const C0_CONTROL_EXCEPT_TEXT_FORMATTING = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const NODE_KEYS = Object.freeze({
  stack: ["id", "type", "gap", "align", "children"],
  grid: ["id", "type", "columns", "gap", "children"],
  section: ["id", "type", "title", "description", "children"],
  text: ["id", "type", "text", "tone", "size", "weight"],
  markdown: ["id", "type", "content"],
  metric: ["id", "type", "label", "value", "delta", "trend", "tone"],
  alert: ["id", "type", "tone", "title", "message"],
  state: ["id", "type", "state", "title", "message"],
  divider: ["id", "type"],
  table: ["id", "type", "caption", "columns", "rows"],
  chart: ["id", "type", "chart_type", "title", "data", "x_key", "series"],
  image: ["id", "type", "src", "alt", "caption"],
  button: ["id", "type", "action_id", "label", "variant"],
  form: ["id", "type", "action_id", "submit_label", "children"],
  text_input: ["id", "type", "name", "label", "placeholder", "required", "default_value"],
  select: ["id", "type", "name", "label", "required", "default_value", "options"],
  checkbox: ["id", "type", "name", "label", "default_checked"],
});

const GAP_VALUES = new Set(["xs", "sm", "md", "lg"]);
const ALIGN_VALUES = new Set(["stretch", "start", "center", "end"]);
const TEXT_TONES = new Set(["default", "muted", "success", "warning", "danger"]);
const DATA_TONES = new Set(["default", "success", "warning", "danger"]);
const ALERT_TONES = new Set(["info", "success", "warning", "danger"]);
const TEXT_SIZES = new Set(["sm", "md", "lg"]);
const TEXT_WEIGHTS = new Set(["regular", "medium", "semibold"]);
const TRENDS = new Set(["up", "down", "flat"]);
const STATES = new Set(["loading", "empty", "error"]);
const COLUMN_ALIGNS = new Set(["left", "center", "right"]);
const CHART_TYPES = new Set(["bar", "horizontal_bar", "line", "area", "pie", "scatter"]);
const BUTTON_VARIANTS = new Set(["primary", "secondary", "quiet"]);
const FORM_FIELD_TYPES = new Set(["text_input", "select", "checkbox"]);
const GENERATIVE_UI_HOST_RESULT = Symbol("generative-ui-host-result");

export class GenerativeUiValidationError extends Error {
  constructor(message, { code = "GENERATIVE_UI_SCHEMA_INVALID", path = "$" } = {}) {
    super(message);
    this.name = "GenerativeUiValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(path, message, code = "GENERATIVE_UI_SCHEMA_INVALID") {
  throw new GenerativeUiValidationError(message, { code, path });
}

function codePointLength(value) {
  return Array.from(String(value || "")).length;
}

function objectValue(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain JSON object");
  const blocked = Object.keys(value).find((key) => BLOCKED_RECORD_KEYS.has(key));
  if (blocked) fail(`${path}.${blocked}`, `unsafe field name: ${blocked}`);
  return value;
}

function allowedKeys(value, allowed, path) {
  const names = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !names.has(key));
  if (unknown) fail(`${path}.${unknown}`, `unknown field: ${unknown}`);
}

function required(value, key, path) {
  if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  return value[key];
}

function visibleText(state, value, path) {
  state.visibleTextLength += codePointLength(value);
  if (state.visibleTextLength > GENERATIVE_UI_LIMITS.maxVisibleTextLength) {
    fail(path, `visible text exceeds ${GENERATIVE_UI_LIMITS.maxVisibleTextLength} characters`, "GENERATIVE_UI_RESOURCE_LIMIT");
  }
}

function stringValue(state, value, path, {
  max = GENERATIVE_UI_LIMITS.maxStringLength,
  min = 1,
  trim = true,
  visible = true,
  allowTextFormattingControls = false,
} = {}) {
  if (typeof value !== "string") fail(path, "must be a string");
  const normalized = trim ? value.trim() : value;
  const length = codePointLength(normalized);
  const meaningfulLength = trim ? length : codePointLength(normalized.trim());
  if (meaningfulLength < min || length > max) fail(path, `must contain between ${min} and ${max} characters`);
  if (visible) {
    const invalidControl = allowTextFormattingControls
      ? C0_CONTROL_EXCEPT_TEXT_FORMATTING.test(normalized)
      : C0_CONTROL.test(normalized);
    if (invalidControl || BIDI_CONTROL.test(normalized)) fail(path, "contains unsupported control characters");
  }
  if (visible) visibleText(state, normalized, path);
  return normalized;
}

function optionalString(state, value, path, options = {}) {
  return value === undefined ? undefined : stringValue(state, value, path, options);
}

function safeIdValue(state, value, path) {
  const normalized = stringValue(state, value, path, { max: 64, visible: false });
  if (!SAFE_ID.test(normalized)) fail(path, "must use only letters, numbers, dot, underscore, or hyphen and start with a letter or number");
  return normalized;
}

function actionIdValue(state, value, path) {
  const actionId = safeIdValue(state, value, path);
  if (state.actionIds.has(actionId)) fail(path, `duplicate action id: ${actionId}`);
  state.actionIds.add(actionId);
  return actionId;
}

function enumValue(value, allowed, path) {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(path, `must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

function optionalEnum(value, allowed, path) {
  return value === undefined ? undefined : enumValue(value, allowed, path);
}

function booleanValue(value, path) {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function integerValue(value, path, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function arrayValue(value, path, { min = 0, max }) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < min || value.length > max) fail(path, `must contain between ${min} and ${max} items`);
  return value;
}

function recordKey(state, value, path) {
  const key = stringValue(state, value, path, { max: 64, visible: false });
  if (!SAFE_ID.test(key) || BLOCKED_RECORD_KEYS.has(key)) fail(path, "must be a safe record key");
  return key;
}

function isInsideRoot(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isAbsoluteLocalPath(value) {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function decodedHostFilePath(src, path) {
  let url;
  try { url = new URL(src); } catch { fail(path, "must be a valid host resource URL", "GENERATIVE_UI_UNSAFE_RESOURCE"); }
  if (url.protocol !== "dsh-file:" || url.hostname !== "local") {
    fail(path, "must use an dsh-file://local resource", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    fail(path, "contains unsupported host resource URL fields", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  const encoded = url.pathname.replace(/^\/+/, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) fail(path, "contains an invalid host resource path", "GENERATIVE_UI_UNSAFE_RESOURCE");
  let decoded = "";
  try { decoded = Buffer.from(encoded, "base64url").toString("utf8"); } catch { /* handled below */ }
  if (!decoded || Buffer.from(decoded, "utf8").toString("base64url") !== encoded || !isAbsoluteLocalPath(decoded)) {
    fail(path, "contains an invalid local image path", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  return decoded;
}

function localImagePath(src, path) {
  if (src.startsWith("dsh-file://")) return decodedHostFilePath(src, path);
  if (src.startsWith("file://")) {
    fail(path, "file URLs are not allowed", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  if (isAbsoluteLocalPath(src)) return src;
  return null;
}

function safeImageSource(state, value, path) {
  const src = stringValue(state, value, path, { visible: false });
  if (C0_CONTROL.test(src) || BIDI_CONTROL.test(src)) {
    fail(path, "contains unsupported URL control characters", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  if (SAFE_DATA_IMAGE.test(src)) return src;
  if (src.toLowerCase().startsWith("data:")) {
    fail(path, "only base64 raster data:image URLs are allowed", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  if (/^https?:/i.test(src)) {
    let url;
    try { url = new URL(src); } catch { fail(path, "must be a valid HTTP(S) URL", "GENERATIVE_UI_UNSAFE_RESOURCE"); }
    if (url.protocol !== "https:" || url.username || url.password) {
      fail(path, "must be an HTTPS URL without embedded credentials", "GENERATIVE_UI_UNSAFE_RESOURCE");
    }
    return url.toString();
  }
  const local = localImagePath(src, path);
  if (!local) fail(path, "uses an unsupported image URL", "GENERATIVE_UI_UNSAFE_RESOURCE");
  const resolved = resolve(local);
  if (!SAFE_LOCAL_IMAGE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    fail(path, "local image must use a supported raster extension", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  if (!state.allowedLocalRoots.length) {
    fail(path, "local images require an allowed workspace root", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  let real;
  try { real = realpathSync(resolved); } catch {
    fail(path, "local image does not exist", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  if (!state.allowedLocalRoots.some((root) => isInsideRoot(root, real))) {
    fail(path, "local image is outside the allowed workspace roots", "GENERATIVE_UI_UNSAFE_RESOURCE");
  }
  const encoded = Buffer.from(real, "utf8").toString("base64url");
  return `dsh-file://local/${encoded}`;
}

function scalarCell(state, value, path, { allowBoolean = true } = {}) {
  if (value === null) return null;
  if (typeof value === "string") return stringValue(state, value, path, { trim: false });
  if (typeof value === "number") {
    const number = finiteNumber(value, path);
    visibleText(state, String(number), path);
    return number;
  }
  if (allowBoolean && typeof value === "boolean") {
    visibleText(state, String(value), path);
    return value;
  }
  fail(path, allowBoolean ? "must be a string, number, boolean, or null" : "must be a string, number, or null");
}

function childNodes(state, value, path, depth) {
  return arrayValue(value, path, { max: GENERATIVE_UI_LIMITS.maxChildren })
    .map((child, index) => nodeValue(state, child, `${path}[${index}]`, depth));
}

function nodeValue(state, input, path, depth, { formField = false } = {}) {
  if (depth > GENERATIVE_UI_LIMITS.maxDepth) {
    fail(path, `tree depth exceeds ${GENERATIVE_UI_LIMITS.maxDepth}`, "GENERATIVE_UI_RESOURCE_LIMIT");
  }
  state.nodeCount += 1;
  if (state.nodeCount > GENERATIVE_UI_LIMITS.maxNodes) {
    fail(path, `node count exceeds ${GENERATIVE_UI_LIMITS.maxNodes}`, "GENERATIVE_UI_RESOURCE_LIMIT");
  }
  const value = objectValue(input, path);
  const type = required(value, "type", path);
  if (typeof type !== "string" || !Object.hasOwn(NODE_KEYS, type)) fail(`${path}.type`, `unknown node type: ${String(type || "")}`);
  if (FORM_FIELD_TYPES.has(type) && !formField) fail(`${path}.type`, `${type} is only allowed directly inside a form`);
  allowedKeys(value, NODE_KEYS[type], path);
  const id = safeIdValue(state, required(value, "id", path), `${path}.id`);
  if (state.nodeIds.has(id)) fail(`${path}.id`, `duplicate node id: ${id}`);
  state.nodeIds.add(id);
  const base = { id, type };

  if (type === "stack") {
    const gap = optionalEnum(value.gap, GAP_VALUES, `${path}.gap`);
    const align = optionalEnum(value.align, ALIGN_VALUES, `${path}.align`);
    return { ...base, ...(gap ? { gap } : {}), ...(align ? { align } : {}), children: childNodes(state, required(value, "children", path), `${path}.children`, depth + 1) };
  }
  if (type === "grid") {
    const columns = value.columns === undefined ? undefined : integerValue(value.columns, `${path}.columns`, { min: 1, max: 4 });
    const gap = optionalEnum(value.gap, GAP_VALUES, `${path}.gap`);
    return { ...base, ...(columns ? { columns } : {}), ...(gap ? { gap } : {}), children: childNodes(state, required(value, "children", path), `${path}.children`, depth + 1) };
  }
  if (type === "section") {
    const title = stringValue(state, required(value, "title", path), `${path}.title`);
    const description = optionalString(state, value.description, `${path}.description`);
    return { ...base, title, ...(description === undefined ? {} : { description }), children: childNodes(state, required(value, "children", path), `${path}.children`, depth + 1) };
  }
  if (type === "text") {
    const text = stringValue(state, required(value, "text", path), `${path}.text`, { trim: false, allowTextFormattingControls: true });
    const tone = optionalEnum(value.tone, TEXT_TONES, `${path}.tone`);
    const size = optionalEnum(value.size, TEXT_SIZES, `${path}.size`);
    const weight = optionalEnum(value.weight, TEXT_WEIGHTS, `${path}.weight`);
    return { ...base, text, ...(tone ? { tone } : {}), ...(size ? { size } : {}), ...(weight ? { weight } : {}) };
  }
  if (type === "markdown") {
    const content = stringValue(state, required(value, "content", path), `${path}.content`, { max: GENERATIVE_UI_LIMITS.maxMarkdownLength, trim: false, allowTextFormattingControls: true });
    return { ...base, content };
  }
  if (type === "metric") {
    const label = stringValue(state, required(value, "label", path), `${path}.label`);
    const rawMetric = required(value, "value", path);
    const metricValue = typeof rawMetric === "number"
      ? finiteNumber(rawMetric, `${path}.value`)
      : stringValue(state, rawMetric, `${path}.value`, { trim: false });
    if (typeof metricValue === "number") visibleText(state, String(metricValue), `${path}.value`);
    const delta = optionalString(state, value.delta, `${path}.delta`);
    const trend = optionalEnum(value.trend, TRENDS, `${path}.trend`);
    const tone = optionalEnum(value.tone, DATA_TONES, `${path}.tone`);
    return { ...base, label, value: metricValue, ...(delta === undefined ? {} : { delta }), ...(trend ? { trend } : {}), ...(tone ? { tone } : {}) };
  }
  if (type === "alert") {
    const tone = enumValue(required(value, "tone", path), ALERT_TONES, `${path}.tone`);
    const title = optionalString(state, value.title, `${path}.title`);
    const message = stringValue(state, required(value, "message", path), `${path}.message`, { trim: false });
    return { ...base, tone, ...(title === undefined ? {} : { title }), message };
  }
  if (type === "state") {
    const currentState = enumValue(required(value, "state", path), STATES, `${path}.state`);
    const title = stringValue(state, required(value, "title", path), `${path}.title`);
    const message = optionalString(state, value.message, `${path}.message`, { trim: false });
    return { ...base, state: currentState, title, ...(message === undefined ? {} : { message }) };
  }
  if (type === "divider") return base;
  if (type === "table") return tableNode(state, value, path, base);
  if (type === "chart") return chartNode(state, value, path, base);
  if (type === "image") {
    const src = safeImageSource(state, required(value, "src", path), `${path}.src`);
    const alt = stringValue(state, required(value, "alt", path), `${path}.alt`);
    const caption = optionalString(state, value.caption, `${path}.caption`);
    return { ...base, src, alt, ...(caption === undefined ? {} : { caption }) };
  }
  if (type === "button") {
    const actionId = actionIdValue(state, required(value, "action_id", path), `${path}.action_id`);
    const label = stringValue(state, required(value, "label", path), `${path}.label`);
    const variant = optionalEnum(value.variant, BUTTON_VARIANTS, `${path}.variant`);
    return { ...base, action_id: actionId, label, ...(variant ? { variant } : {}) };
  }
  if (type === "form") return formNode(state, value, path, base, depth);
  return formFieldNode(state, value, path, base);
}

function tableNode(state, value, path, base) {
  state.tableCount += 1;
  if (state.tableCount > GENERATIVE_UI_LIMITS.maxTables) fail(path, `table count exceeds ${GENERATIVE_UI_LIMITS.maxTables}`, "GENERATIVE_UI_RESOURCE_LIMIT");
  const caption = optionalString(state, value.caption, `${path}.caption`);
  const columnKeys = new Set();
  const columns = arrayValue(required(value, "columns", path), `${path}.columns`, { min: 1, max: GENERATIVE_UI_LIMITS.maxTableColumns }).map((input, index) => {
    const columnPath = `${path}.columns[${index}]`;
    const column = objectValue(input, columnPath);
    allowedKeys(column, ["key", "label", "align"], columnPath);
    const key = recordKey(state, required(column, "key", columnPath), `${columnPath}.key`);
    if (columnKeys.has(key)) fail(`${columnPath}.key`, `duplicate table column key: ${key}`);
    columnKeys.add(key);
    const label = stringValue(state, required(column, "label", columnPath), `${columnPath}.label`);
    const align = optionalEnum(column.align, COLUMN_ALIGNS, `${columnPath}.align`);
    return { key, label, ...(align ? { align } : {}) };
  });
  const rows = arrayValue(required(value, "rows", path), `${path}.rows`, { max: GENERATIVE_UI_LIMITS.maxTableRows }).map((input, rowIndex) => {
    const rowPath = `${path}.rows[${rowIndex}]`;
    const row = objectValue(input, rowPath);
    const output = {};
    for (const [rawKey, cell] of Object.entries(row)) {
      const key = recordKey(state, rawKey, `${rowPath}.${rawKey}`);
      if (!columnKeys.has(key)) fail(`${rowPath}.${key}`, `row key is not declared in columns: ${key}`);
      output[key] = scalarCell(state, cell, `${rowPath}.${key}`);
    }
    return output;
  });
  return { ...base, ...(caption === undefined ? {} : { caption }), columns, rows };
}

function chartNode(state, value, path, base) {
  state.chartCount += 1;
  if (state.chartCount > GENERATIVE_UI_LIMITS.maxCharts) fail(path, `chart count exceeds ${GENERATIVE_UI_LIMITS.maxCharts}`, "GENERATIVE_UI_RESOURCE_LIMIT");
  const chartType = enumValue(required(value, "chart_type", path), CHART_TYPES, `${path}.chart_type`);
  const title = optionalString(state, value.title, `${path}.title`);
  const xKey = recordKey(state, required(value, "x_key", path), `${path}.x_key`);
  const seriesKeys = new Set();
  const series = arrayValue(required(value, "series", path), `${path}.series`, { min: 1, max: GENERATIVE_UI_LIMITS.maxChartSeries }).map((input, index) => {
    const seriesPath = `${path}.series[${index}]`;
    const item = objectValue(input, seriesPath);
    allowedKeys(item, ["key", "label"], seriesPath);
    const key = recordKey(state, required(item, "key", seriesPath), `${seriesPath}.key`);
    if (key === xKey || seriesKeys.has(key)) fail(`${seriesPath}.key`, `duplicate chart key: ${key}`);
    seriesKeys.add(key);
    return { key, label: stringValue(state, required(item, "label", seriesPath), `${seriesPath}.label`) };
  });
  const allowedDataKeys = new Set([xKey, ...seriesKeys]);
  const data = arrayValue(required(value, "data", path), `${path}.data`, { min: 1, max: GENERATIVE_UI_LIMITS.maxChartRows }).map((input, rowIndex) => {
    const rowPath = `${path}.data[${rowIndex}]`;
    const row = objectValue(input, rowPath);
    const output = {};
    for (const [rawKey, cell] of Object.entries(row)) {
      const key = recordKey(state, rawKey, `${rowPath}.${rawKey}`);
      if (!allowedDataKeys.has(key)) fail(`${rowPath}.${key}`, `chart data key is not declared: ${key}`);
      if (key === xKey) {
        output[key] = scalarCell(state, cell, `${rowPath}.${key}`, { allowBoolean: false });
      } else {
        const number = finiteNumber(cell, `${rowPath}.${key}`);
        visibleText(state, String(number), `${rowPath}.${key}`);
        output[key] = number;
      }
    }
    for (const key of allowedDataKeys) {
      if (!Object.hasOwn(output, key)) fail(`${rowPath}.${key}`, "is required by the chart definition");
    }
    return output;
  });
  return { ...base, chart_type: chartType, ...(title === undefined ? {} : { title }), data, x_key: xKey, series };
}

function formNode(state, value, path, base, depth) {
  state.formCount += 1;
  if (state.formCount > GENERATIVE_UI_LIMITS.maxForms) fail(path, `form count exceeds ${GENERATIVE_UI_LIMITS.maxForms}`, "GENERATIVE_UI_RESOURCE_LIMIT");
  const actionId = actionIdValue(state, required(value, "action_id", path), `${path}.action_id`);
  const submitLabel = stringValue(state, required(value, "submit_label", path), `${path}.submit_label`);
  const fieldNames = new Set();
  const children = arrayValue(required(value, "children", path), `${path}.children`, { min: 1, max: GENERATIVE_UI_LIMITS.maxFormFields }).map((input, index) => {
    const childPath = `${path}.children[${index}]`;
    const child = objectValue(input, childPath);
    if (!FORM_FIELD_TYPES.has(child.type)) fail(`${childPath}.type`, "form children must be text_input, select, or checkbox");
    const normalized = nodeValue(state, child, childPath, depth + 1, { formField: true });
    if (fieldNames.has(normalized.name)) fail(`${childPath}.name`, `duplicate form field name: ${normalized.name}`);
    fieldNames.add(normalized.name);
    return normalized;
  });
  return { ...base, action_id: actionId, submit_label: submitLabel, children };
}

function formFieldNode(state, value, path, base) {
  const name = safeIdValue(state, required(value, "name", path), `${path}.name`);
  const label = stringValue(state, required(value, "label", path), `${path}.label`);
  if (base.type === "checkbox") {
    const defaultChecked = value.default_checked === undefined ? undefined : booleanValue(value.default_checked, `${path}.default_checked`);
    return { ...base, name, label, ...(defaultChecked === undefined ? {} : { default_checked: defaultChecked }) };
  }
  const requiredField = value.required === undefined ? undefined : booleanValue(value.required, `${path}.required`);
  if (base.type === "text_input") {
    const placeholder = optionalString(state, value.placeholder, `${path}.placeholder`);
    const defaultValue = optionalString(state, value.default_value, `${path}.default_value`, { max: GENERATIVE_UI_LIMITS.maxInputLength, trim: false, min: 0 });
    return { ...base, name, label, ...(placeholder === undefined ? {} : { placeholder }), ...(requiredField === undefined ? {} : { required: requiredField }), ...(defaultValue === undefined ? {} : { default_value: defaultValue }) };
  }
  const optionValues = new Set();
  const options = arrayValue(required(value, "options", path), `${path}.options`, { min: 1, max: GENERATIVE_UI_LIMITS.maxSelectOptions }).map((input, index) => {
    const optionPath = `${path}.options[${index}]`;
    const option = objectValue(input, optionPath);
    allowedKeys(option, ["label", "value"], optionPath);
    const optionLabel = stringValue(state, required(option, "label", optionPath), `${optionPath}.label`);
    const optionValue = stringValue(state, required(option, "value", optionPath), `${optionPath}.value`, { max: GENERATIVE_UI_LIMITS.maxInputLength });
    if (optionValues.has(optionValue)) fail(`${optionPath}.value`, `duplicate select option value: ${optionValue}`);
    optionValues.add(optionValue);
    return { label: optionLabel, value: optionValue };
  });
  const defaultValue = optionalString(state, value.default_value, `${path}.default_value`, { max: GENERATIVE_UI_LIMITS.maxInputLength });
  if (defaultValue !== undefined && !optionValues.has(defaultValue)) fail(`${path}.default_value`, "must match one of the declared option values");
  return { ...base, name, label, ...(requiredField === undefined ? {} : { required: requiredField }), ...(defaultValue === undefined ? {} : { default_value: defaultValue }), options };
}

function jsonByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") fail("$", "must be JSON serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    if (error instanceof GenerativeUiValidationError) throw error;
    fail("$", "must be JSON serializable");
  }
}

export function parseGenerativeUiDocument(input, { allowedLocalRoots = [] } = {}) {
  const inputBytes = jsonByteLength(input);
  if (inputBytes > GENERATIVE_UI_LIMITS.maxBytes) {
    fail("$", `document exceeds ${GENERATIVE_UI_LIMITS.maxBytes} UTF-8 bytes`, "GENERATIVE_UI_RESOURCE_LIMIT");
  }
  const state = {
    allowedLocalRoots: [...new Set((Array.isArray(allowedLocalRoots) ? allowedLocalRoots : [])
      .map((root) => String(root || "").trim())
      .filter(Boolean)
      .map((root) => {
        try { return realpathSync(root); } catch { return null; }
      })
      .filter(Boolean))],
    nodeIds: new Set(),
    actionIds: new Set(),
    nodeCount: 0,
    visibleTextLength: 0,
    tableCount: 0,
    chartCount: 0,
    formCount: 0,
  };
  const value = objectValue(input, "$");
  allowedKeys(value, ["schema_version", "surface_id", "revision", "title", "summary", "root"], "$");
  if (required(value, "schema_version", "$") !== GENERATIVE_UI_SCHEMA_VERSION) {
    fail("$.schema_version", `only schema version ${GENERATIVE_UI_SCHEMA_VERSION} is supported`, "GENERATIVE_UI_UNSUPPORTED_VERSION");
  }
  const surfaceId = safeIdValue(state, required(value, "surface_id", "$"), "$.surface_id");
  const revision = integerValue(required(value, "revision", "$"), "$.revision", { min: 1, max: 1_000_000 });
  const title = optionalString(state, value.title, "$.title", { max: 120 });
  const summary = stringValue(state, required(value, "summary", "$"), "$.summary", { max: 1_000 });
  const root = nodeValue(state, required(value, "root", "$"), "$.root", 1);
  const document = {
    schema_version: GENERATIVE_UI_SCHEMA_VERSION,
    surface_id: surfaceId,
    revision,
    ...(title === undefined ? {} : { title }),
    summary,
    root,
  };
  const byteSize = jsonByteLength(document);
  if (byteSize > GENERATIVE_UI_LIMITS.maxBytes) {
    fail("$", `normalized document exceeds ${GENERATIVE_UI_LIMITS.maxBytes} UTF-8 bytes`, "GENERATIVE_UI_RESOURCE_LIMIT");
  }
  return {
    document,
    stats: Object.freeze({
      byte_size: byteSize,
      node_count: state.nodeCount,
      visible_text_length: state.visibleTextLength,
      table_count: state.tableCount,
      chart_count: state.chartCount,
      form_count: state.formCount,
    }),
  };
}

export function validateGenerativeUiDocument(input, options = {}) {
  return parseGenerativeUiDocument(input, options).document;
}

function canonicalHashValue(value) {
  if (Array.isArray(value)) return value.map(canonicalHashValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalHashValue(value[key])]));
}

export function hashGenerativeUiDocument(document) {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalHashValue(document)), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function authorizeGenerativeUiHostResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  Object.defineProperty(result, GENERATIVE_UI_HOST_RESULT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  return result;
}

export function isAuthorizedGenerativeUiHostResult(result) {
  return Boolean(result && typeof result === "object" && result[GENERATIVE_UI_HOST_RESULT] === true);
}

export const GENERATIVE_UI_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "surface_id", "revision", "summary", "root"],
  properties: {
    schema_version: { type: "number", enum: [1], description: "固定为数字 1" },
    surface_id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$", description: "同一逻辑界面的稳定 ID" },
    revision: { type: "integer", minimum: 1, maximum: 1_000_000, description: "完整快照版本；更新时严格递增" },
    title: { type: "string", minLength: 1, maxLength: 120, description: "可选界面标题" },
    summary: { type: "string", minLength: 1, maxLength: 1_000, description: "必填的纯文本摘要，用于无障碍和降级显示" },
    root: {
      type: "object",
      required: ["id", "type"],
      description: "完整组件树。允许 stack、grid、section、text、markdown、metric、alert、state、divider、table、chart、image、button、form、text_input、select、checkbox；节点只可使用各组件声明字段。",
    },
  },
});

export default {
  GENERATIVE_UI_SCHEMA_VERSION,
  GENERATIVE_UI_LIMITS,
  GENERATIVE_UI_TOOL_INPUT_SCHEMA,
  GenerativeUiValidationError,
  authorizeGenerativeUiHostResult,
  hashGenerativeUiDocument,
  isAuthorizedGenerativeUiHostResult,
  parseGenerativeUiDocument,
  validateGenerativeUiDocument,
};
