import { readFile, writeFile } from "node:fs/promises";
import { ApiError } from "../../errors.js";

function splitBlocks(source) {
  const text = String(source || "").replace(/\r\n?/g, "\n");
  const blocks = [];
  let cursor = 0;
  for (const match of text.matchAll(/\n{2,}/g)) {
    const end = Number(match.index || 0);
    if (end > cursor) blocks.push({ text: text.slice(cursor, end), start: cursor, end });
    cursor = end + String(match[0] || "").length;
  }
  let finalEnd = text.length;
  if (finalEnd > cursor && text.endsWith("\n")) finalEnd -= 1;
  if (finalEnd > cursor) blocks.push({ text: text.slice(cursor, finalEnd), start: cursor, end: finalEnd });
  return blocks;
}

function blockKind(text) {
  if (/^#{1,6}\s/.test(text)) return "heading";
  if (/^```/.test(text)) return "code";
  if (/^(?:[-*+] |\d+\. )/.test(text)) return "list";
  if (/^>\s?/.test(text)) return "quote";
  return "paragraph";
}

export function inspectMarkdown(source) {
  const text = String(source || "").replace(/\r\n?/g, "\n");
  const blocks = splitBlocks(text).map((block, index) => ({
    anchor: `md:block:${index + 1}`,
    kind: blockKind(block.text),
    text: block.text,
    start: block.start,
    end: block.end,
  }));
  return {
    format: "markdown",
    sections: blocks,
    capabilities: { create: true, replace_text: true, replace_range: true, rich_preview: true },
    warnings: [],
  };
}

export async function inspectMarkdownFile(filePath) {
  return inspectMarkdown(await readFile(filePath, "utf8"));
}

export function applyMarkdownOperations(source, operations = []) {
  const current = String(source || "").replace(/\r\n?/g, "\n");
  const inspected = inspectMarkdown(current);
  const groups = new Map();
  for (const operation of operations) {
    const block = inspected.sections.find((item) => item.anchor === String(operation?.anchor || ""));
    if (!block) throw new ApiError("Markdown 选区已失效，请重新打开当前版本", 409);
    if (operation?.type !== "replace_text" && operation?.type !== "replace_range") {
      throw new ApiError("Markdown 不支持这个修改动作", 400);
    }
    const localStart = operation.type === "replace_range" ? Number(operation.start) : 0;
    const localEnd = operation.type === "replace_range" ? Number(operation.end) : block.text.length;
    if (!Number.isInteger(localStart) || !Number.isInteger(localEnd) || localStart < 0 || localEnd < localStart || localEnd > block.text.length) {
      throw new ApiError("Markdown 文字范围无效", 400);
    }
    const group = groups.get(block.anchor) || { block, edits: [] };
    group.edits.push({
      start: localStart,
      end: localEnd,
      text: String(operation.text ?? ""),
      whole: operation.type === "replace_text",
    });
    groups.set(block.anchor, group);
  }

  const replacements = [];
  for (const { block, edits } of groups.values()) {
    if (edits.length > 1 && edits.some((edit) => edit.whole)) {
      throw new ApiError("同一个 Markdown 内容块不能同时整块替换和局部替换", 400);
    }
    const ascending = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ascending.length; index += 1) {
      const previous = ascending[index - 1];
      const next = ascending[index];
      if (next.start < previous.end || (next.start === previous.start && next.end === previous.end)) {
        throw new ApiError("Markdown 修改范围互相重叠", 400);
      }
    }
    let nextText = block.text;
    for (const edit of [...ascending].reverse()) {
      nextText = `${nextText.slice(0, edit.start)}${edit.text}${nextText.slice(edit.end)}`;
    }
    replacements.push({ block, nextText });
  }

  let content = current;
  for (const replacement of replacements.sort((left, right) => right.block.start - left.block.start)) {
    content = `${content.slice(0, replacement.block.start)}${replacement.nextText}${content.slice(replacement.block.end)}`;
  }
  return {
    content,
    changes: replacements.map(({ block, nextText }) => ({ anchor: block.anchor, before: block.text, after: nextText })),
  };
}

export async function editMarkdownFile(inputPath, outputPath, operations) {
  const result = applyMarkdownOperations(await readFile(inputPath, "utf8"), operations);
  await writeFile(outputPath, result.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return result;
}

export async function createMarkdownFile(outputPath, { title = "", content = "" } = {}) {
  const heading = String(title || "").trim();
  const body = String(content || "").replace(/\r\n?/g, "\n").trim();
  const text = heading ? `# ${heading}\n\n${body}`.trimEnd() + "\n" : `${body}\n`;
  await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return inspectMarkdown(text);
}
