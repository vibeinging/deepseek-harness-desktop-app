import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Application data root directory.
 *
 * By default uses ~/.dsh.
 * Tests, portable mode, or host embedding can override with DSH_DATA_ROOT.
 */
export function dataRoot() {
  return process.env.DSH_DATA_ROOT
    ? resolve(process.env.DSH_DATA_ROOT)
    : join(homedir(), '.dsh');
}

export function dataPath(...parts) {
  return join(dataRoot(), ...parts);
}

/**
 * Agent configuration home used by the bundled app-server.
 *
 * The bundled Agent runtime belongs to Dsh, so its state lives under the
 * Dsh data root instead of sharing another application's state directory.
 * Tests and portable runs can override it with DSH_AGENT_RUNTIME_HOME.
 */
export function agentRuntimeHome() {
  if (process.env.DSH_AGENT_RUNTIME_HOME) return resolve(process.env.DSH_AGENT_RUNTIME_HOME);
  return dataPath('agent_runtime');
}

/**
 * User-created Skills use Agent's file format, but are owned by Dsh and
 * stored directly below the Dsh data root. They never write to
 * ~/.agents/skills or expose Agent in the user-facing directory name.
 */
export function userSkillsRoot() {
  if (process.env.DSH_SKILLS_ROOT) return resolve(process.env.DSH_SKILLS_ROOT);
  return dataPath('skills');
}
