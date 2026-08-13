import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { ApiError } from "../../errors.js";

export function parseOfficeXml(source, label = "办公文件") {
  const text = String(source || "");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ApiError(`${label}包含不安全的 XML 声明`, 400);
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => errors.push(String(message || "XML 解析失败")),
      fatalError: (message) => errors.push(String(message || "XML 解析失败")),
    },
  }).parseFromString(text, "application/xml");
  if (!document?.documentElement || errors.length || document.getElementsByTagName("parsererror").length) {
    throw new ApiError(`${label}的 XML 已损坏`, 400);
  }
  return document;
}

export function serializeOfficeXml(document) {
  return new XMLSerializer().serializeToString(document);
}

export function localName(node) {
  return String(node?.localName || node?.nodeName || "").split(":").pop();
}

export function elementChildren(node) {
  const children = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child);
  }
  return children;
}

export function childrenNamed(node, name) {
  return elementChildren(node).filter((child) => localName(child) === name);
}

export function descendantsNamed(node, name) {
  const result = [];
  const visit = (current) => {
    for (const child of elementChildren(current)) {
      if (localName(child) === name) result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

export function firstDescendant(node, name) {
  const values = descendantsNamed(node, name);
  return values[0] || null;
}

export function attributeByLocalName(node, name) {
  const attributes = node?.attributes;
  if (!attributes) return "";
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (localName(attribute) === name) return String(attribute?.value || "");
  }
  return "";
}

export function setAttributeByLocalName(node, name, value, namespace = "", prefix = "") {
  const attributes = node?.attributes;
  if (attributes) {
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes.item(index);
      if (localName(attribute) !== name) continue;
      attribute.value = String(value);
      return;
    }
  }
  if (namespace) node.setAttributeNS(namespace, prefix ? `${prefix}:${name}` : name, String(value));
  else node.setAttribute(name, String(value));
}

export function removeChildrenNamed(node, names) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  for (const child of elementChildren(node)) {
    if (wanted.has(localName(child))) node.removeChild(child);
  }
}

export function visibleText(node, textElementName = "t") {
  return descendantsNamed(node, textElementName).map((item) => String(item.textContent || "")).join("");
}

function locateOffset(parts, offset, preferNext) {
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const end = cursor + parts[index].length;
    if (offset < end || (offset === end && (!preferNext || index === parts.length - 1))) {
      return { index, offset: offset - cursor };
    }
    cursor = end;
  }
  return { index: Math.max(0, parts.length - 1), offset: parts.at(-1)?.length || 0 };
}

function preserveWhitespace(node) {
  const text = String(node?.textContent || "");
  if (/^\s|\s$/.test(text)) node.setAttribute("xml:space", "preserve");
  else node.removeAttribute("xml:space");
}

export function replaceTextNodes(nodes, replacement, { start = 0, end } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) throw new ApiError("目标内容没有可编辑文字", 409);
  const parts = nodes.map((node) => String(node.textContent || ""));
  const current = parts.join("");
  const from = Number(start);
  const to = end === undefined ? current.length : Number(end);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > current.length) {
    throw new ApiError("文字选区已失效，请重新选择", 409);
  }
  const inserted = String(replacement ?? "");
  const startPoint = locateOffset(parts, from, true);
  const endPoint = locateOffset(parts, to, false);
  if (startPoint.index === endPoint.index) {
    const original = parts[startPoint.index];
    nodes[startPoint.index].textContent = `${original.slice(0, startPoint.offset)}${inserted}${original.slice(endPoint.offset)}`;
    preserveWhitespace(nodes[startPoint.index]);
  } else {
    nodes[startPoint.index].textContent = `${parts[startPoint.index].slice(0, startPoint.offset)}${inserted}`;
    preserveWhitespace(nodes[startPoint.index]);
    for (let index = startPoint.index + 1; index < endPoint.index; index += 1) {
      nodes[index].textContent = "";
      preserveWhitespace(nodes[index]);
    }
    nodes[endPoint.index].textContent = parts[endPoint.index].slice(endPoint.offset);
    preserveWhitespace(nodes[endPoint.index]);
  }
  return { before: current, after: `${current.slice(0, from)}${inserted}${current.slice(to)}` };
}

export function insertElementSorted(parent, element, compare) {
  for (const child of elementChildren(parent)) {
    if (compare(element, child) < 0) {
      parent.insertBefore(element, child);
      return element;
    }
  }
  parent.appendChild(element);
  return element;
}

export function createElement(document, namespace, qualifiedName, text = undefined) {
  const element = document.createElementNS(namespace, qualifiedName);
  if (text !== undefined) element.appendChild(document.createTextNode(String(text)));
  return element;
}
