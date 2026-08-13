import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/paths.js";
import { DshRuntimeClient } from "./client.js";

const leases = new Map();

function leaseRoot(appSessionId) {
  const key = createHash("sha256").update(String(appSessionId || "")).digest("hex");
  return dataPath("temporary-dsh", key);
}

/** Return the process-local DSH lease for one temporary App conversation. */
export function getTemporaryDshRuntimeLease(appSessionId) {
  const id = String(appSessionId || "").trim();
  if (!id) throw new Error("临时 DSH 会话缺少 App 会话 id");
  let lease = leases.get(id);
  if (lease) return lease;
  const root = leaseRoot(id);
  const client = new DshRuntimeClient({
    env: {
      ...process.env,
      DSH_RUNTIME_SESSION_ROOT: join(root, "sessions"),
      DSH_RUNTIME_STORAGE_ROOT: join(root, "storages"),
    },
  });
  lease = { appSessionId: id, root, client, dshSessionId: null, cwd: null };
  leases.set(id, lease);
  return lease;
}

/** Stop and erase one temporary conversation's isolated DSH state. */
export async function disposeTemporaryDshRuntime(appSessionId) {
  const id = String(appSessionId || "").trim();
  if (!id) return false;
  const lease = leases.get(id);
  leases.delete(id);
  await lease?.client.close().catch(() => null);
  await rm(lease?.root || leaseRoot(id), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  return Boolean(lease);
}

/** Stop every temporary DSH child during App shutdown. */
export async function closeTemporaryDshRuntimes() {
  const ids = [...leases.keys()];
  await Promise.allSettled(ids.map((id) => disposeTemporaryDshRuntime(id)));
}
