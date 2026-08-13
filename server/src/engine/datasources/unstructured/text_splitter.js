// 迁移自 dsh_kernel/semantic_catalogs/unstructured_data/text_splitter.py(桌面精简:递归字符分块)
//
// 递归按分隔符把文本切成 ≤ chunkSize 的块,块间带 overlap 重叠。
// 中英文混排:段落 → 行 → 句子(中英标点)→ 空格 → 字符。

const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', '; ', ' ', ''];

function splitBySeparators(text, separators, chunkSize) {
  if (text.length <= chunkSize) return [text];
  const seps = separators.length ? separators : [''];
  const sep = seps[0];
  const rest = seps.slice(1);
  const parts = sep === '' ? Array.from(text) : text.split(sep);
  const chunks = [];
  let cur = '';
  for (const part of parts) {
    const piece = sep === '' ? part : part + sep;
    if (piece.length > chunkSize) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (const sub of splitBySeparators(part, rest, chunkSize)) chunks.push(sub);
      continue;
    }
    if (cur.length + piece.length > chunkSize) {
      if (cur) chunks.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 把长文本切成块。
 * @param {string} text
 * @param {{chunkSize?:number, chunkOverlap?:number}} [opts]
 * @returns {string[]}
 */
export function splitText(text, { chunkSize = 512, chunkOverlap = 50 } = {}) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  if (t.length <= chunkSize) return [t];

  const raw = splitBySeparators(t, SEPARATORS, chunkSize).map((s) => s.trim()).filter(Boolean);
  if (chunkOverlap <= 0 || raw.length <= 1) return raw;

  // 块间重叠:把上一块末尾 chunkOverlap 字符接到当前块前
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    let chunk = raw[i];
    if (i > 0) chunk = `${raw[i - 1].slice(-chunkOverlap)}${chunk}`;
    out.push(chunk);
  }
  return out;
}

export default splitText;
