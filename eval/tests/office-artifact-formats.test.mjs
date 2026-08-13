import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import JSZipModule from '../../server/node_modules/jszip/lib/index.js';

import {
  compareOfficeArtifacts,
  createOfficeArtifactFile,
  editOfficeArtifact,
  inspectOfficeArtifact,
} from '../../server/src/engine/agents/office_artifact_editor.js';

const JSZip = JSZipModule.default || JSZipModule;

async function addPreservationMarker(filePath, marker) {
  const archive = await JSZip.loadAsync(await readFile(filePath));
  archive.file('custom/dsh-preserve.txt', marker);
  await writeFile(filePath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function zipEntry(filePath, entryPath) {
  const archive = await JSZip.loadAsync(await readFile(filePath));
  const entry = archive.file(entryPath);
  assert.ok(entry, `${entryPath} should exist`);
  return entry.async('nodebuffer');
}

async function assertPreservedPackageParts(beforePath, afterPath, stableEntry) {
  assert.equal((await zipEntry(afterPath, 'custom/dsh-preserve.txt')).toString('utf8'), 'keep-this-part');
  assert.deepEqual(await zipEntry(afterPath, stableEntry), await zipEntry(beforePath, stableEntry));
}

test('editable office adapters create, inspect and target-edit five real file formats', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'office-artifact-formats-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const markdownV1 = join(root, 'report-v1.md');
  const markdownV2 = join(root, 'report-v2.md');
  await createOfficeArtifactFile(markdownV1, { format: 'markdown', title: 'Launch', content: 'Status: waiting\n\nOwner: team' });
  const markdown = await inspectOfficeArtifact(markdownV1);
  const statusBlock = markdown.sections.find((section) => section.text === 'Status: waiting');
  assert.ok(statusBlock?.anchor);
  await editOfficeArtifact(markdownV1, markdownV2, [{ type: 'replace_range', anchor: statusBlock.anchor, start: 8, end: 15, text: 'ready' }]);
  assert.equal((await inspectOfficeArtifact(markdownV2)).sections.some((section) => section.text === 'Status: ready'), true);
  const markdownV3 = join(root, 'report-v3.md');
  const markdown2 = await inspectOfficeArtifact(markdownV2);
  const readyBlock = markdown2.sections.find((section) => section.text === 'Status: ready');
  const ownerBlock = markdown2.sections.find((section) => section.text === 'Owner: team');
  await editOfficeArtifact(markdownV2, markdownV3, [
    { type: 'replace_text', anchor: readyBlock.anchor, text: 'Status: ready\n\nGate: passed' },
    { type: 'replace_text', anchor: ownerBlock.anchor, text: 'Owner: release team' },
  ]);
  const markdown3 = await inspectOfficeArtifact(markdownV3);
  assert.equal(markdown3.sections.some((section) => section.text === 'Gate: passed'), true);
  assert.equal(markdown3.sections.some((section) => section.text === 'Owner: release team'), true);

  const docxV1 = join(root, 'document-v1.docx');
  const docxV2 = join(root, 'document-v2.docx');
  await createOfficeArtifactFile(docxV1, { format: 'docx', title: 'Launch report', content: 'Status is waiting.\n\nOwner is team.' });
  await addPreservationMarker(docxV1, 'keep-this-part');
  const docx = await inspectOfficeArtifact(docxV1);
  const docxParagraph = docx.sections.find((section) => section.kind === 'paragraph' && section.text.includes('waiting'));
  assert.ok(docxParagraph?.anchor);
  await editOfficeArtifact(docxV1, docxV2, [{
    type: 'replace_range',
    anchor: docxParagraph.anchor,
    start: docxParagraph.text.indexOf('waiting'),
    end: docxParagraph.text.indexOf('waiting') + 'waiting'.length,
    text: 'ready',
  }]);
  assert.equal((await inspectOfficeArtifact(docxV2)).sections.some((section) => section.text.includes('Status is ready.')), true);
  await assertPreservedPackageParts(docxV1, docxV2, 'word/styles.xml');

  const xlsxV1 = join(root, 'workbook-v1.xlsx');
  const xlsxV2 = join(root, 'workbook-v2.xlsx');
  await createOfficeArtifactFile(xlsxV1, {
    format: 'xlsx',
    sheets: [{ name: 'Summary', rows: [['Item', 'Value'], ['Ready', 2]] }],
  });
  await addPreservationMarker(xlsxV1, 'keep-this-part');
  const xlsx = await inspectOfficeArtifact(xlsxV1);
  assert.equal(xlsx.sections[0].name, 'Summary');
  const readyCell = xlsx.sections[0].cells.find((cell) => cell.address === 'B2');
  assert.equal(readyCell.value, 2);
  await editOfficeArtifact(xlsxV1, xlsxV2, [
    { type: 'set_cell', anchor: readyCell.anchor, value: 3 },
    { type: 'set_cell', sheet: 'Summary', address: 'C2', formula: '=B2*2' },
  ]);
  const editedXlsx = await inspectOfficeArtifact(xlsxV2);
  assert.equal(editedXlsx.sections[0].cells.find((cell) => cell.address === 'B2').value, 3);
  assert.equal(editedXlsx.sections[0].cells.find((cell) => cell.address === 'C2').formula, '=B2*2');
  await assertPreservedPackageParts(xlsxV1, xlsxV2, 'xl/styles.xml');

  const pptxV1 = join(root, 'deck-v1.pptx');
  const pptxV2 = join(root, 'deck-v2.pptx');
  await createOfficeArtifactFile(pptxV1, {
    format: 'pptx',
    title: 'Launch deck',
    slides: [{ title: 'Launch status', body: 'Waiting for approval' }],
  });
  await addPreservationMarker(pptxV1, 'keep-this-part');
  const pptx = await inspectOfficeArtifact(pptxV1);
  const bodyShape = pptx.sections[0].objects.find((object) => object.text.includes('Waiting'));
  assert.ok(bodyShape?.anchor);
  await editOfficeArtifact(pptxV1, pptxV2, [{ type: 'replace_text', anchor: bodyShape.anchor, text: 'Ready for launch' }]);
  assert.equal((await inspectOfficeArtifact(pptxV2)).sections[0].objects.some((object) => object.text === 'Ready for launch'), true);
  await assertPreservedPackageParts(pptxV1, pptxV2, 'ppt/theme/theme1.xml');

  const pdfV1 = join(root, 'document-v1.pdf');
  const pdfV2 = join(root, 'document-v2.pdf');
  await createOfficeArtifactFile(pdfV1, { format: 'pdf', title: '发射报告', content: '已完成检查，可以发射。' });
  const pdf = await inspectOfficeArtifact(pdfV1);
  assert.equal(pdf.sections.length, 1);
  assert.match(pdf.sections[0].text, /发射报告/);
  const pdfEdit = await editOfficeArtifact(pdfV1, pdfV2, [{
    type: 'annotate_region',
    page: 1,
    rect: { x: 0.08, y: 0.08, width: 0.4, height: 0.1 },
    text: '复核这个标题',
    color: '#7c3aed',
  }, {
    type: 'cover_text',
    page: 1,
    rect: { x: 0.08, y: 0.24, width: 0.4, height: 0.06 },
    text: '已确认',
    color: '#7c3aed',
  }]);
  const editedPdf = await inspectOfficeArtifact(pdfV2, { metadata: pdfEdit.metadata });
  assert.equal(editedPdf.sections[0].annotations[0].text, '复核这个标题');
  assert.match(editedPdf.sections[0].text, /已确认/);

  for (const [from, to] of [[markdownV1, markdownV2], [docxV1, docxV2], [xlsxV1, xlsxV2], [pptxV1, pptxV2]]) {
    const diff = await compareOfficeArtifacts(from, to);
    assert.ok(diff.changes.length > 0, `${from} should have semantic changes`);
  }
});
