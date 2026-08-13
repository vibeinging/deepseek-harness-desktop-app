import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";
import hljs from 'highlight.js';
import createDOMPurify from 'dompurify';
import "highlight.js/styles/ir-black.css";
import "katex/dist/katex.min.css";

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: any, lang: any, info: any) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    }
  }),
  markedKatex({
    throwOnError: false,
    output: 'html'
  })
);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderLazyMarkdownImage(href: string, title: string | null, text: string) {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async"${titleAttribute}>`;
}

marked.use({
  renderer: {
    html(token: any) {
      return escapeHtml(typeof token === 'string' ? token : String(token?.text || token?.raw || ''));
    },
    image(href: string, title: string | null, text: string) {
      return renderLazyMarkdownImage(href, title, text);
    }
  }
});

const purifier = typeof window !== 'undefined' ? createDOMPurify(window) : null;
const NO_REFERRER_META = '<meta name="referrer" content="no-referrer">';

export function addHostDocumentSecurityMetadata(document: string) {
  const head = /<head\b[^>]*>/i;
  if (head.test(document)) return document.replace(head, (open) => `${open}${NO_REFERRER_META}`);
  return `${NO_REFERRER_META}${document}`;
}

export function renderSafeMarkdown(source: unknown) {
  const text = String(source || '');
  const html = marked.parse(text) as string;
  if (!purifier) return escapeHtml(text);
  return purifier.sanitize(html, {
    FORBID_TAGS: ['iframe', 'form', 'object', 'embed', 'style'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  });
}

export function sanitizePluginHtmlDocument(source: unknown) {
  const text = String(source || '')
  if (!purifier) return escapeHtml(text)
  const sanitized = purifier.sanitize(text, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'base', 'meta'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  })
  return addHostDocumentSecurityMetadata(sanitized)
}

// Extract headings for TOC generation.
export function extractToc(markdown: any) {
  const headings: any[] = [];
  const tokens = marked.lexer(markdown);

  tokens.forEach((token: any) => {
    if (token.type === 'heading' && token.depth >= 2) {
      headings.push({
        level: token.depth,
        text: token.text,
        id: token.text
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
          .replace(/^-+|-+$/g, '')
      });
    }
  });

  return headings;
}

export default marked;
