import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "https://github.com/openai/codex.git";
const TAG = "rust-v0.147.0";
const COMMIT = "be6e8eac029b183056b7e4402879f15d2c85f61b";
const target = join(APP_DIR, ".desktop-build", "vendor-runtime-source", TAG);

function run(args, options = {}) {
  const result = spawnSync("git", args, { cwd: APP_DIR, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`git ${args.join(" ")} 执行失败${detail ? `：${detail}` : ""}`);
  }
  return options.capture ? String(result.stdout || "").trim() : "";
}

if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true });
  run(["clone", "--depth", "1", "--branch", TAG, "--single-branch", REPOSITORY, target]);
}

const actual = run(["-C", target, "rev-parse", "HEAD"], { capture: true });
if (actual !== COMMIT) {
  throw new Error(`上游运行时源码提交不匹配：期望 ${COMMIT}，实际 ${actual}`);
}

console.log(`[vendor-runtime-source] ${TAG} ${actual}`);
console.log(`[vendor-runtime-source] ${target}`);
