// client/mock/manager.ts
//
// OWNER: the manager-runs group. Read ./types.ts first — it is the contract.
//
// Endpoints this group owns — everything under `/manager/*`. The exact set the
// client calls is `managerApi` in client/lib/manager-api.ts:
//
//   GET  /manager/runs                                → { items: RunRecord[] }
//   POST /manager/runs                                → RunRecord            (body: CreateRunInput)
//   GET  /manager/runs/:id                            → BoardState
//   POST /manager/runs/:id/approve                    → { result: { ok, message }; run: RunRecord }
//   POST /manager/runs/:id/reject-plan                → { ok, message, run: RunRecord }   (body: { reason })
//   POST /manager/runs/:id/nudge                      → { ok, message }                   (body: { task, message, model? })
//   POST /manager/runs/:id/cancel                     → { ok, message }
//   GET  /manager/conversations/:conversationId/run   → { runId, role, task?, title, status } | 404
//   GET  /manager/conversation-roles                  → { roles: Record<string, ConversationRole> }
//   GET  /manager/repo-stats                          → RepoStats            (query: repoUrl, workers)
//
// ---------------------------------------------------------------------------
// How this group produces a board that moves
// ---------------------------------------------------------------------------
//
// There is no timer here. Each run is a static story board in RUN TIME
// (./fixtures/manager-scenarios.ts), compiled once by `simulateRun()` into an
// immutable timeline, and every request answers `snapshotAt(timeline, now)`.
// The board page already polls `/manager/runs/:id` every 5s, so a pure
// function of elapsed time is all it takes for workers to push branches, open
// draft MRs and launch the next wave while the visitor watches — and the same
// function is trivially unit-testable (tests/mock-manager.test.ts).
//
// The visitor's own actions do NOT fork the simulation; they are a thin
// OVERLAY in ./state.ts (`manager:` keys) that the snapshot is folded through:
//
//   approve      un-pauses a run parked at its approval gate, so wave 1
//                launches from the instant the button was pressed
//   reject-plan  drops the pending plan for 30s, during which the board shows
//                "The manager is drafting a wave plan", then it re-proposes
//   nudge        unblocks a blocked worker, clears its `stale` flag, switches
//                its model, and appends the executor's own log line
//   cancel       freezes the run clock where it stood
//
// ---------------------------------------------------------------------------
// Notes carried over from the stub
// ---------------------------------------------------------------------------
//  · `/manager/conversations/:conversationId/run` MUST 404 (not 200-with-null)
//    for a conversation that is not part of a run — and must never answer 4xx
//    for anything else, because `useRunMembership` keeps its previous state on
//    a non-404 error, which would hide the Promote button forever.
//  · `GET /manager/conversation-roles` is keyed by conversation ids this group
//    owns (the seeded manager/worker ids in ./fixtures/manager-scenarios.ts,
//    plus any conversation the visitor promotes). Ids owned by
//    ./conversations.ts are unknown here and simply get no role — the hub
//    renders them flat, which is the documented fallback in
//    `groupConversationsByRun`.
//  · Everything is invented. See tests/mock-fixtures.test.ts.

import { DEMO_START, SECOND, elapsedMs, isoAt } from "./clock.js";
import { demoState } from "./state.js";
import { MockHttpError, mockResponse, type HandlerGroup } from "./types.js";
import type {
  ActivityEntry,
  BoardState,
  BoardWorker,
  ConversationRole,
  CreateRunInput,
  RepoStats,
  RunRecord,
  RunStatus,
} from "../lib/manager-api.js";
import { TERMINAL_RUN_STATUSES } from "../lib/manager-api.js";
import {
  buildSeededTimelines,
  mrUrl,
  promotedScenario,
  PROMOTED_REPO_URL,
} from "./fixtures/manager-scenarios.js";
import {
  ageSecondsOf,
  isStale,
  phaseSortWeight,
  runClockMs,
  runEpochMs,
  simulateRun,
  snapshotAt,
  type RunClockInput,
  type RunSnapshot,
  type RunTimeline,
} from "./fixtures/manager-simulation.js";

// ---------------------------------------------------------------------------
// Constants that mirror the real server's configuration
// ---------------------------------------------------------------------------

/** Hard cap on parallel workers per wave (shared agent-server pod). */
const MAX_WORKERS_PER_WAVE = 8;

/** Models a nudge may switch a worker to — the demo's configured allowlist. */
const ALLOWED_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5-20251001",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "anthropic/claude-opus-4-6",
  "openai/gpt-5.6-sol",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-5",
  "anthropic/claude-fable-5",
];

/** How long the manager takes to revise a plan the human rejected. */
const REPLAN_MS = 30 * SECOND;

/** Repository sizes the demo reports, keyed by project path. */
const REPO_SIZES: Record<string, number> = {
  "tidepool-labs/storefront-web": 383 * 1024 ** 2,
  "tidepool-labs/ledger-service": Math.round(1.62 * 1024 ** 3),
  "tidepool-labs/design-tokens": 24 * 1024 ** 2,
  "wren-analytics/metrics-pipeline": Math.round(6.4 * 1024 ** 3),
};

const REPO_URL_RE = /^https:\/\/(gitlab\.com|github\.com)\/[^/\s]+(\/[^/\s]+)+$/;

// ---------------------------------------------------------------------------
// Mutable overlay (./state.ts)
// ---------------------------------------------------------------------------

interface WorkerOverlay {
  model?: string;
  /** Run time at which a human/manager nudge cleared a `blocked` phase. */
  unblockedAtRunMs?: number;
  /** Run time of the last nudge — counts as activity, so `stale` clears. */
  lastNudgeAtRunMs?: number;
  lastNudgeMessage?: string;
}

interface OverlayActivity {
  atElapsedMs: number;
  actor: ActivityEntry["actor"];
  message: string;
}

interface RunOverlay {
  /** Demo time the visitor approved the pending plan. */
  approvedAtElapsedMs?: number;
  /** Demo time until which a rejected plan is being revised. */
  replanUntilElapsedMs?: number;
  /** Run time the clock was pinned to by a cancel. */
  frozenAtRunMs?: number;
  cancelled?: boolean;
  /** Wall-clock of the newest visitor-driven change. */
  touchedAtMs?: number;
  activity: OverlayActivity[];
  workers: Record<string, WorkerOverlay>;
}

interface ManagerState {
  timelines: RunTimeline[];
  overlays: Map<string, RunOverlay>;
  /** Number of runs the visitor has promoted, for stable generated ids. */
  promoted: number;
}

function state(): ManagerState {
  return demoState.ensure<ManagerState>("manager:state", () => ({
    timelines: buildSeededTimelines(),
    overlays: new Map(),
    promoted: 0,
  }));
}

function overlayFor(runId: string): RunOverlay {
  const s = state();
  let overlay = s.overlays.get(runId);
  if (!overlay) {
    overlay = { activity: [], workers: {} };
    s.overlays.set(runId, overlay);
  }
  return overlay;
}

function workerOverlay(overlay: RunOverlay, task: string): WorkerOverlay {
  overlay.workers[task] ??= {};
  return overlay.workers[task];
}

function log(overlay: RunOverlay, actor: ActivityEntry["actor"], message: string, delayMs = 0): void {
  overlay.activity.push({ atElapsedMs: elapsedMs() + delayMs, actor, message });
}

// ---------------------------------------------------------------------------
// Folding the overlay into a snapshot
// ---------------------------------------------------------------------------

interface RunView {
  timeline: RunTimeline;
  overlay: RunOverlay;
  runMs: number;
  epoch: number;
  snapshot: RunSnapshot;
  /** True while a rejected plan is being revised by the manager. */
  replanning: boolean;
  status: RunStatus;
}

function viewOf(timeline: RunTimeline, now: number = Date.now()): RunView {
  const overlay = overlayFor(timeline.scenario.id);
  const clock: RunClockInput = {
    elapsedMs: elapsedMs(now),
    approvedAtElapsedMs: overlay.approvedAtElapsedMs ?? null,
    frozenAtRunMs: overlay.frozenAtRunMs ?? null,
  };
  const runMs = runClockMs(timeline, clock);
  const snapshot = snapshotAt(timeline, runMs);
  const replanning =
    overlay.replanUntilElapsedMs != null && elapsedMs(now) < overlay.replanUntilElapsedMs;
  const status: RunStatus = overlay.cancelled
    ? "cancelled"
    : replanning
      ? "planning"
      : snapshot.status;
  return {
    timeline,
    overlay,
    runMs,
    epoch: runEpochMs(timeline, clock, DEMO_START),
    snapshot,
    replanning,
    status,
  };
}

function runRecordOf(view: RunView): RunRecord {
  const { scenario } = view.timeline;
  const updatedAt = Math.max(
    view.epoch + view.snapshot.updatedAtRunMs,
    view.overlay.touchedAtMs ?? 0,
  );
  return {
    id: scenario.id,
    title: scenario.title,
    repoUrl: scenario.repoUrl,
    projectPath: scenario.projectPath,
    repoInferred: scenario.repoInferred,
    baseBranch: scenario.baseBranch,
    goal: scenario.goal,
    status: view.status,
    plan: view.replanning ? null : scenario.plan,
    currentWave: view.snapshot.currentWave,
    managerConversationId: scenario.managerConversationId,
    managerEventCursor: null,
    maxWorkersPerWave: scenario.maxWorkersPerWave,
    createdBy: scenario.createdBy,
    createdAt: new Date(view.epoch + scenario.createdAtRunMs).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    notes: view.snapshot.notes,
  };
}

function boardWorkersOf(view: RunView, now: number): BoardWorker[] {
  const { scenario } = view.timeline;
  const rows = view.snapshot.workers.map((snapshot) => {
    const wo = view.overlay.workers[snapshot.task];
    let phase = snapshot.phase;
    let blockReason = snapshot.blockReason;
    let executionStatus = snapshot.executionStatus;
    let lastAgentMessage = snapshot.lastAgentMessage;
    let lastActivityRunMs = snapshot.lastActivityAtRunMs;
    let updatedAtRunMs = snapshot.updatedAtRunMs;

    // A nudge only counts when it landed on the phase the worker is in NOW —
    // a later scripted transition supersedes it.
    const nudgeAt = wo?.lastNudgeAtRunMs;
    const nudgeIsCurrent = nudgeAt != null && nudgeAt >= snapshot.updatedAtRunMs;
    if (nudgeIsCurrent && nudgeAt <= view.runMs) {
      lastActivityRunMs = Math.max(lastActivityRunMs ?? nudgeAt, nudgeAt);
      updatedAtRunMs = Math.max(updatedAtRunMs, nudgeAt);
      if (wo?.lastNudgeMessage) lastAgentMessage = wo.lastNudgeMessage;
      if (phase === "blocked" && wo?.unblockedAtRunMs != null && wo.unblockedAtRunMs <= view.runMs) {
        phase = "working";
        blockReason = null;
        executionStatus = "running";
      }
    }

    const lastActivityAt =
      lastActivityRunMs == null ? null : new Date(view.epoch + lastActivityRunMs).toISOString();
    const folded = { ...snapshot, phase, executionStatus, lastActivityAtRunMs: lastActivityRunMs };
    const ageSeconds = ageSecondsOf(folded, view.epoch, now);
    const stale = isStale(folded, ageSeconds);
    return {
      id: `${scenario.id}:${snapshot.task}`,
      runId: scenario.id,
      waveIndex: snapshot.waveIndex,
      task: snapshot.task,
      branch: snapshot.branch,
      contract: snapshot.contract,
      conversationId: snapshot.conversationId,
      phase,
      blockReason,
      mrUrl:
        snapshot.mrIid != null && scenario.projectPath
          ? mrUrl(scenario.projectPath, snapshot.mrIid)
          : null,
      mrIid: snapshot.mrIid,
      ciStatus: snapshot.ciStatus,
      executionStatus,
      lastActivityAt,
      model: wo?.model ?? snapshot.model ?? scenario.defaultWorkerModel,
      lastAgentMessage,
      createdAt: new Date(view.epoch + snapshot.createdAtRunMs).toISOString(),
      updatedAt: new Date(view.epoch + updatedAtRunMs).toISOString(),
      ageSeconds,
      stale,
    } satisfies BoardWorker;
  });
  return rows.sort(
    (a, b) =>
      phaseSortWeight(a.phase, a.stale) - phaseSortWeight(b.phase, b.stale) ||
      a.task.localeCompare(b.task),
  );
}

function activityOf(view: RunView, now: number): ActivityEntry[] {
  const runId = view.timeline.scenario.id;
  const scripted: ActivityEntry[] = view.snapshot.activity.map((entry) => ({
    id: entry.id,
    runId,
    actor: entry.actor,
    message: entry.message,
    createdAt: new Date(view.epoch + entry.at).toISOString(),
  }));
  const elapsed = elapsedMs(now);
  const extra: ActivityEntry[] = view.overlay.activity
    .filter((entry) => entry.atElapsedMs <= elapsed)
    .map((entry, i) => ({
      id: view.timeline.nextActivityId + i,
      runId,
      actor: entry.actor,
      message: entry.message,
      createdAt: isoAt(entry.atElapsedMs),
    }));
  return [...scripted, ...extra].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id,
  );
}

function boardStateOf(view: RunView, now: number): BoardState {
  const managerExecutionStatus = view.replanning
    ? "running"
    : view.snapshot.managerExecutionStatus;
  return {
    run: runRecordOf(view),
    workers: boardWorkersOf(view, now),
    activity: activityOf(view, now),
    managerExecutionStatus,
    managerNeedsAttention:
      managerExecutionStatus === "error" || managerExecutionStatus === "stuck",
    defaultWorkerModel: view.timeline.scenario.defaultWorkerModel,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function findTimeline(runId: string): RunTimeline {
  const found = state().timelines.find((t) => t.scenario.id === runId);
  if (!found) throw new MockHttpError(404, "run not found");
  return found;
}

interface Membership {
  runId: string;
  role: "manager" | "worker";
  task?: string;
}

/** Role of every conversation this group owns, at the current instant. */
function conversationRoles(now: number): Record<string, ConversationRole> {
  const roles: Record<string, ConversationRole> = {};
  for (const timeline of state().timelines) {
    const view = viewOf(timeline, now);
    roles[timeline.scenario.managerConversationId] = {
      role: "manager",
      runId: timeline.scenario.id,
    };
    for (const worker of view.snapshot.workers) {
      roles[worker.conversationId] = {
        role: "worker",
        runId: timeline.scenario.id,
        task: worker.task,
      };
    }
  }
  return roles;
}

function membershipOf(conversationId: string, now: number): Membership | null {
  const role = conversationRoles(now)[conversationId];
  if (!role) return null;
  return { runId: role.runId, role: role.role, task: role.task };
}

// ---------------------------------------------------------------------------
// Repo stats
// ---------------------------------------------------------------------------

/** "https://gitlab.com/group/sub/repo" → "group/sub/repo" (null when invalid). */
export function projectPathFromRepoUrl(repoUrl: string): string | null {
  if (!REPO_URL_RE.test(repoUrl)) return null;
  const path = new URL(repoUrl).pathname.replace(/^\/+|\/+$|\.git$/g, "");
  const cut = path.indexOf("/-/");
  const trimmed = cut === -1 ? path : path.slice(0, cut);
  return trimmed.length > 0 ? trimmed : null;
}

/** Same thresholds as the real server's `sizeAdvisory`. */
export function sizeAdvisory(
  repoSizeBytes: number | null,
  workers: number,
): { level: RepoStats["level"]; projectedBytes: number | null } {
  if (repoSizeBytes == null) return { level: "unknown", projectedBytes: null };
  const projected = repoSizeBytes * Math.max(workers, 1);
  if (projected > 15 * 1024 ** 3) return { level: "confirm", projectedBytes: projected };
  if (projected > 5 * 1024 ** 3) return { level: "warn", projectedBytes: projected };
  return { level: "info", projectedBytes: projected };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function listRuns(now: number): RunRecord[] {
  return state()
    .timelines.map((timeline) => runRecordOf(viewOf(timeline, now)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function createRun(input: CreateRunInput, now: number): RunRecord {
  const promoteId = String(input.managerConversationId ?? "").trim();
  if (!promoteId) {
    throw new MockHttpError(
      400,
      "managerConversationId is required: promote an existing conversation into a manager",
    );
  }
  const existing = membershipOf(promoteId, now);
  if (existing) {
    const priorStatus = viewOf(findTimeline(existing.runId), now).status;
    if (!TERMINAL_RUN_STATUSES.has(priorStatus)) {
      throw new MockHttpError(
        409,
        `conversation is already the ${existing.role} of run ${existing.runId}`,
      );
    }
  }
  const supplied = String(input.repoUrl ?? "").trim();
  if (supplied !== "" && !projectPathFromRepoUrl(supplied)) {
    throw new MockHttpError(
      400,
      "invalid repoUrl (https URL on gitlab.com or github.com required)",
    );
  }
  const repoUrl = supplied || PROMOTED_REPO_URL;
  const goal = String(input.goal ?? "").trim();
  const s = state();
  s.promoted += 1;
  const runId = promotedRunId(s.promoted);
  const scenario = promotedScenario({
    runId,
    managerConversationId: promoteId,
    title:
      String(input.title ?? "").trim() ||
      goal.slice(0, 80) ||
      `run ${promoteId.slice(0, 8)}`,
    goal,
    repoUrl,
    projectPath: projectPathFromRepoUrl(repoUrl),
    repoInferred: supplied === "",
    baseBranch: String(input.baseBranch ?? "main").trim() || "main",
    maxWorkersPerWave: Math.min(
      Math.max(Number(input.maxWorkersPerWave) || MAX_WORKERS_PER_WAVE, 1),
      MAX_WORKERS_PER_WAVE,
    ),
    createdBy: "you@example.test",
    birthElapsedMs: elapsedMs(now),
    sequence: s.promoted,
  });
  const timeline = simulateRun(scenario);
  s.timelines.push(timeline);
  return runRecordOf(viewOf(timeline, now));
}

/** Stable, uuid-shaped id for the nth run the visitor promotes. */
function promotedRunId(sequence: number): string {
  const n = String(sequence % 1000).padStart(3, "0");
  return `7a1${n}e4-62c9-4f08-b53d-04e97c1a8${n}`;
}

function approve(runId: string, now: number) {
  const timeline = findTimeline(runId);
  const view = viewOf(timeline, now);
  const run = runRecordOf(view);
  if (run.status !== "plan-ready" || !run.plan) {
    throw new MockHttpError(409, `run is ${run.status}; nothing to approve`);
  }
  if (!run.repoUrl || !run.projectPath) {
    throw new MockHttpError(
      409,
      "the run has no repository resolved yet — ask the manager to re-propose the plan with a repoUrl before approving",
    );
  }
  const overlay = view.overlay;
  overlay.approvedAtElapsedMs = elapsedMs(now);
  overlay.touchedAtMs = now;
  log(overlay, "human", "plan approved");
  const wave1 = run.plan.waves.find((w) => w.index === 1);
  const message = `wave 1 launched: ${wave1?.workers.map((w) => w.task).join(", ") ?? "none"}`;
  return {
    result: { ok: true, message },
    run: runRecordOf(viewOf(timeline, now)),
  };
}

function rejectPlan(runId: string, reason: string, now: number) {
  const timeline = findTimeline(runId);
  const view = viewOf(timeline, now);
  const run = runRecordOf(view);
  if (run.status !== "plan-ready") {
    throw new MockHttpError(409, `run is ${run.status}; there is no pending plan to reject`);
  }
  const overlay = view.overlay;
  const trimmed = reason.trim().slice(0, 2_000);
  overlay.replanUntilElapsedMs = elapsedMs(now) + REPLAN_MS;
  overlay.touchedAtMs = now;
  log(
    overlay,
    "human",
    `plan rejected${trimmed ? `: ${trimmed}` : ""}; run returned to planning`,
  );
  log(
    overlay,
    "manager",
    `plan proposed (${timeline.scenario.plan.waves.length} wave(s)); awaiting human approval`,
    REPLAN_MS,
  );
  return {
    ok: true,
    message: "plan rejected; the manager was asked to revise it",
    run: runRecordOf(viewOf(timeline, now)),
  };
}

function nudge(
  runId: string,
  body: { task?: unknown; message?: unknown; model?: unknown },
  now: number,
) {
  const timeline = findTimeline(runId);
  const view = viewOf(timeline, now);
  const task = typeof body.task === "string" ? body.task : "";
  const message = typeof body.message === "string" ? body.message : "";
  if (!task || !message) throw new MockHttpError(400, "task and message are required");
  const model = body.model === undefined ? undefined : String(body.model).trim();
  if (model !== undefined && model === "") {
    throw new MockHttpError(400, "model, when present, must be a non-empty string");
  }
  const worker = view.snapshot.workers.find((w) => w.task === task);
  if (!worker) throw new MockHttpError(400, `no worker "${task}" in run`);
  if (model !== undefined && !ALLOWED_MODELS.includes(model)) {
    throw new MockHttpError(
      400,
      `model "${model}" is not in the configured allowlist (${ALLOWED_MODELS.join(", ")})`,
    );
  }
  const overlay = view.overlay;
  const wo = workerOverlay(overlay, task);
  if (model !== undefined) wo.model = model;
  wo.lastNudgeAtRunMs = view.runMs;
  wo.lastNudgeMessage = `Nudge received — re-reading the contract and continuing on ${worker.branch}.`;
  if (worker.phase === "blocked") wo.unblockedAtRunMs = view.runMs;
  overlay.touchedAtMs = now;
  const note =
    `nudge delivered to ${task} (human)` +
    (model !== undefined ? ` [model → ${model}]` : "") +
    `: ${message.slice(0, 200)}`;
  log(overlay, "executor", note);
  return { ok: true, message: note };
}

function cancel(runId: string, now: number) {
  const timeline = findTimeline(runId);
  const view = viewOf(timeline, now);
  const overlay = view.overlay;
  if (!overlay.cancelled) {
    overlay.frozenAtRunMs = view.runMs;
    overlay.cancelled = true;
    overlay.replanUntilElapsedMs = undefined;
    overlay.touchedAtMs = now;
    log(overlay, "human", "run cancelled");
  }
  return { ok: true, message: "run cancelled" };
}

function repoStats(query: URLSearchParams): RepoStats {
  const repoUrl = String(query.get("repoUrl") ?? "");
  const workers = Math.min(Number(query.get("workers")) || MAX_WORKERS_PER_WAVE, MAX_WORKERS_PER_WAVE);
  const projectPath = projectPathFromRepoUrl(repoUrl);
  if (!projectPath) throw new MockHttpError(400, "invalid repoUrl");
  const repoSizeBytes = REPO_SIZES[projectPath] ?? null;
  return { projectPath, repoSizeBytes, ...sizeAdvisory(repoSizeBytes, workers) };
}

export const handlers: HandlerGroup = {
  name: "manager",
  routes: {
    "GET /manager/runs": () => ({ items: listRuns(Date.now()) }),

    "POST /manager/runs": (req) =>
      mockResponse(createRun((req.body ?? {}) as CreateRunInput, Date.now()), { status: 201 }),

    "GET /manager/runs/:id": (req) => {
      const now = Date.now();
      return boardStateOf(viewOf(findTimeline(req.params.id), now), now);
    },

    "POST /manager/runs/:id/approve": (req) => approve(req.params.id, Date.now()),

    "POST /manager/runs/:id/reject-plan": (req) => {
      const reason = String(((req.body ?? {}) as { reason?: unknown }).reason ?? "");
      return rejectPlan(req.params.id, reason, Date.now());
    },

    "POST /manager/runs/:id/nudge": (req) =>
      nudge(req.params.id, (req.body ?? {}) as Record<string, unknown>, Date.now()),

    "POST /manager/runs/:id/cancel": (req) => cancel(req.params.id, Date.now()),

    // 404 is a CONTRACT here, not an error: `managerApi.conversationRun` reads
    // it as "genuinely not in a run" and anything else as transient.
    "GET /manager/conversations/:conversationId/run": (req) => {
      const now = Date.now();
      const membership = membershipOf(req.params.conversationId, now);
      if (!membership) throw new MockHttpError(404, "not part of a run");
      const view = viewOf(findTimeline(membership.runId), now);
      return {
        ...membership,
        title: view.timeline.scenario.title,
        status: view.status,
      };
    },

    "GET /manager/conversation-roles": () => ({ roles: conversationRoles(Date.now()) }),

    "GET /manager/repo-stats": (req) => repoStats(req.query),
  },
};

/** Exposed for tests: the compiled timelines behind the routes. */
export function demoTimelines(): RunTimeline[] {
  return state().timelines;
}

/** Exposed for tests: the board a run would serve at `now`. */
export function demoBoard(runId: string, now: number = Date.now()): BoardState {
  return boardStateOf(viewOf(findTimeline(runId), now), now);
}

/** Exposed for tests: how long a plan-ready run stays in planning after a reject. */
export const REPLAN_DELAY_MS = REPLAN_MS;

/** Exposed for tests: the demo's worker-model allowlist. */
export const DEMO_ALLOWED_MODELS: readonly string[] = ALLOWED_MODELS;
