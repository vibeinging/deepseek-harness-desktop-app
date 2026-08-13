import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentRuntimeHome } from '../../server/src/config/paths.js';
import {
  enrichSkillAvailability,
  executableAvailable,
  isRuntimePluginCacheSkillPath,
} from '../../server/src/engine/agents/skill_registry.js';

function externalSkill(overrides = {}) {
  return {
    name: 'external-example',
    source: 'agent_user',
    machine_external: true,
    effective_enabled: true,
    availability: 'enabled',
    allow_implicit_invocation: true,
    required_tools: [],
    required_bins: [],
    ...overrides,
  };
}

test('Agent user-scope Skills remain runnable when Codex reports them enabled', async () => {
  const [skill] = await enrichSkillAvailability([externalSkill()], null, null, { env: { PATH: '' } });
  assert.equal(skill.availability, 'enabled');
  assert.equal(skill.can_run, true);
  assert.equal(skill.allow_implicit_invocation, true);
  assert.equal(skill.availability_reason, '');
});

test('availability enrichment never mutates an immutable Plugin Skill snapshot', async () => {
  const frozen = Object.freeze(externalSkill({
    availability: 'disabled',
    availability_reason: 'stale snapshot value',
    can_run: false,
  }));

  const [skill] = await enrichSkillAvailability([frozen], null, null, { env: { PATH: '' } });

  assert.notEqual(skill, frozen);
  assert.equal(skill.availability, 'enabled');
  assert.equal(skill.availability_reason, '');
  assert.equal(skill.can_run, true);
  assert.equal(frozen.availability, 'disabled');
  assert.equal(frozen.availability_reason, 'stale snapshot value');
  assert.equal(frozen.can_run, false);
});

test('declared binary requirements fail before the unverified state', async () => {
  const [skill] = await enrichSkillAvailability([
    externalSkill({ required_bins: ['definitely-missing-dsh-cli'] }),
  ], null, null, { env: { PATH: '' } });
  assert.equal(skill.availability, 'unavailable');
  assert.equal(skill.can_run, false);
  assert.match(skill.availability_reason, /缺少本机命令: definitely-missing-dsh-cli/);
});

test('a satisfied CLI dependency keeps an Agent user-scope Skill runnable', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-skill-bin-'));
  const windows = process.platform === 'win32';
  const binName = windows ? 'external-check.CMD' : 'external-check';
  const binPath = join(temp, binName);
  try {
    await writeFile(binPath, windows ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
    if (!windows) await chmod(binPath, 0o755);
    const env = { PATH: temp, ...(windows ? { PATHEXT: '.CMD' } : {}) };
    assert.equal(executableAvailable('external-check', { env, platform: process.platform }), true);
    const [skill] = await enrichSkillAvailability([
      externalSkill({ required_bins: ['external-check'] }),
    ], null, null, { env, platform: process.platform });
    assert.equal(skill.availability, 'enabled');
    assert.equal(skill.can_run, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a Skill that requires MCP is blocked until that exact server is configured', async () => {
  const required = externalSkill({ required_mcp_servers: ['google-drive'] });
  const [missing] = await enrichSkillAvailability([structuredClone(required)], null, null, {
    env: { PATH: '' },
    availableMcpServers: new Set(),
  });
  assert.equal(missing.availability, 'configuration_required');
  assert.equal(missing.can_run, false);
  assert.match(missing.availability_reason, /google-drive/);

  const [available] = await enrichSkillAvailability([structuredClone(required)], null, null, {
    env: { PATH: '' },
    availableMcpServers: new Set(['google-drive']),
  });
  assert.equal(available.availability, 'enabled');
  assert.equal(available.can_run, true);
});

test('Host tool requirements control availability without depending on a Skill name', async () => {
  const required = externalSkill({
    name: 'custom-art-studio',
    required_tools: ['image_gen'],
  });
  const calls = [];
  const [missing] = await enrichSkillAvailability([structuredClone(required)], {
    async queryOne(sql, params) {
      calls.push({ sql, params });
      return null;
    },
  }, 'project-1', { env: { PATH: '' } });
  assert.equal(missing.availability, 'unavailable');
  assert.match(missing.availability_reason, /图片生成模型/);
  assert.deepEqual(calls[0].params, ['IMAGE', 'project-1']);

  const [available] = await enrichSkillAvailability([structuredClone(required)], {
    async queryOne() {
      return { id: 'image-model-1' };
    },
  }, 'project-1', { env: { PATH: '' } });
  assert.equal(available.availability, 'enabled');
  assert.equal(available.can_run, true);
});

test('runtime Plugin cache Skills are excluded from the ordinary Skill catalog', () => {
  assert.equal(isRuntimePluginCacheSkillPath(join(agentRuntimeHome(), 'plugins', 'cache', 'gmail', 'skills', 'search', 'SKILL.md')), true);
  assert.equal(isRuntimePluginCacheSkillPath(join(agentRuntimeHome(), '.tmp', 'plugins', 'gmail', 'skills', 'search', 'SKILL.md')), true);
  assert.equal(isRuntimePluginCacheSkillPath(join(agentRuntimeHome(), 'skills', 'custom', 'SKILL.md')), false);
});
