import {
  createPluginCatalogHeartbeatEvent,
  createPluginCatalogReadyEvent,
  subscribePluginCatalogEvents,
} from "../../engine/plugins/plugin_catalog_events.js";

export const PLUGIN_CATALOG_HEARTBEAT_MS = 20_000;

// This stream only invalidates renderer snapshots. Installed catalog and
// project mount snapshots remain the authoritative state.
export async function watchAgentPluginCatalogEvents(ctx, _input, emit) {
  if (typeof emit !== "function") throw new TypeError("Plugin 目录流缺少 emit");
  const signal = ctx?.signal;
  if (signal?.aborted) return;

  await new Promise((resolve) => {
    let closed = false;
    let heartbeat = null;
    let unsubscribe = () => {};

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      signal?.removeEventListener("abort", close);
      resolve();
    };
    const push = (event) => {
      if (closed) return;
      try {
        emit(event);
      } catch {
        close();
      }
    };

    unsubscribe = subscribePluginCatalogEvents(push, { userId: ctx?.userId || null });
    heartbeat = setInterval(() => push(createPluginCatalogHeartbeatEvent()), PLUGIN_CATALOG_HEARTBEAT_MS);
    heartbeat.unref?.();
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) {
      close();
      return;
    }
    push(createPluginCatalogReadyEvent());
  });
}

export default { watchAgentPluginCatalogEvents };
