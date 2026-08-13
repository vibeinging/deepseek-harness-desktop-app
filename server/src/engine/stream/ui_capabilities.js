import { basename, extname } from "node:path";

export const IMAGE_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
export const CODE_EXTENSIONS = Object.freeze([".py", ".js", ".ts", ".sql", ".sh", ".json"]);
export const TABLE_EXTENSIONS = Object.freeze([".csv", ".xls", ".xlsx", ".parquet"]);

export const UI_CAPABILITIES = Object.freeze({
  renderers: {
    markdown: { enabled: true },
    image: {
      enabled: true,
      inline: true,
      protocol: "dsh-file",
      allowed_roots: ["workspace"],
      extensions: IMAGE_EXTENSIONS,
    },
    code: { enabled: true },
    table: { enabled: true },
  },
  artifacts: ["file", "code", "table", "image"],
});

export function artifactKindForPath(filePath) {
  const ext = extname(String(filePath || "")).toLowerCase();
  if (CODE_EXTENSIONS.includes(ext)) return "code";
  if (TABLE_EXTENSIONS.includes(ext)) return "table";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  return "file";
}

export function isImagePath(filePath) {
  return artifactKindForPath(filePath) === "image";
}

export function artifactPayloadFromPath(filePath, options = {}) {
  const path = String(filePath || "").trim();
  if (!path) return null;
  const kind = options.kind || artifactKindForPath(path);
  return {
    artifact_id: options.artifact_id || `file:${path}`,
    kind,
    name: options.name || basename(path),
    path,
    source_tool_call_id: options.source_tool_call_id || null,
    source_tool_name: options.source_tool_name || null,
  };
}

export function renderUiCapabilityPrompt({ cwd } = {}) {
  const imageExts = IMAGE_EXTENSIONS.map((ext) => ext.slice(1)).join("/");
  const examplePath = cwd ? `${cwd}/red_solid.png` : "/absolute/workspace/path/red_solid.png";
  return `
界面能力:
- 主对话支持 Markdown 文本渲染,并支持展示工作区内图片文件(${imageExts})。
- 如果你生成、读取或被要求展示工作区内图片,不要说"无法直接显示";直接在最终回答中使用 Markdown 图片语法: ![简短说明](图片绝对路径)。
- 图片路径必须是当前工作区内的绝对路径,例如 ![red_solid](${examplePath})。
- 工具声明为最终产物的表格、图表、图片、音频、文件和 Plugin 内容会直接显示在对话结果区,不会折叠进操作过程。
- 工具声明需要长期保存的文件会由系统加入当前 Library;临时聊天只展示本轮结果,不会保存到 Library。`;
}

export default {
  UI_CAPABILITIES,
  IMAGE_EXTENSIONS,
  CODE_EXTENSIONS,
  TABLE_EXTENSIONS,
  artifactKindForPath,
  isImagePath,
  artifactPayloadFromPath,
  renderUiCapabilityPrompt,
};
