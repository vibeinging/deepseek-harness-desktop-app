import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAgentFilePreview,
  getAgentFile,
} from '../../server/src/app/chat/agent_misc.js';

function tinyPdf(text) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, '\\$&')}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}

test('workspace file previews are size-limited and reject binary content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const largeText = join(root, 'large.txt');
  await writeFile(largeText, `开头标记\n${'a'.repeat(240 * 1024)}`);
  const textPreview = await buildAgentFilePreview(largeText, 'large.txt', 'source-1');
  assert.equal(textPreview.can_preview, true);
  assert.equal(textPreview.preview_kind, 'text');
  assert.equal(textPreview.preview_mode, 'source_text');
  assert.equal(textPreview.truncated, true);
  assert.match(textPreview.content, /^开头标记/);
  assert.ok(Buffer.byteLength(textPreview.content, 'utf8') <= 200 * 1024);

  const binary = join(root, 'payload.bin');
  await writeFile(binary, Buffer.from([0, 1, 2, 3, 255]));
  const binaryPreview = await buildAgentFilePreview(binary, 'payload.bin', 'source-1');
  assert.equal(binaryPreview.can_preview, false);
  assert.equal(binaryPreview.preview_kind, 'unsupported');
  assert.match(binaryPreview.reason, /本机应用打开/);

  const customText = join(root, 'notes.custom');
  await writeFile(customText, '自定义扩展名也可以安全预览');
  const customPreview = await buildAgentFilePreview(customText, 'notes.custom', 'source-1');
  assert.equal(customPreview.can_preview, true);
  assert.match(customPreview.content, /安全预览/);

  const XLSX = await import(new URL('../../server/node_modules/xlsx/xlsx.mjs', import.meta.url));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['name', 'count'], ['demo', 2]]),
    'Summary',
  );
  const spreadsheet = join(root, 'summary.xlsx');
  await writeFile(spreadsheet, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const spreadsheetPreview = await buildAgentFilePreview(spreadsheet, 'summary.xlsx', 'source-1');
  assert.equal(spreadsheetPreview.can_preview, true);
  assert.equal(spreadsheetPreview.preview_kind, 'table');
  assert.equal(spreadsheetPreview.preview_mode, 'extracted_text');
  assert.match(spreadsheetPreview.content, /# Sheet: Summary/);
  assert.match(spreadsheetPreview.content, /demo,2/);

  const pdf = join(root, 'preview.pdf');
  await writeFile(pdf, tinyPdf('Hello Preview'));
  const pdfPreview = await buildAgentFilePreview(pdf, 'preview.pdf', 'source-1');
  assert.equal(pdfPreview.can_preview, true);
  assert.equal(pdfPreview.preview_kind, 'document');
  assert.equal(pdfPreview.preview_mode, 'extracted_text');
  assert.match(pdfPreview.content, /Hello Preview/);

  const jszipModule = await import(new URL('../../server/node_modules/jszip/lib/index.js', import.meta.url));
  const JSZip = jszipModule.default || jszipModule;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>Hello DOCX Preview</w:t></w:r></w:p></w:body>
    </w:document>`);
  const docx = join(root, 'preview.docx');
  await writeFile(docx, await zip.generateAsync({ type: 'nodebuffer' }));
  const docxPreview = await buildAgentFilePreview(docx, 'preview.docx', 'source-1');
  assert.equal(docxPreview.can_preview, true);
  assert.equal(docxPreview.preview_kind, 'document');
  assert.match(docxPreview.content, /Hello DOCX Preview/);

  const presentationZip = new JSZip();
  presentationZip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>
    </p:presentation>`);
  presentationZip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/>
      <Relationship Id="rId2" Target="slides/slide2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/>
    </Relationships>`);
  presentationZip.file('ppt/slides/slide2.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second &amp; final slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>`);
  presentationZip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:sp><p:txBody>
        <a:p><a:r><a:t>Hello PPTX Preview</a:t></a:r></a:p>
        <a:p><a:r><a:t>Launch plan</a:t></a:r></a:p>
      </p:txBody></p:sp></p:spTree></p:cSld>
    </p:sld>`);
  const presentation = join(root, 'preview.pptx');
  await writeFile(presentation, await presentationZip.generateAsync({ type: 'nodebuffer' }));
  const presentationPreview = await buildAgentFilePreview(presentation, 'preview.pptx', 'source-1');
  assert.equal(presentationPreview.can_preview, true);
  assert.equal(presentationPreview.preview_kind, 'document');
  assert.equal(presentationPreview.preview_mode, 'extracted_text');
  assert.match(presentationPreview.content, /# Slide 1\nSecond & final slide/);
  assert.match(presentationPreview.content, /# Slide 2\nHello PPTX Preview\nLaunch plan/);
});

test('workspace preview endpoint checks project access and resolved file paths', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'workspace-preview-access-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'source');
  await mkdir(root);
  await writeFile(join(root, 'inside.md'), '# 项目内文件');
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, '不能通过预览读取');

  const sourceId = 'source-1';
  const projectId = 'project-1';
  const userId = 'user-1';
  const ctx = {
    userId,
    async queryOne(sql, params = []) {
      if (sql.includes('FROM projects p')) {
        return params[0] === projectId && params[1] === userId ? { id: projectId } : null;
      }
      return null;
    },
    async query(sql) {
      if (sql.includes('FROM project_source_folders')) {
        return [{
          id: sourceId,
          project_id: projectId,
          local_path: root,
          display_name: '资料',
          sort_order: 0,
        }];
      }
      return [];
    },
  };

  const inside = await getAgentFile(ctx, {
    params: { pid: projectId },
    query: { root_id: sourceId, path: 'inside.md' },
  });
  assert.equal(inside.data.can_preview, true);
  assert.match(inside.data.content, /项目内文件/);

  const traversal = await getAgentFile(ctx, {
    params: { pid: projectId },
    query: { root_id: sourceId, path: '../outside.txt' },
  });
  assert.equal(traversal.data, null);
  assert.match(traversal.message, /不存在或无权限/);

  const symlinkPath = join(root, 'outside-link.txt');
  const linked = await symlink(outside, symlinkPath).then(() => true).catch(() => false);
  if (linked) {
    const escapedLink = await getAgentFile(ctx, {
      params: { pid: projectId },
      query: { root_id: sourceId, path: 'outside-link.txt' },
    });
    assert.equal(escapedLink.data, null);
    assert.match(escapedLink.message, /不存在或无权限/);
  }
});
