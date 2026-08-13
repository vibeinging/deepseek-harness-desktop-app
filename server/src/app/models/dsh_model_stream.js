import {
  createDshModelSettingsHeartbeatEvent,
  createDshModelSettingsReadyEvent,
  subscribeDshModelSettingsEvents,
} from "../../engine/dsh_runtime/model_settings_events.js";

export const DSH_MODEL_SETTINGS_HEARTBEAT_MS = 20_000;

// DSH settings, credentials and the model catalog remain authoritative. This
// stream only tells an open renderer to fetch a fresh joined snapshot.
export async function watchDshModelSettingsEvents(ctx, _input, emit) {
  if (typeof emit !== "function") throw new TypeError("DSH 模型设置流缺少 emit");
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

    unsubscribe = subscribeDshModelSettingsEvents(push);
    heartbeat = setInterval(() => push(createDshModelSettingsHeartbeatEvent()), DSH_MODEL_SETTINGS_HEARTBEAT_MS);
    heartbeat.unref?.();
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) {
      close();
      return;
    }
    push(createDshModelSettingsReadyEvent());
  });
}

export default { watchDshModelSettingsEvents };
