import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureDshProductThemeDefault } from "../../server/src/engine/dsh_runtime/theme_default.js";

test("the runtime seeds dark only without a DSH user preference", async () => {
  const calls = [];
  const request = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "settings.describe") {
      return { namespaces: [{ ns: "ui-theme", revision: 4, value: { preference: "system" } }] };
    }
    return { value: { preference: "dark" } };
  };

  assert.equal(await ensureDshProductThemeDefault(request), true);
  assert.deepEqual(calls, [{ method: "settings.describe", payload: {} }, {
    method: "settings.mutate",
    payload: {
      ns: "ui-theme",
      ops: [{ op: "set", path: ["preference"], value: "dark" }],
      expectedRevision: 4,
    },
  }]);
});

test("the runtime preserves every explicit DSH theme preference", async () => {
  for (const preference of ["light", "dark", "system"]) {
    let calls = 0;
    const request = async (method) => {
      calls += 1;
      assert.equal(method, "settings.describe");
      return {
        namespaces: [{
          ns: "ui-theme",
          revision: 2,
          value: { preference },
          user: { preference },
        }],
      };
    };

    assert.equal(await ensureDshProductThemeDefault(request), false);
    assert.equal(calls, 1);
  }
});

test("the runtime rejects a missing official theme namespace", async () => {
  await assert.rejects(
    ensureDshProductThemeDefault(async () => ({ namespaces: [] })),
    { code: "DSH_THEME_SETTINGS_INVALID" },
  );
});
