import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");

test("external editor IPC keeps executable selection out of renderer control", () => {
  const handler = main.match(/ipcMain\.handle\('open-in-editor',[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(handler, /requireTrustedRenderer\(event\)/);
  assert.match(handler, /resolveArtifactActionPath\(filePath\)/);
  assert.match(handler, /shell\.openPath\(resolved\)/);
  assert.doesNotMatch(handler, /editorCommand|spawn\s*\(/);
});
