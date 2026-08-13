/**
 * Host capabilities required by portable system Skills.
 *
 * Agent Runtime owns the Skill files, while Dsh owns the executable tools.
 * Keeping this mapping in the Host lets the catalog distinguish "installed"
 * from "runnable" without changing upstream Skill packages.
 */
const CONTRACTS = Object.freeze({
  imagegen: Object.freeze({
    tool_dependencies: Object.freeze(["image_gen"]),
    side_effect: "write",
  }),
});

export function builtinHostSkillContract(skillName) {
  const contract = CONTRACTS[String(skillName || "")] || null;
  if (!contract) return null;
  return {
    ...contract,
    tool_dependencies: [...contract.tool_dependencies],
  };
}

export default { builtinHostSkillContract };
