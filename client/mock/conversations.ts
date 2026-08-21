// client/mock/conversations.ts
//
// OWNER: the conversations group. Read ./types.ts first — it is the contract.
//
// Endpoints this group owns (paths are already stripped of the deploy base and
// the `/api/openhands` prefix):
//
//   GET    /status                                       → OpenHandsStatus
//   GET    /conversations                                → { items: ConversationSummary[] }
//   POST   /conversations                                → { id, started }
//   GET    /conversations/:id                            → ConversationSummary
//   DELETE /conversations/:id                            → unknown (the UI ignores the body)
//   GET    /conversations/:id/events                     → { items: RawOpenHandsEvent[]; next_page_id: string | null }
//   POST   /conversations/:id/messages                   → unknown
//   POST   /conversations/:id/run                        → unknown
//   POST   /conversations/:id/pause                      → unknown
//   POST   /conversations/:id/mode                       → { mode: "build" | "plan"; notified: boolean }
//   POST   /conversations/:id/respond_to_confirmation    → unknown
//   GET    /conversations/:id/agent_final_response       → string | null
//   SSE    GET /conversations/:id/stream                 → `streams`, named frames: delta / reasoning / event
//
// NOT this group: `/conversations/:id/preview/*` belongs to ./workspace.ts.
//
// ---------------------------------------------------------------------------
// How the demo stays alive without a backend
// ---------------------------------------------------------------------------
//
// Five conversations. Four are static fixtures (./fixtures/seeds.ts) covering
// the states the hub needs to look real: finished, running, paused, and an
// untitled one that errored. The fifth is SCRIPTED — ./timeline.ts holds a
// plan-mode bug fix as a list of raw events on a clock, and this file just
// slices it at "now".
//
// There is no push machinery and no timer here. Conversation.tsx already polls
// `GET /conversations/:id/events` every 3s and stops once `execution_status` is
// terminal, so a pure elapsed-time → events function is all it takes for the
// story to animate itself, pause when the visitor pauses it, and stop when the
// agent finishes. Everything that has to survive a click — the run clock, an
// appended follow-up, a mode switch, a deletion — lives in ./state.ts.
//
// The scripted run starts on the first read of the CONVERSATION, not of the
// list: the hub shows it `idle` until it is opened, so a visitor who browses
// the docs for five minutes first still gets the whole story from the top.
//
// ---------------------------------------------------------------------------
// The two places this file deliberately does not pretend
// ---------------------------------------------------------------------------
//
//  · There is no agent, so a follow-up cannot be answered. Rather than
//    inventing a plausible-looking reply to an arbitrary question, the mock
//    says what it is and points at the scripted run. ./types.ts asks the same
//    of `POST /notifications/test`: a demo that claims work it did not do is
//    worse than a demo that admits the boundary.
//  · Rejecting a gated write parks the run at `paused` with the write still
//    pending, instead of scripting the agent's reaction to a rejection.
//    Pressing Run re-arms the gate.
import type { ChatImage } from "../../server/openhands/images.js";
import { PLAN_APPROVED_MESSAGE } from "../../server/openhands/planMode.js";
import type { ConversationSummary, OpenHandsStatus } from "../lib/api.js";
import type { RawOpenHandsEvent } from "../lib/events.js";
import type { ConversationStats } from "../lib/statusBar.js";
import { elapsedSeconds, isoAt, isoNow } from "./clock.js";
import { messageEvent, statusEvent } from "./fixtures/events.js";
import { SEEDED_SCENARIOS } from "./fixtures/manager-scenarios.js";
import { seededConversations, type SeededConversation } from "./fixtures/seeds.js";
import { DEMO_MODEL, DEMO_MODELS, DEMO_SERVER_VERSION, LEDGER } from "./fixtures/world.js";
import { demoState } from "./state.js";
import {
  allowWrites,
  approveRun,
  hasStarted,
  newRunProgress,
  pauseRun,
  rejectRun,
  resumeRun,
  runStatus,
  scriptRunMs,
  SCRIPT_FINAL_RESPONSE,
  SCRIPT_TITLE,
  streamingSentence,
  timelineAt,
  type RunProgress,
} from "./timeline.js";
import { MockHttpError, type HandlerGroup, type MockRequest } from "./types.js";

/** The one conversation that plays the scripted run. */
const SCRIPT_ID = "conv-ledger-4821";

/** ConfirmRisky is Plan mode; NeverConfirm is Build. See client/lib/planMode. */
const PLAN_POLICY = { kind: "ConfirmRisky" };
const BUILD_POLICY = { kind: "NeverConfirm" };

// ── State ────────────────────────────────────────────────────────────────────

/** One event appended after page load, and when it becomes visible. */
interface Appended {
  /** Epoch from which the events route includes it — a small reveal delay. */
  visibleAt: number;
  event: RawOpenHandsEvent;
}

interface DemoConversation {
  /** Static fields. `execution_status` / `stats` are recomputed per read. */
  base: ConversationSummary;
  /** Fixture transcript, chronological. */
  events: RawOpenHandsEvent[];
  /** Follow-ups, replies and status flips produced by the visitor's clicks. */
  appended: Appended[];
  finalResponse: string | null;
  /** Present only on the scripted conversation. */
  progress: RunProgress | null;
  deleted: boolean;
}

interface Store {
  byId: Map<string, DemoConversation>;
  /** Monotonic counter behind generated conversation and event ids. */
  seq: number;
}

function scriptedConversation(): DemoConversation {
  return {
    base: {
      id: SCRIPT_ID,
      title: SCRIPT_TITLE,
      execution_status: "idle",
      created_at: isoAt(0),
      updated_at: isoAt(0),
      metrics: null,
      stats: null,
      agent: { llm: { model: DEMO_MODEL } },
      workspace: { working_dir: LEDGER.dir },
      confirmation_policy: PLAN_POLICY,
    },
    events: [],
    appended: [],
    finalResponse: SCRIPT_FINAL_RESPONSE,
    progress: newRunProgress(),
    deleted: false,
  };
}

function fromSeed(seed: SeededConversation): DemoConversation {
  return {
    base: seed.summary,
    events: seed.events,
    appended: [],
    finalResponse: seed.finalResponse,
    progress: null,
    deleted: false,
  };
}

/**
 * Give every manager/worker link a real destination. The manager fixtures own
 * those ids, while this group owns conversation reads; deriving the rows here
 * keeps the Hub grouping and board links coherent without duplicating ids.
 */
function managerLinkedConversations(): DemoConversation[] {
  const linked: DemoConversation[] = [];
  let offset = 0;

  for (const scenario of SEEDED_SCENARIOS) {
    const workingDir = `/workspace/${scenario.projectPath?.split("/").pop() ?? "project"}`;
    const managerStamp = isoAt(-(90 + offset) * 60_000);
    linked.push({
      base: {
        id: scenario.managerConversationId,
        title: `${scenario.title} — manager`,
        execution_status: "idle",
        created_at: managerStamp,
        updated_at: managerStamp,
        metrics: null,
        stats: stats(0.42, 12_400),
        agent: { llm: { model: scenario.defaultWorkerModel } },
        workspace: { working_dir: workingDir },
        confirmation_policy: BUILD_POLICY,
      },
      events: [
        messageEvent({
          id: `${scenario.managerConversationId}-goal`,
          timestamp: managerStamp,
          role: "user",
          text: scenario.goal,
        }),
        messageEvent({
          id: `${scenario.managerConversationId}-state`,
          timestamp: isoAt(-(89 + offset) * 60_000),
          role: "assistant",
          text: "This simulated manager transcript is summarized on the Manager Runs board, where its plan, workers, gates, and activity log remain interactive.",
        }),
        statusEvent(`${scenario.managerConversationId}-idle`, isoAt(-(88 + offset) * 60_000), "idle"),
      ],
      appended: [],
      finalResponse: null,
      progress: null,
      deleted: false,
    });

    for (const worker of scenario.workers) {
      const workerStamp = isoAt(-(70 + offset) * 60_000);
      const latest = worker.steps[worker.steps.length - 1];
      const executionStatus = latest?.executionStatus ?? (latest?.phase === "done" ? "finished" : "running");
      linked.push({
        base: {
          id: worker.conversationId,
          title: worker.task,
          execution_status: executionStatus,
          created_at: workerStamp,
          updated_at: workerStamp,
          metrics: null,
          stats: stats(0.18, 7_800),
          agent: { llm: { model: worker.model ?? scenario.defaultWorkerModel } },
          workspace: { working_dir: workingDir },
          confirmation_policy: BUILD_POLICY,
        },
        events: [
          messageEvent({
            id: `${worker.conversationId}-task`,
            timestamp: workerStamp,
            role: "user",
            text: `${worker.task}\n\nContract: ${worker.contract}`,
          }),
          messageEvent({
            id: `${worker.conversationId}-state`,
            timestamp: isoAt(-(69 + offset) * 60_000),
            role: "assistant",
            text: latest?.message ?? "Progress for this simulated worker is tracked on the Manager Runs board.",
          }),
          statusEvent(`${worker.conversationId}-status`, isoAt(-(68 + offset) * 60_000), executionStatus),
        ],
        appended: [],
        finalResponse: executionStatus === "finished" ? latest?.message ?? "Worker finished." : null,
        progress: null,
        deleted: false,
      });
    }
    offset += 6;
  }

  return linked;
}

function store(): Store {
  return demoState.ensure("conversations:store", () => {
    const byId = new Map<string, DemoConversation>();
    byId.set(SCRIPT_ID, scriptedConversation());
    for (const seed of seededConversations()) byId.set(seed.summary.id, fromSeed(seed));
    for (const conv of managerLinkedConversations()) byId.set(conv.base.id, conv);
    return { byId, seq: 0 };
  });
}

function nextId(prefix: string): string {
  const s = store();
  s.seq += 1;
  return `${prefix}-${String(s.seq).padStart(4, "0")}`;
}

function find(req: MockRequest): DemoConversation {
  const conv = store().byId.get(req.params.id);
  if (!conv || conv.deleted) throw new MockHttpError(404, "Conversation not found");
  return conv;
}

// ── Deriving a conversation's current shape ──────────────────────────────────

/**
 * Start the scripted run the first time its conversation is actually opened.
 * The hub's list read deliberately does not call this.
 */
function touch(conv: DemoConversation, now: number): void {
  if (conv.progress && !hasStarted(conv.progress)) conv.progress = resumeRun(conv.progress, now);
}

/** Fixture transcript plus everything appended and already revealed. */
function visibleEvents(conv: DemoConversation, now: number): RawOpenHandsEvent[] {
  const appended = conv.appended.filter((a) => a.visibleAt <= now).map((a) => a.event);
  return sortByTime([...scriptedEvents(conv, now), ...conv.events, ...appended]);
}

/**
 * The scripted slice, or nothing at all before the run has been started.
 *
 * The guard matters: `originEpoch` is 0 until the first `resumeRun`, so
 * without it an unopened scripted conversation would report its t=0 event
 * stamped at the epoch — which is both a visible 1970 timestamp and enough to
 * sort the row to the bottom of the hub list.
 */
function scriptedEvents(conv: DemoConversation, now: number): RawOpenHandsEvent[] {
  if (!conv.progress || !hasStarted(conv.progress)) return [];
  return timelineAt(scriptRunMs(conv.progress, now), conv.progress.originEpoch, {
    gateDisarmed: conv.progress.gateSkipped,
  }).events;
}

/**
 * Chronological order, ties broken by id — the same rule mergeRawEvents() uses
 * on the client, so a page boundary can never reorder rows on arrival.
 */
function sortByTime(events: RawOpenHandsEvent[]): RawOpenHandsEvent[] {
  return [...events].sort(
    (a, b) =>
      (a.timestamp ?? "").localeCompare(b.timestamp ?? "") ||
      String(a.id ?? "").localeCompare(String(b.id ?? "")),
  );
}

/**
 * `execution_status` for a static conversation: whatever the newest status
 * event in its transcript says. Run / Pause append one of those, so the pill,
 * the transcript separator and the polling cadence all move together.
 */
function statusFromEvents(conv: DemoConversation, events: RawOpenHandsEvent[]): string {
  let status = conv.base.execution_status;
  for (const e of events) {
    if (e.kind === "ConversationStateUpdateEvent" && e.key === "execution_status") {
      status = String(e.value ?? status);
    }
  }
  return status;
}

/** Per-LLM usage in the shape client/lib/statusBar.ts reads. */
function stats(cost: number, turnTokens: number): ConversationStats {
  return {
    usage_to_metrics: {
      default: {
        model_name: DEMO_MODEL,
        accumulated_cost: cost,
        token_usages: [
          {
            prompt_tokens: Math.round(turnTokens * 0.92),
            completion_tokens: Math.round(turnTokens * 0.08),
            per_turn_token: turnTokens,
            context_window: 200_000,
          },
        ],
      },
    },
  };
}

function summaryOf(conv: DemoConversation, now: number): ConversationSummary {
  const events = visibleEvents(conv, now);
  const newest = events[events.length - 1]?.timestamp;
  if (conv.progress) {
    const started = hasStarted(conv.progress);
    const snapshot = timelineAt(scriptRunMs(conv.progress, now), conv.progress.originEpoch, {
      gateDisarmed: conv.progress.gateSkipped,
    });
    return {
      ...conv.base,
      execution_status: runStatus(conv.progress, now),
      created_at: started ? new Date(conv.progress.originEpoch).toISOString() : conv.base.created_at,
      updated_at: newest ?? conv.base.updated_at,
      // An unstarted run has spent nothing; the status bar should say so
      // rather than quoting the first turn of a run that has not happened.
      stats: started ? stats(snapshot.costUsd, snapshot.turnTokens) : null,
    };
  }
  return {
    ...conv.base,
    execution_status: statusFromEvents(conv, events),
    updated_at: newest ?? conv.base.updated_at,
  };
}

// ── Appending ────────────────────────────────────────────────────────────────

function append(conv: DemoConversation, event: RawOpenHandsEvent, delayMs = 0): void {
  conv.appended.push({ visibleAt: Date.now() + delayMs, event });
}

/**
 * What the demo says when a visitor sends a follow-up.
 *
 * Deliberately not in character. There is no agent and no workspace, and a
 * fabricated "on it, I'll open a merge request" would teach a visitor
 * something false about what they are looking at.
 */
const NO_AGENT_REPLY = `There is no agent behind this conversation — this build is the published demo,
so nothing was cloned and nothing will be edited. Every transcript you can see
here is fixture data served from the browser.

To watch a real run play out, open **“${SCRIPT_TITLE}”** from the conversation
list: it replays a full plan-mode run, including the write that stops for your
approval.`;

/** `data:` URL for an attached image — the only form the transcript renders. */
function dataUrl(image: ChatImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

function parseImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((i): i is ChatImage =>
      typeof i === "object" && i !== null
      && typeof (i as ChatImage).mediaType === "string"
      && typeof (i as ChatImage).data === "string")
    .map(dataUrl);
}

// ── Routes ───────────────────────────────────────────────────────────────────

const MAX_PAGE = 1_000;
const DEFAULT_PAGE = 100;

/**
 * One page of a transcript.
 *
 * `order=desc` is newest-first, which is how the bottom-anchored transcript
 * loads: the first page is the tail of the conversation and `next_page_id`
 * walks BACKWARDS through history, which is what "Load older events" follows.
 * The cursor is the id of the last event returned, so pages are disjoint and
 * stay correct even as new events land at the other end of the log.
 */
function page(all: RawOpenHandsEvent[], query: URLSearchParams) {
  const limitRaw = Number.parseInt(query.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE) : DEFAULT_PAGE;
  const ordered = query.get("order") === "desc" ? [...all].reverse() : all;
  const cursor = query.get("page_id");
  // An unknown cursor restarts from the top rather than erroring: a stale
  // cursor is a page reload away in a demo, and an empty transcript would be
  // the more confusing failure.
  const after = cursor ? ordered.findIndex((e) => String(e.id) === cursor) + 1 : 0;
  const items = ordered.slice(after, after + limit);
  const exhausted = after + limit >= ordered.length || items.length === 0;
  return {
    items,
    next_page_id: exhausted ? null : String(items[items.length - 1].id),
  };
}

function body(req: MockRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/** First line of the task, bounded — enough to recognise the row in the hub. */
function titleFrom(prompt: string): string | null {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

export const handlers: HandlerGroup = {
  name: "conversations",
  routes: {
    "GET /status": (): OpenHandsStatus => ({
      configured: true,
      allowlisted: true,
      // No Agent Canvas to escape to in a demo, so the hub's "open the default
      // UI" link stays hidden rather than pointing somewhere that 404s.
      publicUrl: null,
      server: { version: DEMO_SERVER_VERSION, uptime: elapsedSeconds() },
      model: DEMO_MODEL,
      models: [...DEMO_MODELS],
    }),

    "GET /conversations": () => {
      const now = Date.now();
      const items = [...store().byId.values()]
        .filter((c) => !c.deleted)
        .map((c) => summaryOf(c, now))
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
      return { items: items satisfies ConversationSummary[] };
    },

    "POST /conversations": (req) => {
      const input = body(req);
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) throw new MockHttpError(400, "prompt is required");
      const now = Date.now();
      const id = nextId("conv-draft");
      const model = typeof input.model === "string" && input.model ? input.model : DEMO_MODEL;
      const workingDir =
        typeof input.localPath === "string" && input.localPath
          ? input.localPath
          : typeof input.repoUrl === "string" && input.repoUrl
            ? `/workspace/${input.repoUrl.split("/").filter(Boolean).pop() ?? "project"}`
            : "/workspace";
      const conv: DemoConversation = {
        base: {
          id,
          // Upstream names a conversation from the exchange once it has one;
          // until then the first line of the task is the most useful label.
          title: titleFrom(prompt),
          execution_status: "running",
          created_at: isoNow(now),
          updated_at: isoNow(now),
          metrics: null,
          stats: stats(0.01, 900),
          agent: { llm: { model } },
          workspace: { working_dir: workingDir },
          confirmation_policy: input.mode === "plan" ? PLAN_POLICY : BUILD_POLICY,
        },
        events: [
          messageEvent({
            id: `${id}-m1`,
            timestamp: isoNow(now),
            role: "user",
            text: prompt,
            images: parseImages(input.images),
          }),
          statusEvent(`${id}-s1`, isoNow(now + 1), "running"),
        ],
        appended: [],
        finalResponse: null,
        progress: null,
        deleted: false,
      };
      // The honest reply, then the run ends. Delayed so the transcript is seen
      // to arrive rather than being complete on first paint.
      append(conv, messageEvent({ id: `${id}-m2`, timestamp: isoNow(now + 2_400), role: "assistant", text: NO_AGENT_REPLY }), 2_400);
      append(conv, statusEvent(`${id}-s2`, isoNow(now + 2_600), "finished"), 2_600);
      conv.finalResponse = NO_AGENT_REPLY;
      store().byId.set(id, conv);
      return { id, started: true };
    },

    "GET /conversations/:id": (req) => {
      const conv = find(req);
      const now = Date.now();
      touch(conv, now);
      return summaryOf(conv, now) satisfies ConversationSummary;
    },

    "DELETE /conversations/:id": (req) => {
      const conv = find(req);
      conv.deleted = true;
      return { deleted: true };
    },

    "GET /conversations/:id/events": (req) => {
      const conv = find(req);
      const now = Date.now();
      touch(conv, now);
      return page(visibleEvents(conv, now), req.query);
    },

    "POST /conversations/:id/messages": (req) => {
      const conv = find(req);
      const input = body(req);
      const text = typeof input.text === "string" ? input.text : "";
      const images = parseImages(input.images);
      if (!text.trim() && images.length === 0) throw new MockHttpError(400, "text is required");
      const now = Date.now();
      // The per-message model switcher really does switch the conversation.
      if (typeof input.model === "string" && input.model) {
        conv.base = { ...conv.base, agent: { llm: { model: input.model } } };
      }
      append(conv, messageEvent({
        id: nextId(`${conv.base.id}-um`),
        timestamp: isoNow(now),
        role: "user",
        text,
        images,
      }));
      // Mid-run, a follow-up is queued rather than answered — so the scripted
      // conversation just takes the message and carries on. Everywhere else
      // the run is (re)started, the demo answers, and it stops again.
      const scriptedAndBusy = conv.progress !== null && runStatus(conv.progress, now) !== "finished";
      if (!scriptedAndBusy) {
        const reply = messageEvent({
          id: nextId(`${conv.base.id}-am`),
          timestamp: isoNow(now + 2_400),
          role: "assistant",
          text: NO_AGENT_REPLY,
        });
        if (conv.progress) {
          // The scripted run has finished, so polling has stopped: a delayed
          // reply would never be fetched. Reveal it with the user's message.
          append(conv, reply);
        } else {
          append(conv, statusEvent(nextId(`${conv.base.id}-s`), isoNow(now + 1), "running"));
          append(conv, reply, 2_400);
          append(conv, statusEvent(nextId(`${conv.base.id}-s`), isoNow(now + 2_600), "finished"), 2_600);
        }
      }
      return { ok: true };
    },

    "POST /conversations/:id/run": (req) => {
      const conv = find(req);
      const now = Date.now();
      if (conv.progress) {
        conv.progress = resumeRun(conv.progress, now);
      } else {
        append(conv, statusEvent(nextId(`${conv.base.id}-s`), isoNow(now), "running"));
      }
      return { ok: true };
    },

    "POST /conversations/:id/pause": (req) => {
      const conv = find(req);
      const now = Date.now();
      if (conv.progress) {
        conv.progress = pauseRun(conv.progress, now);
      } else {
        append(conv, statusEvent(nextId(`${conv.base.id}-s`), isoNow(now), "paused"));
      }
      return { ok: true };
    },

    "POST /conversations/:id/mode": (req) => {
      const conv = find(req);
      const input = body(req);
      const mode = input.mode === "build" || input.mode === "plan" ? input.mode : null;
      if (!mode) throw new MockHttpError(400, 'mode must be "build" or "plan"');
      const notify = input.notify === true && mode === "build";
      const now = Date.now();
      conv.base = { ...conv.base, confirmation_policy: mode === "plan" ? PLAN_POLICY : BUILD_POLICY };
      // A NeverConfirm run does not stop for a MEDIUM write, so switching to
      // Build has to disarm the gate — otherwise the composer would say Build
      // while the run still parked itself for approval.
      if (conv.progress && mode === "build") conv.progress = allowWrites(conv.progress, now);
      if (notify) {
        // The same canned message the BFF sends (server/openhands/planMode.ts),
        // imported rather than retyped so the two cannot drift.
        append(conv, messageEvent({
          id: nextId(`${conv.base.id}-um`),
          timestamp: isoNow(now),
          role: "user",
          text: PLAN_APPROVED_MESSAGE,
        }));
        if (conv.progress) conv.progress = resumeRun(conv.progress, now);
      }
      return { mode, notified: notify };
    },

    "POST /conversations/:id/respond_to_confirmation": (req) => {
      const conv = find(req);
      const accept = body(req).accept;
      if (typeof accept !== "boolean") throw new MockHttpError(400, "accept must be a boolean");
      const now = Date.now();
      if (conv.progress) {
        conv.progress = accept ? approveRun(conv.progress, now) : rejectRun(conv.progress, now);
      }
      return { accepted: accept };
    },

    // Upstream returns the FinishAction summary as a bare JSON string, and a
    // bare `null` while the agent has not finished.
    "GET /conversations/:id/agent_final_response": (req) => {
      const conv = find(req);
      const now = Date.now();
      const finished = conv.progress
        ? runStatus(conv.progress, now) === "finished"
        : statusFromEvents(conv, visibleEvents(conv, now)) === "finished";
      return finished ? conv.finalResponse : null;
    },
  },

  streams: {
    // Live token stream. `delta` frames feed the draft bubble under the
    // transcript; an `event` frame clears it and triggers an immediate poll,
    // which is exactly what happens when a durable event lands upstream.
    //
    // Only the scripted conversation streams. The static "running" one is
    // blocked on a shell command, and a tool executing produces no tokens —
    // a silent stream is the honest answer there, and Conversation.tsx
    // degrades to plain polling without noticing (see ./types.ts).
    "GET /conversations/:id/stream": (req, ctrl) => {
      const conv = store().byId.get(req.params.id);
      if (!conv?.progress || conv.deleted) return;

      const TYPE_MS = 30;
      const CHARS_PER_TICK = 2;
      const PAUSE_TICKS = Math.round(4_000 / TYPE_MS);

      let sentence = "";
      let cursor = 0;
      let idle = 0;

      const tick = (): void => {
        if (ctrl.closed) return;
        if (idle > 0) {
          idle -= 1;
          return;
        }
        if (cursor >= sentence.length) {
          if (sentence) {
            // The draft is superseded by the persisted transcript.
            ctrl.emit({ event: "event", data: JSON.stringify({ kind: "ActionEvent" }) });
            sentence = "";
            idle = PAUSE_TICKS;
            return;
          }
          const progress = conv.progress;
          if (!progress) return;
          const next = streamingSentence(scriptRunMs(progress, Date.now()));
          if (!next) {
            idle = PAUSE_TICKS;
            return;
          }
          sentence = next;
          cursor = 0;
        }
        const content = sentence.slice(cursor, cursor + CHARS_PER_TICK);
        cursor += CHARS_PER_TICK;
        ctrl.emit({ event: "delta", data: JSON.stringify({ content }) });
      };

      const timer = setInterval(tick, TYPE_MS);
      return () => clearInterval(timer);
    },
  },
};

/** Exported for tests: the id of the conversation that plays the script. */
export const SCRIPTED_CONVERSATION_ID = SCRIPT_ID;
