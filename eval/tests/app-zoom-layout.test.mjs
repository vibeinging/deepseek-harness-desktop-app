import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..', '..');
const readAppFile = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8');

test('agent app zoom uses transform-based compensation instead of CSS zoom', () => {
  const settings = readAppFile('renderer', 'src', 'views', 'agent', 'AgentSettings.tsx');
  const theme = readAppFile('renderer', 'src', 'views', 'agent', 'agent-theme.scss');

  assert.doesNotMatch(settings, /style\.zoom|\.zoom\s*=/);
  assert.match(settings, /removeProperty\('zoom'\)/);
  assert.match(theme, /width:\s*calc\(100%\s*\/\s*var\(--dsh-zoom,\s*1\)\)/);
  assert.match(theme, /height:\s*calc\(100%\s*\/\s*var\(--dsh-zoom,\s*1\)\)/);
  assert.match(theme, /transform:\s*scale\(var\(--dsh-zoom,\s*1\)\)/);
  assert.match(theme, /transform-origin:\s*0 0/);
});

test('electron shell disables native page zoom so app zoom has one owner', () => {
  const main = readAppFile('electron', 'main.js');

  assert.doesNotMatch(main, /role:\s*['"](resetZoom|zoomIn|zoomOut)['"]/);
  assert.match(main, /function lockPageZoom/);
  assert.match(main, /setZoomLevel\(0\)/);
  assert.match(main, /setZoomFactor\(1\)/);
  assert.match(main, /setVisualZoomLevelLimits\(1,\s*1\)/);
});
