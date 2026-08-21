// In-process ntfy notifier for the standalone runner (replaces the hub's
// Slack sidecar; Slack remains issue #1).
//
// Watches conversation execution_status via the agent-server list endpoint
// and, on a transition INTO a state that needs attention (finished / error /
// stuck / idle-awaiting-input), POSTs a push notification to an ntfy topic
// (https://docs.ntfy.sh — plain HTTP, no account needed).
//
// Configuration is layered:
//   env      OPENHANDS_NTFY_URL (default https://ntfy.sh),
//            OPENHANDS_NTFY_TOPIC, OPENHANDS_NTFY_TOKEN,
//            OPENHANDS_NOTIFY_IDLE (default on)
//   settings the Notifications page persists overrides in agent-canvas
//            misc settings (customizable_dca.openhands_notifications.{enabled,
//            notify_idle, ntfy_url, ntfy_topic}) — those win over env, so
//            the topic can be set entirely from the UI.
import { logger } from "../logger.js";
import type { UpstreamFetch } from "./upstream.js";

export const NOTIFIER_POLL_MS = 10_000;
const SETTINGS_TTL_MS = 60_000;
const MAX_TRACKED = 500;

const NOTIFY_STATES: Record<string, { tag: string; label: string; priority: string }> = {
  finished: { tag: "white_check_mark", label: "finished", priority: "default" },
  error: { tag: "x", label: "errored", priority: "high" },
  stuck: { tag: "warning", label: "stuck", priority: "high" },
  idle: { tag: "speech_balloon", label: "awaiting input", priority: "default" },
};

export interface NtfyEnvConfig {
  url: string;
  topic: string;
  token: string;
  notifyIdle: boolean;
  hubPublicUrl: string;
}

export interface EffectiveNtfyConfig {
  enabled: boolean;
  url: string;
  topic: string;
  token: string;
  notifyIdle: boolean;
}

interface ConversationSummary {
  id?: string;
  title?: string;
  execution_status?: string;
}

/** Merge env config with the (optional) agent-canvas settings blob. */
export function effectiveNtfyConfig(
  env: NtfyEnvConfig,
  settings: Record<string, unknown> | null,
): EffectiveNtfyConfig {
  const prefs = (settings as any)?.misc_settings?.customizable_dca?.openhands_notifications ?? {};
  const url = (typeof prefs.ntfy_url === "string" && prefs.ntfy_url.trim()) || env.url;
  const topic = (typeof prefs.ntfy_topic === "string" && prefs.ntfy_topic.trim()) || env.topic;
  return {
    enabled: prefs.enabled !== false && Boolean(topic),
    url: url.replace(/\/+$/, ""),
    topic,
    token: env.token,
    notifyIdle: prefs.notify_idle === undefined ? env.notifyIdle : prefs.notify_idle !== false,
  };
}

/** POST one message to ntfy. Exported for the /notifications/test route. */
export async function postNtfy(
  cfg: Pick<EffectiveNtfyConfig, "url" | "topic" | "token">,
  input: { title: string; body: string; tag?: string; priority?: string; click?: string },
): Promise<{ ok: boolean; status: number }> {
  const headers: Record<string, string> = {
    Title: input.title,
    Priority: input.priority ?? "default",
  };
  if (input.tag) headers.Tags = input.tag;
  if (input.click) headers.Click = input.click;
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetch(`${cfg.url}/${encodeURIComponent(cfg.topic)}`, {
    method: "POST",
    headers,
    body: input.body,
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.ok, status: res.status };
}

export interface Notifier {
  start(): void;
  stop(): void;
}

export function createNtfyNotifier(input: {
  upstream: UpstreamFetch;
  env: NtfyEnvConfig;
}): Notifier {
  const { upstream, env } = input;
  // id → last seen execution_status. Seeded on the first cycle without
  // notifying, so a restart of this server never replays old transitions.
  const lastStatus = new Map<string, string>();
  let seeded = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let settingsCache: { at: number; value: Record<string, unknown> | null } = { at: 0, value: null };

  async function readSettings(): Promise<Record<string, unknown> | null> {
    if (Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
    try {
      const r = await upstream("/api/settings");
      settingsCache = { at: Date.now(), value: r.ok ? ((await r.json()) as Record<string, unknown>) : null };
    } catch {
      settingsCache = { at: Date.now(), value: null };
    }
    return settingsCache.value;
  }

  async function cycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const cfg = effectiveNtfyConfig(env, await readSettings());
      // Even when disabled, keep tracking statuses so enabling the topic
      // later doesn't replay every historical transition.
      // NOTE: /api/conversations (GET) is a batch-get requiring ?ids=; the
      // list endpoint is /search — same one the BFF's conversation list uses.
      const r = await upstream("/api/conversations/search?limit=100");
      if (!r.ok) return;
      const page = (await r.json()) as { items?: ConversationSummary[] };
      const seen = new Set<string>();
      for (const conv of page.items ?? []) {
        if (!conv.id || typeof conv.execution_status !== "string") continue;
        seen.add(conv.id);
        const prev = lastStatus.get(conv.id);
        lastStatus.set(conv.id, conv.execution_status);
        // Before seeding completes, everything is history — never notify.
        // After seeding, an UNSEEN id is a conversation created since the
        // last cycle: fast runs can reach `finished` within one poll
        // interval, so their very first observation must still notify.
        if (!seeded || prev === conv.execution_status) continue;
        const state = NOTIFY_STATES[conv.execution_status];
        if (!state) continue;
        if (!cfg.enabled) continue;
        if (conv.execution_status === "idle" && !cfg.notifyIdle) continue;
        const title = (conv.title ?? "").trim() || `Conversation ${conv.id.slice(0, 8)}`;
        try {
          const posted = await postNtfy(cfg, {
            title: `OpenHands ${state.label}`,
            body: title,
            tag: state.tag,
            priority: state.priority,
            click: `${env.hubPublicUrl}/openhands/native/conversations/${conv.id}`,
          });
          if (!posted.ok) {
            logger.warn({ status: posted.status, id: conv.id }, "ntfy notify failed");
            // Roll back so the transition is retried next cycle instead of
            // being dropped silently.
            if (prev !== undefined) lastStatus.set(conv.id, prev); else lastStatus.delete(conv.id);
          } else {
            logger.info({ id: conv.id, status: conv.execution_status }, "ntfy notified");
          }
        } catch (err) {
          logger.warn({ err, id: conv.id }, "ntfy notify errored");
          if (prev !== undefined) lastStatus.set(conv.id, prev); else lastStatus.delete(conv.id);
        }
      }
      // Prune deleted conversations; cap the map so it cannot grow unbounded.
      for (const id of lastStatus.keys()) {
        if (!seen.has(id)) lastStatus.delete(id);
        if (lastStatus.size <= MAX_TRACKED) break;
      }
      seeded = true;
    } catch (err) {
      logger.debug({ err }, "ntfy notifier cycle failed");
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void cycle(), NOTIFIER_POLL_MS);
      timer.unref?.();
      void cycle();
      logger.info({ pollMs: NOTIFIER_POLL_MS }, "ntfy notifier started");
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
