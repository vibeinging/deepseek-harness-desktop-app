import { isAbsolute, relative, resolve } from 'node:path'

function normalized(value) {
  return String(value || '').trim()
}

function isInside(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export function inspectIsolatedTestEnvironment(env = process.env) {
  const dataRoot = normalized(env.DSH_DATA_ROOT)
  const paths = {
    DB_SQLITE_PATH: normalized(env.DB_SQLITE_PATH),
    DSH_AGENT_RUNTIME_HOME: normalized(env.DSH_AGENT_RUNTIME_HOME),
    DSH_SKILLS_ROOT: normalized(env.DSH_SKILLS_ROOT),
  }
  const missing = Object.entries(paths)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (!dataRoot) missing.unshift('DSH_DATA_ROOT')

  const outsideDataRoot = dataRoot
    ? Object.entries(paths)
      .filter(([, value]) => value && !isInside(dataRoot, value))
      .map(([key]) => key)
    : []

  return {
    isolated: env.DSH_TEST_ISOLATED === '1' && missing.length === 0 && outsideDataRoot.length === 0,
    markerPresent: env.DSH_TEST_ISOLATED === '1',
    missing,
    outsideDataRoot,
  }
}

export function requireIsolatedTestEnvironment(testFile, env = process.env) {
  const result = inspectIsolatedTestEnvironment(env)
  if (result.isolated) return result

  const reasons = [
    !result.markerPresent ? 'DSH_TEST_ISOLATED is not set' : '',
    result.missing.length > 0 ? `missing ${result.missing.join(', ')}` : '',
    result.outsideDataRoot.length > 0
      ? `outside DSH_DATA_ROOT: ${result.outsideDataRoot.join(', ')}`
      : '',
  ].filter(Boolean)
  const error = new Error(
    `${testFile} requires isolated test storage (${reasons.join('; ')}). `
      + 'Run it with: node --import ./eval/tests/setup.mjs --test <test-file>',
  )
  error.code = 'TEST_ENVIRONMENT_NOT_ISOLATED'
  throw error
}
