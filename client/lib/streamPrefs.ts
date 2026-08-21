// Live-token-stream preferences + reconnect policy (issues #48 / #58).
//
// The stream is a pure UX affordance on top of the 3s poll, so it must never
// be able to make things worse than poll-only. Two guards live here:
//
//  1. A per-browser kill switch (localStorage, toggled on the Agent-settings
//     page) — one-click recovery if streaming ever misbehaves, no code change
//     or restart needed.
//  2. A bounded reconnect schedule. EventSource auto-retries forever by
//     default; when the BFF restarts (tsx watch reloads on every save of the
//     live checkout) those retries from many tabs pile into the browser's
//     ~6-connections-per-origin pool and starve every page load. We take over
//     retrying with short exponential backoff and then give up — the poll
//     keeps the transcript fully functional.

const STORAGE_KEY = "openhands.stream.v1";

/** Whether live token streaming is enabled in this browser (default: on). */
export function loadStreamEnabled(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveStreamEnabled(enabled: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* private mode etc. — preference just won't stick */
  }
}

const RETRY_BASE_MS = 2_000;
export const STREAM_MAX_RETRIES = 3;

/**
 * Delay before reconnect attempt number `retries` (0-based), or null once the
 * attempts are exhausted: 2s, 4s, 8s, give up.
 */
export function streamRetryDelay(retries: number): number | null {
  if (retries >= STREAM_MAX_RETRIES) return null;
  return RETRY_BASE_MS * 2 ** retries;
}
