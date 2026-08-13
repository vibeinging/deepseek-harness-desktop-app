// DSH Web-profile runtime child.
//
// The App owns only the process boundary. DSH owns the Web profile, ApiProxy,
// HTTP/SSE carrier, session persistence, attachments, and browser client. The
// parent talks to those official loopback routes and sends only lifecycle
// messages to this child.

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareTrustedProfilePlugins } from "./trusted_client_plugins.js";

function ipcError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: error?.code || null,
    stack: error instanceof Error ? error.stack : null,
  };
}

async function main() {
  const profileBootPath = process.env.DSH_PROFILE_BOOT_PATH;
  if (!profileBootPath) throw new Error("缺少 DSH_PROFILE_BOOT_PATH");
  const environmentDir = resolve(process.env.DSH_RUNTIME_ENV_DIR || process.cwd());
  const anchoredRequire = createRequire(pathToFileURL(profileBootPath));
  const appBootPath = process.env.DSH_APP_BOOT_PATH
    || anchoredRequire.resolve("@deepseek-ai/dsh-app-boot");
  const { loadEnv } = await import(pathToFileURL(appBootPath).href);
  const { runProfile } = await import(pathToFileURL(profileBootPath).href);
  const clientPatch = fileURLToPath(new URL("./desktop_web.patch.yml", import.meta.url));
  loadEnv("dsh-work", environmentDir);
  await prepareTrustedProfilePlugins({ appBootPath });
  await runProfile({
    profile: "web",
    patchFiles: [clientPatch],
    args: [],
  });
}

main().catch((error) => {
  process.send?.({ type: "fatal", error: ipcError(error) });
  console.error(`[dsh-runtime] ${error?.stack || error}`);
  process.exit(1);
});
