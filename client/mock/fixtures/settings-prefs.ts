// client/mock/fixtures/settings-prefs.ts
//
// The two round-tripping preference surfaces: ntfy push settings and the
// agent-server's context-condensation knobs. Both pages replace their whole
// form state with the PATCH response, so these helpers exist to guarantee the
// echo is a complete object and that the validation a real save would hit is
// still felt in the demo (saving keepFirst >= maxSize/2 must fail here too,
// or the demo teaches a rule the product does not have).
//
// Nothing is sent anywhere. The ntfy target below is deliberately a `.invalid`
// host — reserved by RFC 6761 precisely so it can never resolve — because the
// Notifications page says "check your subscribed device" after a test, and the
// only honest way to say that in a browser-only build is to name an endpoint
// that visibly does not exist.
import type { AgentSettings, CondenserSettings, NotificationSettings } from "../../lib/api.js";

/** Invented signed-in identity for the demo session. */
export const DEMO_USER_EMAIL = "demo.user@example.test";

/**
 * Where a demo "push" would go. `.invalid` never resolves, and the topic
 * spells out what happened, because the page's success line reads
 * "Sent to {url}/{topic} — check your subscribed device."
 */
export const DEMO_NTFY_URL = "https://ntfy.example.invalid";
export const DEMO_NTFY_TEST_TOPIC = "demo-nothing-was-actually-sent";

export function initialNotifications(): NotificationSettings {
  return {
    enabled: true,
    notifyIdle: true,
    mentionMe: true,
    mentionEmails: [DEMO_USER_EMAIL],
    userEmail: DEMO_USER_EMAIL,
    ntfyUrl: DEMO_NTFY_URL,
    ntfyTopic: "openhands-demo-3f9c1a",
    ntfyConfigured: true,
    // Set in-app rather than inherited from a .env, so the page does not
    // render a "(from .env)" label for a file that does not exist here.
    ntfyFromEnv: false,
  };
}

/** Mirrors NTFY_TOPIC_RE in server/openhands/setup.ts. */
const NTFY_TOPIC_RE = /^[\w.~-]{1,64}$/;
const NTFY_URL_RE = /^https?:\/\/[\w.:-]+$/;

/**
 * Validate a `PATCH /notifications` body and fold it into the current
 * settings. The three booleans are required (the page always sends all
 * three); the ntfy overrides are optional, and an empty string clears them —
 * which upstream means "fall back to the env value", and here means "no topic
 * configured", the state the Tools page's ntfy row reports.
 */
export function applyNotificationsPatch(
  current: NotificationSettings,
  body: unknown,
): { error: string } | { next: NotificationSettings } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be an object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== "boolean" || typeof b.notifyIdle !== "boolean" || typeof b.mentionMe !== "boolean") {
    return { error: "enabled, notifyIdle, and mentionMe must be booleans" };
  }
  if (
    b.ntfyUrl !== undefined &&
    (typeof b.ntfyUrl !== "string" || (b.ntfyUrl !== "" && !NTFY_URL_RE.test(b.ntfyUrl.replace(/\/+$/, ""))))
  ) {
    return { error: "ntfyUrl must be an http(s) origin or empty" };
  }
  if (b.ntfyTopic !== undefined && (typeof b.ntfyTopic !== "string" || (b.ntfyTopic !== "" && !NTFY_TOPIC_RE.test(b.ntfyTopic)))) {
    return { error: "ntfyTopic must match [A-Za-z0-9_.~-]{1,64} or be empty" };
  }

  const ntfyUrl = b.ntfyUrl === undefined ? current.ntfyUrl : (b.ntfyUrl as string).replace(/\/+$/, "");
  const ntfyTopic = b.ntfyTopic === undefined ? current.ntfyTopic : (b.ntfyTopic as string);
  return {
    next: {
      ...current,
      enabled: b.enabled,
      notifyIdle: b.notifyIdle,
      mentionMe: b.mentionMe,
      mentionEmails: b.mentionMe ? [current.userEmail] : [],
      ntfyUrl,
      ntfyTopic,
      ntfyConfigured: Boolean(ntfyTopic),
      ntfyFromEnv: false,
    },
  };
}

// ── Condenser ───────────────────────────────────────────────────────────────
// Bounds copied from server/openhands/agentSettings.ts so a save that the real
// BFF would reject is rejected here too.
const MAX_TOKENS_MIN = 10_000;
const MAX_TOKENS_MAX = 500_000;
const MAX_SIZE_MIN = 20;
const MAX_SIZE_MAX = 1_000;

export function initialAgentSettings(): AgentSettings {
  return {
    condenser: {
      enabled: true,
      maxSize: 240,
      // The value scripts/dev.sh seeds on first boot — issue #48's
      // recommendation, so the demo opens on the configuration the docs argue for.
      maxTokens: 80_000,
      keepFirst: 2,
    },
  };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validate a partial camelCase condenser patch against the state it would
 * produce. The cross-field check is the reason this is not a spread: a
 * keepFirst that leaves the condenser no room to work would break every future
 * run, and upstream enforces the same invariant.
 */
export function applyCondenserPatch(
  current: CondenserSettings,
  body: unknown,
): { error: string } | { next: CondenserSettings } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const next: CondenserSettings = { ...current };
  let touched = false;

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { error: "enabled must be a boolean" };
    next.enabled = b.enabled;
    touched = true;
  }
  if (b.maxTokens !== undefined) {
    if (b.maxTokens !== null && (!isInt(b.maxTokens) || b.maxTokens < MAX_TOKENS_MIN || b.maxTokens > MAX_TOKENS_MAX)) {
      return { error: `maxTokens must be null or an integer between ${MAX_TOKENS_MIN} and ${MAX_TOKENS_MAX}` };
    }
    next.maxTokens = b.maxTokens as number | null;
    touched = true;
  }
  if (b.maxSize !== undefined) {
    if (!isInt(b.maxSize) || b.maxSize < MAX_SIZE_MIN || b.maxSize > MAX_SIZE_MAX) {
      return { error: `maxSize must be an integer between ${MAX_SIZE_MIN} and ${MAX_SIZE_MAX}` };
    }
    next.maxSize = b.maxSize;
    touched = true;
  }
  if (b.keepFirst !== undefined) {
    if (!isInt(b.keepFirst) || b.keepFirst < 1) return { error: "keepFirst must be an integer >= 1" };
    next.keepFirst = b.keepFirst;
    touched = true;
  }
  if (!touched) return { error: "no recognized fields in patch (enabled, maxTokens, maxSize, keepFirst)" };
  if (next.keepFirst >= next.maxSize / 2) {
    return { error: `keepFirst (${next.keepFirst}) must be less than half of maxSize (${next.maxSize})` };
  }
  return { next };
}
