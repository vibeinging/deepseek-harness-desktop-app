import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DSH_WORKSPACE_PERMISSION_PROFILE,
  withWorkspacePermissionProfile,
  workspacePermissionReadRoots,
} from '../../server/src/engine/agents/workspace_permissions.js';

test('workspace permission profile grants only minimal runtime, workspace writes, and declared capability reads', () => {
  const skill = {};
  Object.defineProperty(skill, '_runtimePath', {
    value: '/opt/dsh/skills/query-project-data/SKILL.md',
    enumerable: false,
  });
  const roots = workspacePermissionReadRoots({
    skills: [skill, { path: '/opt/dsh/skills/reports/SKILL.md' }],
    capabilityRoots: [{ location: { path: '/opt/dsh/plugins/ask-data' } }],
  });
  assert.deepEqual(roots, [
    '/opt/dsh/plugins/ask-data',
    '/opt/dsh/skills/query-project-data',
    '/opt/dsh/skills/reports',
  ]);

  const config = withWorkspacePermissionProfile({ model_reasoning_effort: 'medium' }, {
    readOnlyRoots: roots,
    excludeEnvKeys: ['FOO_PLUGIN_TOKEN', 'CUSTOM_MCP_AUTH'],
  });
  assert.equal(config.default_permissions, DSH_WORKSPACE_PERMISSION_PROFILE);
  assert.equal(config.model_reasoning_effort, 'medium');
  assert.deepEqual(config.shell_environment_policy, {
    inherit: 'core',
    ignore_default_excludes: false,
    exclude: [
      '*PASSWORD*',
      '*PASSWD*',
      '*CREDENTIAL*',
      'DATABASE_URL',
      'PG*',
      'MYSQL*',
      'REDIS_URL',
      'AWS_*',
      'AZURE_*',
      'GOOGLE_*',
      'GITHUB_*',
      'CUSTOM_MCP_AUTH',
      'FOO_PLUGIN_TOKEN',
    ],
    experimental_use_profile: false,
  });
  assert.equal(config.allow_login_shell, false);
  assert.deepEqual(config.permissions[DSH_WORKSPACE_PERMISSION_PROFILE].filesystem, {
    ':minimal': 'read',
    ':workspace_roots': { '.': 'write' },
    '/opt/dsh/plugins/ask-data': 'read',
    '/opt/dsh/skills/query-project-data': 'read',
    '/opt/dsh/skills/reports': 'read',
  });
  assert.equal(':root' in config.permissions[DSH_WORKSPACE_PERMISSION_PROFILE].filesystem, false);
  assert.equal(':tmpdir' in config.permissions[DSH_WORKSPACE_PERMISSION_PROFILE].filesystem, false);
});
