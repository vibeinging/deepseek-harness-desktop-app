'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');

const PORT_FILE_VERSION = 1;
const MIN_RANDOM_PORT = 20_000;
const MAX_RANDOM_PORT = 60_000;
const MIN_CONFIGURED_PORT = 1_024;
const MAX_CONFIGURED_PORT = 65_535;

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= MIN_CONFIGURED_PORT && port <= MAX_CONFIGURED_PORT
    ? port
    : null;
}

function writePortFile(filePath, port) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: PORT_FILE_VERSION, port }, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Keep the embedded DSH Client on one loopback origin across app launches.
 * Chromium storage is origin-scoped, so an OS-assigned port would otherwise
 * make local renderer state disappear after every restart.
 */
function loadOrCreateRendererSurfacePort({
  userDataPath,
  env = process.env,
  choosePort = () => randomInt(MIN_RANDOM_PORT, MAX_RANDOM_PORT),
} = {}) {
  const configured = String(env.DSH_DESKTOP_WEB_PORT || '').trim();
  if (configured) {
    const port = normalizePort(configured);
    if (port === null) throw new Error('DSH_DESKTOP_WEB_PORT 必须是 1024 到 65535 之间的整数');
    return port;
  }

  const filePath = path.join(path.resolve(userDataPath), 'renderer-surface-port.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const port = parsed?.version === PORT_FILE_VERSION ? normalizePort(parsed.port) : null;
    if (port !== null) return port;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const port = normalizePort(choosePort());
  if (port === null) throw new Error('生成的 DSH Client 端口无效');
  writePortFile(filePath, port);
  return port;
}

module.exports = {
  loadOrCreateRendererSurfacePort,
  normalizePort,
};
