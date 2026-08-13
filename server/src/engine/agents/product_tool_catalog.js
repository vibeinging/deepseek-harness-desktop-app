import { APP_DISPLAY_NAME } from "../../config/app_name.js";

export const PRODUCT_TOOL_CATALOG = [
  {
    name: "ui_render",
    description:
      "用宿主可信组件渲染一份完整的生成式界面快照。只在布局、数据组合或可见交互明显优于普通文本时使用；" +
      "简单回答继续使用普通文本。按钮和表单只会让用户发送下一轮普通消息，不代表操作已经执行。" +
      "界面展示成功后仍要继续输出简短的普通文本结论。",
    safety: "read",
    domain: "presentation",
  },
  {
    name: "project_list",
    description: "列出当前用户可访问的项目,可按名称搜索。",
    safety: "read",
    domain: "project",
  },
  {
    name: "project_create",
    description: "创建新的项目,并把当前用户设为项目负责人。",
    safety: "write",
    domain: "project",
    confirm: true,
  },
  {
    name: "project_open",
    description: "在桌面端打开用户可访问的项目。只切换界面，不改变当前工具调用所属会话。",
    safety: "read",
    domain: "project",
  },
  {
    name: "conversation_list",
    description: "列出当前或指定工作区中的对话，可选择查看已归档对话。",
    safety: "read",
    domain: "conversation",
  },
  {
    name: "conversation_create",
    description: "在当前或指定工作区创建一条新对话。创建后不会自动把当前运行迁移到新对话。",
    safety: "write",
    domain: "conversation",
    confirm: true,
  },
  {
    name: "conversation_open",
    description: `在${APP_DISPLAY_NAME}桌面端打开指定对话。只切换界面，当前模型运行仍留在原对话。`,
    safety: "read",
    domain: "conversation",
  },
  {
    name: "conversation_rename",
    description: "修改当前用户拥有的对话标题。",
    safety: "write",
    domain: "conversation",
    confirm: true,
  },
  {
    name: "conversation_archive",
    description: "归档或恢复当前用户拥有的对话。归档可恢复，不会删除消息。",
    safety: "write",
    domain: "conversation",
    confirm: true,
  },
  {
    name: "file_classify",
    description: "识别本地文件或目录中的数据文件类型,按数据库文件、结构化文件、非结构化文档分组。",
    safety: "read",
    domain: "file",
  },
  {
    name: "canvas_inspect",
    description:
      "读取当前对话中的文档、代码或本地 Site 全文、当前版本、版本历史和行内建议。" +
      "修改前必须先读取，不能猜测版本、范围或正文。",
    safety: "read",
    domain: "canvas",
  },
  {
    name: "canvas_create",
    description:
      "在当前对话创建可直接编辑的文档、代码或本地 Site。Site 使用完整的单文件 HTML，只在本地沙箱预览，不提供公开 URL。",
    safety: "write",
    domain: "canvas",
  },
  {
    name: "canvas_edit",
    description:
      "按 canvas_inspect 返回的当前版本修改 Canvas。必须提供当前基线版本；" +
      "保存会创建新版本，不覆盖历史，并拒绝旧基线。",
    safety: "write",
    domain: "canvas",
  },
  {
    name: "canvas_suggest",
    description:
      "为当前 Canvas 的精确文字范围创建行内改写建议，不直接覆盖正文。" +
      "必须提供当前基线版本、范围和原文字，用户可接受或拒绝。",
    safety: "write",
    domain: "canvas",
  },
  {
    name: "artifact_publish",
    description:
      "把当前对话授权目录或本轮运行工作区中的一个已完成文件加入 Library。" +
      "同一路径会保留稳定产物 ID 并新增不可变版本；返回来源 Turn、版本、指纹和可引用路径。",
    safety: "write",
    domain: "artifact",
    requires_project: true,
    output_contract: {
      role: "deliverable",
      surface: "workspace",
      persistence: "library",
      kind: "file",
    },
  },
  {
    name: "artifact_office_inspect",
    description:
      "读取当前 Library 中 Markdown、DOCX、XLSX、PPTX 或 PDF 产物的可编辑结构和稳定锚点。" +
      "修改前必须先读取当前版本，不能自行猜测段落、单元格、页面或对象锚点。",
    safety: "read",
    domain: "artifact",
    requires_project: true,
  },
  {
    name: "artifact_office_create",
    description:
      "在当前对话创建 Markdown、DOCX、XLSX、PPTX 或 PDF 产物，并直接进入 Library 和版本历史。",
    safety: "write",
    domain: "artifact",
    requires_project: true,
    output_contract: {
      role: "deliverable",
      surface: "workspace",
      persistence: "library",
      kind: "document",
    },
  },
  {
    name: "artifact_office_edit",
    description:
      "按 artifact_office_inspect 返回的稳定锚点修改当前 Library 中的办公产物。" +
      "必须提供当前基线版本；保存会创建新版本，不覆盖历史，并在并发更新时拒绝旧基线。",
    safety: "write",
    domain: "artifact",
    requires_project: true,
    output_contract: {
      role: "deliverable",
      surface: "workspace",
      persistence: "library",
      kind: "document",
    },
  },
  {
    name: "skill_list",
    description: `列出按标准目录发现的用户、系统和${APP_DISPLAY_NAME} Plugin Skills。`,
    safety: "read",
    domain: "skill",
  },
  {
    name: "skill_create",
    description: `在${APP_DISPLAY_NAME} Skill 目录创建标准 SKILL.md 和 agents/openai.yaml。`,
    safety: "write",
    domain: "skill",
    confirm: true,
  },
  {
    name: "skill_update",
    description: "更新 App 级自定义 Skill 定义。内置 Skill 不支持编辑定义。",
    safety: "write",
    domain: "skill",
    confirm: true,
  },
  {
    name: "skill_toggle",
    description: "通过 Agent skills/config/write 更新 Skill 启用状态，结果保存到 config.toml。",
    safety: "write",
    domain: "skill",
    confirm: true,
  },
  {
    name: "skill_delete",
    description: "删除由 App 创建的用户 Skill 文件目录。系统、项目和 Plugin Skill 不可删除。",
    safety: "write",
    domain: "skill",
    confirm: true,
  },
  {
    name: "project_skill_list",
    description: "按 Agent 目录和 config.toml 规则查看当前或指定项目的有效 Skills。",
    safety: "read",
    domain: "skill",
  },
];

export const PRODUCT_TOOL_NAMES = new Set(PRODUCT_TOOL_CATALOG.map((t) => t.name));
export const PRODUCT_CONFIRM_TOOL_NAMES = new Set(PRODUCT_TOOL_CATALOG.filter((t) => t.confirm).map((t) => t.name));
export const PRODUCT_WRITE_TOOL_NAMES = new Set(PRODUCT_TOOL_CATALOG.filter((t) => t.safety === "write").map((t) => t.name));
