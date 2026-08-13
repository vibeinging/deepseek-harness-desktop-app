import test from "node:test";
import assert from "node:assert/strict";

import { dshSkillReferenceText } from "../../server/src/engine/dsh_runtime/workspace_runtime.js";

test("compatibility composer selections use DSH native Skill references", () => {
  assert.equal(dshSkillReferenceText({
    skillDecisions: [
      { skill_name: "release-check" },
      { skill_name: "legacy-plugin:document-review" },
      { skill_name: "release-check" },
      { skill_name: "not valid" },
    ],
  }), "<skill>release-check</skill> <skill>document-review</skill>");
});

test("no selected Skill adds no compatibility text", () => {
  assert.equal(dshSkillReferenceText({ skillDecisions: [] }), "");
});
