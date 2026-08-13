import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLUGIN_CATALOG_EVENT_TYPES,
  createPluginCatalogReadyEvent,
  publishPluginCatalogChanged,
  resetPluginCatalogEventsForTests,
  subscribePluginCatalogEvents,
} from '../../server/src/engine/plugins/plugin_catalog_events.js';

test.beforeEach(() => resetPluginCatalogEventsForTests());
test.afterEach(() => resetPluginCatalogEventsForTests());

test('plugin catalog events are user-scoped invalidations with project hints', () => {
  const userA = [];
  const userB = [];
  const all = [];
  const disposeA = subscribePluginCatalogEvents((event) => userA.push(event), { userId: 'user-a' });
  const disposeB = subscribePluginCatalogEvents((event) => userB.push(event), { userId: 'user-b' });
  const disposeAll = subscribePluginCatalogEvents((event) => all.push(event));

  const event = publishPluginCatalogChanged({
    userIds: ['user-a', 'user-b', 'user-a'],
    reason: 'disable',
    canonicalPluginId: 'ask-data@local',
    projectIds: ['project-1', 'project-1', 'project-2'],
  });

  assert.equal(event.type, PLUGIN_CATALOG_EVENT_TYPES.CHANGED);
  assert.equal(userA.length, 1);
  assert.equal(userB.length, 1);
  assert.equal(all.length, 1);
  assert.deepEqual(event.payload.project_ids, ['project-1', 'project-2']);
  assert.equal(event.payload.canonical_plugin_id, 'ask-data@local');
  assert.equal(event.payload.reason, 'disable');

  disposeA();
  disposeB();
  disposeAll();
});

test('plugin catalog stream envelopes carry one server identity and increasing sequence', () => {
  const ready = createPluginCatalogReadyEvent();
  const changed = publishPluginCatalogChanged({
    reason: 'upgrade',
    canonicalPluginId: 'plugin-catalog',
  });

  assert.equal(ready.type, PLUGIN_CATALOG_EVENT_TYPES.READY);
  assert.equal(changed.payload.server_instance_id, ready.payload.server_instance_id);
  assert.equal(changed.payload.seq, ready.payload.seq + 1);
  assert.throws(() => publishPluginCatalogChanged({
    reason: 'other',
    canonicalPluginId: 'ask-data',
  }), /目录变化事件无效/);
});
