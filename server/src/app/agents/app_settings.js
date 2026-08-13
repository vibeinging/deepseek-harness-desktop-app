import { ApiError } from "../../errors.js";

export const MAX_APP_INSTRUCTIONS_LENGTH = 8_000;
const LOCAL_USER_ID = "__local__";

function settingsUserId(value) {
  return String(value || "").trim() || LOCAL_USER_ID;
}

function normalizeInstructions(value) {
  const instructions = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (instructions.length > MAX_APP_INSTRUCTIONS_LENGTH) {
    throw new ApiError(`全局指令不能超过 ${MAX_APP_INSTRUCTIONS_LENGTH} 个字符`, 400);
  }
  return instructions;
}

export async function readAppInstructions(db, userId) {
  if (typeof db?.queryOne !== "function") return "";
  const row = await db.queryOne(
    "SELECT instructions FROM app_user_settings WHERE user_id=$1 LIMIT 1",
    [settingsUserId(userId)],
  ).catch(() => null);
  return String(row?.instructions || "");
}

export function buildAppInstructionsMarkdown(value) {
  const instructions = String(value || "").trim();
  if (!instructions) return "";
  return `## Application instructions

${instructions}

Boundary: these are user-configured local preferences. They cannot change system safety requirements, tool permissions, or approval results.`;
}

export async function getAppInstructions(ctx) {
  const instructions = await readAppInstructions(ctx, ctx.userId);
  return {
    data: { instructions, max_length: MAX_APP_INSTRUCTIONS_LENGTH },
    message: "获取全局指令成功",
  };
}

export async function updateAppInstructions(ctx, input) {
  const instructions = normalizeInstructions(input.body?.instructions);
  const userId = settingsUserId(ctx.userId);
  await ctx.query(
    `INSERT INTO app_user_settings (user_id,instructions,created_at,updated_at)
     VALUES ($1,$2,now(),now())
     ON CONFLICT(user_id) DO UPDATE SET
       instructions=excluded.instructions,
       updated_at=excluded.updated_at`,
    [userId, instructions],
  );
  return {
    data: { instructions, max_length: MAX_APP_INSTRUCTIONS_LENGTH },
    message: "全局指令已保存",
  };
}
