import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GENERATIVE_UI_LIMITS,
  hashGenerativeUiDocument,
  parseGenerativeUiDocument,
} from "../../server/src/engine/agents/generative_ui_schema.js";

function document(root, overrides = {}) {
  return {
    schema_version: 1,
    surface_id: "sales-overview",
    revision: 1,
    title: "销售概览",
    summary: "销售额保持增长，华东区域需要继续分析。",
    root,
    ...overrides,
  };
}

function textRoot(overrides = {}) {
  return { id: "root", type: "text", text: "结论", ...overrides };
}

function validationError(input, options = {}) {
  try {
    parseGenerativeUiDocument(input, options);
  } catch (error) {
    return error;
  }
  assert.fail("expected Generative UI validation to fail");
}

test("Generative UI v1 validates and normalizes the complete trusted component vocabulary", () => {
  const input = document({
    id: "root",
    type: "stack",
    gap: "md",
    children: [
      { id: "loading", type: "state", state: "loading", title: "加载中" },
      {
        id: "metrics",
        type: "grid",
        columns: 2,
        children: [
          { id: "sales", type: "metric", label: "销售额", value: 42, delta: "+8%", trend: "up" },
          { id: "notice", type: "alert", tone: "warning", message: "华东低于目标" },
        ],
      },
      {
        id: "table",
        type: "table",
        columns: [{ key: "region", label: "地区" }, { key: "amount", label: "金额", align: "right" }],
        rows: [{ region: "华东", amount: 42 }],
      },
      {
        id: "chart",
        type: "chart",
        chart_type: "line",
        x_key: "month",
        series: [{ key: "amount", label: "金额" }],
        data: [{ month: "八月", amount: 42 }],
      },
      { id: "image", type: "image", src: "https://example.com/chart.png", alt: "趋势图" },
      { id: "next", type: "button", action_id: "analyze-east", label: "分析华东" },
      {
        id: "form",
        type: "form",
        action_id: "create-report",
        submit_label: "生成报告",
        children: [
          { id: "notes", type: "text_input", name: "notes", label: "说明", default_value: "保留明细" },
          {
            id: "region",
            type: "select",
            name: "region",
            label: "地区",
            default_value: "east",
            options: [{ label: "华东", value: "east" }],
          },
          { id: "details", type: "checkbox", name: "details", label: "包含明细", default_checked: true },
        ],
      },
    ],
  }, { title: "  销售概览  ", summary: "  销售额保持增长。  " });
  const original = structuredClone(input);

  const parsed = parseGenerativeUiDocument(input);

  assert.deepEqual(input, original, "validation must not mutate model input");
  assert.equal(parsed.document.title, "销售概览");
  assert.equal(parsed.document.summary, "销售额保持增长。");
  assert.equal(parsed.document.root.children[0].type, "state");
  assert.equal(parsed.stats.node_count, 13);
  assert.equal(parsed.stats.table_count, 1);
  assert.equal(parsed.stats.chart_count, 1);
  assert.equal(parsed.stats.form_count, 1);
  assert.match(hashGenerativeUiDocument(parsed.document), /^sha256:[a-f0-9]{64}$/);
});

test("Generative UI v1 rejects unknown fields, unsafe prototypes, duplicate IDs and hidden actions", () => {
  const cases = [
    [document({ id: "root", type: "unknown" }), "$.root.type"],
    [document({ ...textRoot(), tool: "shell" }), "$.root.tool"],
    [document({ id: "root", type: "text_input", name: "field", label: "字段" }), "$.root.type"],
    [document({ id: "root", type: "stack", children: [
      { id: "same", type: "button", action_id: "same-action", label: "一" },
      { id: "same", type: "button", action_id: "other-action", label: "二" },
    ] }), "$.root.children[1].id"],
    [document({ id: "root", type: "stack", children: [
      { id: "one", type: "button", action_id: "same-action", label: "一" },
      { id: "two", type: "button", action_id: "same-action", label: "二" },
    ] }), "$.root.children[1].action_id"],
    [JSON.parse('{"schema_version":1,"surface_id":"safe","revision":1,"summary":"安全","root":{"id":"root","type":"text","text":"安全","__proto__":{}}}'), "$.root.__proto__"],
  ];
  for (const [input, path] of cases) {
    const error = validationError(input);
    assert.equal(error.code, "GENERATIVE_UI_SCHEMA_INVALID");
    assert.equal(error.path, path);
  }
});

test("Generative UI v1 enforces table, chart, form and select semantics", () => {
  const cases = [
    document({ id: "root", type: "table", columns: [{ key: "name", label: "名称" }], rows: [{ hidden: "不可见" }] }),
    document({
      id: "root", type: "chart", chart_type: "line", x_key: "x",
      series: [{ key: "y", label: "数值" }], data: [{ x: "一", y: "42" }],
    }),
    document({
      id: "root", type: "form", action_id: "submit", submit_label: "提交", children: [
        { id: "a", type: "text_input", name: "field", label: "字段" },
        { id: "b", type: "checkbox", name: "field", label: "重复字段" },
      ],
    }),
    document({
      id: "root", type: "form", action_id: "submit", submit_label: "提交", children: [{
        id: "choice", type: "select", name: "choice", label: "选项", default_value: "missing",
        options: [{ label: "甲", value: "a" }, { label: "乙", value: "a" }],
      }],
    }),
  ];
  const errors = cases.map((input) => validationError(input));
  assert.equal(errors[0].path, "$.root.rows[0].hidden");
  assert.equal(errors[1].path, "$.root.data[0].y");
  assert.equal(errors[2].path, "$.root.children[1].name");
  assert.equal(errors[3].path, "$.root.children[0].options[1].value");

  const missingDefault = document({
    id: "root", type: "form", action_id: "submit", submit_label: "提交", children: [{
      id: "choice", type: "select", name: "choice", label: "选项", default_value: "missing",
      options: [{ label: "甲", value: "a" }],
    }],
  });
  assert.equal(validationError(missingDefault).path, "$.root.children[0].default_value");
});

test("Generative UI v1 enforces depth, node, byte and visible-control limits", () => {
  let deep = { id: "leaf", type: "text", text: "内容" };
  for (let index = 8; index >= 1; index -= 1) deep = { id: `level-${index}`, type: "stack", children: [deep] };
  assert.equal(validationError(document(deep)).code, "GENERATIVE_UI_RESOURCE_LIMIT");

  const wide = document({
    id: "root",
    type: "stack",
    children: Array.from({ length: 32 }, (_, group) => ({
      id: `group-${group}`,
      type: "stack",
      children: Array.from({ length: 4 }, (_, child) => ({ id: `node-${group}-${child}`, type: "divider" })),
    })),
  });
  assert.equal(validationError(wide).code, "GENERATIVE_UI_RESOURCE_LIMIT");

  const oversized = document({ id: "root", type: "image", src: `data:image/png;base64,${"a".repeat(GENERATIVE_UI_LIMITS.maxBytes)}`, alt: "图片" });
  assert.equal(validationError(oversized).code, "GENERATIVE_UI_RESOURCE_LIMIT");

  assert.equal(validationError(document(textRoot({ text: "正常\u202e伪装" }))).path, "$.root.text");
  assert.doesNotThrow(() => parseGenerativeUiDocument(document(textRoot({ text: "第一行\n\t第二行" }))));
  assert.equal(validationError(document(textRoot(), { title: "标题\n伪装" })).path, "$.title");
});

test("Generative UI v1 accepts only safe image sources and workspace-owned local raster files", async () => {
  const root = await mkdtemp(join(tmpdir(), "generative-ui-"));
  const outside = await mkdtemp(join(tmpdir(), "generative-ui-outside-"));
  try {
    const localImage = join(root, "chart.png");
    const outsideImage = join(outside, "secret.png");
    await writeFile(localImage, "png");
    await writeFile(outsideImage, "png");

    const accepted = parseGenerativeUiDocument(document({ id: "root", type: "image", src: localImage, alt: "本地图" }), {
      allowedLocalRoots: [root],
    });
    assert.match(accepted.document.root.src, /^dsh-file:\/\/local\/[a-zA-Z0-9_-]+$/);
    assert.doesNotThrow(() => parseGenerativeUiDocument(
      document({ id: "root", type: "image", src: accepted.document.root.src, alt: "本地图" }),
      { allowedLocalRoots: [root] },
    ));
    assert.doesNotThrow(() => parseGenerativeUiDocument(document({ id: "root", type: "image", src: "https://example.com/a.png", alt: "远程图" })));
    assert.doesNotThrow(() => parseGenerativeUiDocument(document({ id: "root", type: "image", src: "data:image/png;base64,aW1hZ2U=", alt: "内联图" })));

    for (const src of [
      "http://example.com/a.png",
      "https://user:secret@example.com/a.png",
      "file:///tmp/a.png",
      "../a.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGgxPkJvb208L2gxPg==",
      outsideImage,
    ]) {
      const error = validationError(document({ id: "root", type: "image", src, alt: "图片" }), { allowedLocalRoots: [root] });
      assert.equal(error.code, "GENERATIVE_UI_UNSAFE_RESOURCE", src);
      assert.equal(error.path, "$.root.src", src);
    }
    assert.equal(
      validationError(document({ id: "root", type: "image", src: localImage, alt: "图片" })).code,
      "GENERATIVE_UI_UNSAFE_RESOURCE",
    );
    assert.equal(
      validationError(document({ id: "root", type: "image", src: accepted.document.root.src, alt: "图片" })).code,
      "GENERATIVE_UI_UNSAFE_RESOURCE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
