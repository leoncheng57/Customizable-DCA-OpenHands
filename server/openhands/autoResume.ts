// server/openhands/autoResume.ts
//
// Automatically resume OpenHands conversations that a dev deployment killed
// mid-run (issue #244). A pod rollout is SIGTERM → 30s → SIGKILL, so an
// in-flight agent loop dies without a clean pause and the conversation sits
// paused/quiescent afterwards — indistinguishable from one that simply ended.
//
// Detection: the agent-server's /server_info exposes `uptime`, so its process
// start time is `now - uptime`. A watcher polls it and, when it observes a NEW
// and RECENT start (a restart), reconciles: every conversation whose status
// implies a loop that no longer exists (`running` / `paused`) and whose
// `updated_at` predates the process start is resumed with POST /run.
//
// Why POST /run and not /goal/resume: our loops are only ever started via
// /run (never /goal), and agent-canvas' /run continues from the persisted
// event log on the PVC rather than redoing completed work, so /goal/resume
// has nothing to resume for these conversations.
//
// Deliberate user pauses must NOT be auto-resumed (they spend tokens and can
// repeat side effects against the user's explicit wish). The BFF's pause
// route records the conversation id under
// `misc_settings.customizable_dca.openhands_user_pauses` in agent-canvas settings —
// persisted on the PVC, so the marker survives the very restart this watcher
// reacts to — and run/message routes clear it. The reconciler skips those ids.
import { logger } from "../logger.js";
import type { UpstreamFetch } from "./upstream.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How often the watcher samples /server_info for a restart. */
export const RESTART_POLL_MS = 60_000;
/**
 * Tolerance applied when comparing `updated_at` against the process start.
 * Covers both clock skew between the BFF and the agent-server and the
 * RollingUpdate overlap window where the old pod can still append events for
 * a short while after the new process has started.
 */
export const CLOCK_SKEW_MS = 3 * 60_000;
/**
 * A conversation is only a restart casualty if it was active shortly before
 * the kill. Anything not updated within this window of the process start is
 * long-dormant and resuming it would spend tokens nobody asked for.
 */
export const MAX_INTERRUPTED_AGE_MS = 24 * 60 * 60_000;
/**
 * Only reconcile against a process start this recent. The first poll after a
 * BFF boot always observes a "new" start; without this gate a BFF-only
 * restart weeks into the agent-server's life would resume old pauses.
 */
export const RECENT_START_MS = 30 * 60_000;
/** Uptime-derived start times jitter by a few seconds between polls. */
const START_CHANGE_TOLERANCE_MS = 2 * 60_000;

export interface ConversationLike {
  id?: unknown;
  execution_status?: unknown;
  updated_at?: unknown;
}

/** Statuses that imply an agent loop was (or should be) alive. */
const RESUMABLE_STATUSES = new Set(["running", "paused"]);

/**
 * Agent-canvas timestamps are Python isoformat and may omit the timezone
 * designator; a naive timestamp is UTC, so parse it as such rather than
 * letting Date fall back to the BFF's local zone.
 */
export function parseUpstreamTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const ms = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Process start derived from /server_info's uptime (seconds). */
export function serverStartMs(uptimeSeconds: unknown, nowMs: number): number | null {
  if (typeof uptimeSeconds !== "number" || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;
  return nowMs - uptimeSeconds * 1_000;
}

/**
 * Whether an observed process start warrants a reconcile: it must be NEW
 * (first observation, or later than the last handled start beyond jitter)
 * and RECENT (see RECENT_START_MS).
 */
export function shouldReconcile(lastStartMs: number | null, startMs: number, nowMs: number): boolean {
  if (nowMs - startMs > RECENT_START_MS) return false;
  if (lastStartMs === null) return true;
  return startMs - lastStartMs > START_CHANGE_TOLERANCE_MS;
}

export type AutoResumeDecision =
  | { action: "resume" }
  | { action: "skip"; reason: "invalid-id" | "status" | "user-paused" | "no-timestamp" | "active-after-restart" | "dormant" };

/**
 * Decide whether a conversation is a restart casualty to resume. Deliberately
 * conservative: terminal states (`finished`/`error`), `waiting_for_confirmation`
 * (legitimately blocked on a human), `idle`, and `stuck` are never touched,
 * and a deliberate user pause is honoured via the persisted marker set.
 */
export function classifyConversation(
  conv: ConversationLike,
  startMs: number,
  userPaused: ReadonlySet<string>,
): AutoResumeDecision {
  const id = typeof conv.id === "string" ? conv.id : "";
  if (!UUID_RE.test(id)) return { action: "skip", reason: "invalid-id" };
  const status = typeof conv.execution_status === "string" ? conv.execution_status : "";
  if (!RESUMABLE_STATUSES.has(status)) return { action: "skip", reason: "status" };
  if (userPaused.has(id.toLowerCase())) return { action: "skip", reason: "user-paused" };
  const updatedMs = parseUpstreamTime(conv.updated_at);
  if (updatedMs === null) return { action: "skip", reason: "no-timestamp" };
  if (updatedMs >= startMs + CLOCK_SKEW_MS) return { action: "skip", reason: "active-after-restart" };
  if (updatedMs < startMs - MAX_INTERRUPTED_AGE_MS) return { action: "skip", reason: "dormant" };
  return { action: "resume" };
}

/** Extract the persisted deliberate-pause markers from agent-canvas settings. */
export function parseUserPauses(settings: unknown): Set<string> {
  const pauses = (settings as {
    misc_settings?: { customizable_dca?: { openhands_user_pauses?: Record<string, unknown> } };
  })?.misc_settings?.customizable_dca?.openhands_user_pauses;
  const ids = new Set<string>();
  if (pauses && typeof pauses === "object") {
    for (const [id, value] of Object.entries(pauses)) {
      if (value && UUID_RE.test(id)) ids.add(id.toLowerCase());
    }
  }
  return ids;
}

export interface ReconcileSummary {
  resumed: string[];
  skipped: Record<string, number>;
  failed: string[];
}

export interface AutoResumer {
  start(): void;
  stop(): void;
  /** One detection sample — exposed for tests. */
  pollOnce(nowMs?: number): Promise<void>;
  /** One reconcile pass against a given process start — exposed for tests. */
  reconcile(startMs: number): Promise<ReconcileSummary>;
}

export function createAutoResumer(opts: { upstream: UpstreamFetch; intervalMs?: number }): AutoResumer {
  const { upstream } = opts;
  const intervalMs = opts.intervalMs ?? RESTART_POLL_MS;
  let lastStartMs: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function reconcile(startMs: number): Promise<ReconcileSummary> {
    // Fail closed on the pause markers: without them a deliberate pause could
    // be resumed against the user's wish, so surface the error and let the
    // next poll retry the whole reconcile instead of guessing.
    const settingsRes = await upstream("/api/settings");
    if (!settingsRes.ok) throw new Error(`settings read failed (${settingsRes.status})`);
    const userPaused = parseUserPauses(await settingsRes.json());

    const listRes = await upstream("/api/conversations/search?limit=100");
    if (!listRes.ok) throw new Error(`conversation list failed (${listRes.status})`);
    const { items = [] } = (await listRes.json()) as { items?: ConversationLike[] };

    const summary: ReconcileSummary = { resumed: [], skipped: {}, failed: [] };
    for (const conv of items) {
      const decision = classifyConversation(conv, startMs, userPaused);
      if (decision.action === "skip") {
        summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
        continue;
      }
      const id = conv.id as string;
      try {
        const r = await upstream(`/api/conversations/${id}/run`, { method: "POST", body: "{}" });
        if (r.ok) summary.resumed.push(id);
        else {
          summary.failed.push(id);
          logger.warn({ id, status: r.status }, "OpenHands auto-resume: /run rejected");
        }
      } catch (err) {
        summary.failed.push(id);
        logger.warn({ err, id }, "OpenHands auto-resume: /run failed");
      }
    }
    return summary;
  }

  async function pollOnce(nowMs = Date.now()): Promise<void> {
    let startMs: number | null = null;
    try {
      const r = await upstream("/server_info");
      if (!r.ok) return; // agent-server not ready — retry next poll
      const info = (await r.json()) as { uptime?: unknown };
      startMs = serverStartMs(info.uptime, nowMs);
    } catch {
      return; // unreachable — retry next poll
    }
    if (startMs === null || !shouldReconcile(lastStartMs, startMs, nowMs)) return;
    try {
      const summary = await reconcile(startMs);
      // Only remember a handled start after a full pass, so a partial failure
      // is retried on the next poll instead of silently dropped.
      lastStartMs = startMs;
      if (summary.resumed.length > 0 || summary.failed.length > 0) {
        logger.info({ ...summary, startMs }, "OpenHands auto-resume: reconciled after agent-server restart");
      }
    } catch (err) {
      logger.warn({ err }, "OpenHands auto-resume: reconcile failed, will retry");
    }
  }

  return {
    start() {
      if (timer) return;
      const tick = () => {
        if (inFlight) return;
        inFlight = true;
        void pollOnce().finally(() => {
          inFlight = false;
        });
      };
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    pollOnce,
    reconcile,
  };
}
