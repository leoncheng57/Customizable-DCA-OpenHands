// client/mock/fixtures/manager-simulation.ts
//
// The demo's manager/worker runs, as a PURE FUNCTION OF ELAPSED TIME.
//
// There is no ticking engine here and no timer anywhere in the manager group:
// a scenario is a static script, `simulateRun()` compiles it once into an
// immutable timeline, and `snapshotAt(timeline, runMs)` answers "what did the
// board look like `runMs` into this run?". The board page polls every 5s, so
// serving `snapshotAt(timeline, now)` is enough to make the run animate — and
// because the answer depends only on the arguments, the whole thing is
// unit-testable without faking clocks or waiting for anything.
//
// Two clocks, deliberately separated:
//
//   RUN TIME    ms since the run's own wave-1 launch. Everything in a scenario
//               is expressed in it, so a scenario reads like a story board.
//   DEMO TIME   ms since the page loaded (../clock.ts). `runClockMs()` maps one
//               onto the other, which is where "this run started 21 minutes
//               before you arrived" and "cancelling freezes it" live.
//
// The mapping supports three shapes a demo needs:
//   · a run already in flight when the visitor arrives (`startedAtRunMs`)
//   · a run PAUSED at a human gate — the plan-approval card — which only
//     resumes once the visitor approves (`gateAtRunMs`)
//   · a run frozen forever (completed / cancelled seeds, and cancel())
//
// Invented data only: every repo, branch, task, worker and author name in
// ./manager-scenarios.ts is made up. See tests/mock-fixtures.test.ts.

import type {
  ActivityEntry,
  RunPlan,
  RunStatus,
  WorkerPhase,
} from "../../lib/manager-api.js";
import { SECOND } from "../clock.js";

// ---------------------------------------------------------------------------
// Phase ordering
// ---------------------------------------------------------------------------

/**
 * Position of a phase on the happy path. `blocked` is off the path entirely
 * (it is reachable from anywhere and leads back), so it scores -1 and is
 * excluded from the monotonicity rule: a worker may fall into `blocked` and
 * climb out, but it never un-pushes a branch or un-opens an MR.
 */
export const PHASE_RANK: Record<WorkerPhase, number> = {
  blocked: -1,
  assigned: 0,
  working: 1,
  pushed: 2,
  "pr-open": 3,
  done: 4,
};

/** Agent-server `execution_status` a worker reports while in each phase. */
const PHASE_EXECUTION_STATUS: Record<WorkerPhase, string | null> = {
  assigned: null,
  working: "running",
  pushed: "running",
  "pr-open": "finished",
  done: "finished",
  blocked: "error",
};

/** Mirrors STALE_AFTER_MS in the real monitor. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** Mirrors TERMINAL_EXECUTION_STATUSES in the real monitor. */
const TERMINAL_EXECUTION_STATUSES = new Set(["finished", "error", "stuck"]);

// ---------------------------------------------------------------------------
// Scenario script
// ---------------------------------------------------------------------------

/** One phase change in a worker's script. Times are RUN TIME milliseconds. */
export interface PhaseStep {
  at: number;
  phase: WorkerPhase;
  /** Required-ish for `blocked`; rendered in red under the worker's name. */
  blockReason?: string;
  /** Truncated "last message" preview shown while this phase holds. */
  message?: string;
  /** Overrides the derived `execution_status` (e.g. "stuck" vs "error"). */
  executionStatus?: string;
  /** Replaces the auto-generated monitor transition line in the log. */
  note?: string;
  /** Drop the transition line entirely (the launch line already covers it). */
  silentInLog?: boolean;
}

/** A window in which the worker's conversation reports no activity at all. */
export interface QuietWindow {
  from: number;
  /** Exclusive; omit for "still quiet". */
  until?: number;
}

/** Draft merge request a worker opens, plus how its pipeline resolves. */
export interface MergeRequestScript {
  at: number;
  iid: number;
  /** GitLab pipeline statuses over time: pending → running → success/failed. */
  ci: Array<{ at: number; status: string }>;
}

export interface WorkerScript {
  task: string;
  branch: string;
  contract: string;
  ownsPaths?: string[];
  offLimitsPaths?: string[];
  waveIndex: number;
  /** Conversation the executor created for this worker. */
  conversationId: string;
  /** Run time at which the worker row appears (its wave's launch). */
  launchAt: number;
  /** Ascending phase changes. The first one must sit at `launchAt`. */
  steps: PhaseStep[];
  /** How often the conversation reports activity while it is awake. */
  heartbeatMs?: number;
  /** Stretches with no heartbeat — this is how a worker goes `stale`. */
  quiet?: QuietWindow[];
  mergeRequest?: MergeRequestScript;
  /** Model the worker launched with; defaults to the run's default model. */
  model?: string;
}

/** A log line that is not a worker phase change — manager/human chatter. */
export interface ScriptedActivity {
  at: number;
  actor: ActivityEntry["actor"];
  message: string;
}

/** Run-level status changes (wave launches, completion). */
export interface RunStatusStep {
  at: number;
  status: RunStatus;
  currentWave: number;
}

/** A note that appears on the board partway through the run. */
export interface ScriptedNote {
  at: number;
  text: string;
}

export interface RunScenario {
  id: string;
  title: string;
  repoUrl: string | null;
  projectPath: string | null;
  repoInferred: boolean;
  baseBranch: string;
  goal: string;
  plan: RunPlan;
  maxWorkersPerWave: number;
  managerConversationId: string;
  createdBy: string;
  /** Run time at which the run row was created (0 = wave-1 launch, so ≤ 0). */
  createdAtRunMs: number;
  /** Run time reached at `birthElapsedMs` — i.e. when the visitor first sees it. */
  startedAtRunMs: number;
  /**
   * Demo time at which this run entered the demo. 0 for the seeded runs (they
   * predate the page load); the current elapsed time for a run the visitor
   * creates by promoting a conversation.
   */
  birthElapsedMs?: number;
  /**
   * Run time of a human gate. The run clock PAUSES here until the visitor
   * approves the plan, then resumes — which is what makes "Approve plan &
   * launch wave 1" launch a wave that then visibly progresses.
   *
   * The gate value itself belongs to the POST-approval side: before approval
   * the clock is clamped to `gateAtRunMs - 1`, so a wave scripted at the gate
   * launches the instant the button is pressed rather than a beat later.
   */
  gateAtRunMs?: number;
  /** Run time the clock is pinned to forever (completed / cancelled seeds). */
  frozenAtRunMs?: number;
  statusSteps: RunStatusStep[];
  workers: WorkerScript[];
  activity?: ScriptedActivity[];
  notes?: ScriptedNote[];
  /** Manager conversation's execution_status over time. */
  managerStatusSteps?: Array<{ at: number; status: string | null }>;
  defaultWorkerModel: string;
}

// ---------------------------------------------------------------------------
// Compiled timeline
// ---------------------------------------------------------------------------

export interface WorkerTimeline extends WorkerScript {
  heartbeatMs: number;
  quiet: QuietWindow[];
  /** Run time after which no heartbeat is ever emitted again. */
  quietFromEnd: number | null;
}

export interface TimedActivity extends ScriptedActivity {
  id: number;
}

export interface RunTimeline {
  scenario: RunScenario;
  workers: WorkerTimeline[];
  activity: TimedActivity[];
  /** Id to continue from when the visitor's own actions append to the log. */
  nextActivityId: number;
}

const DEFAULT_HEARTBEAT_MS = 45 * SECOND;

function assertAscending(label: string, times: readonly number[]): void {
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] < times[i - 1]) {
      throw new Error(`[mock] ${label}: scripted times must ascend (${times[i - 1]} → ${times[i]})`);
    }
  }
}

/**
 * Compile a scenario into its timeline: the phase-transition log lines are
 * derived here (so a scenario only has to say what happens, not narrate it),
 * merged with the scripted chatter and given stable ascending ids.
 */
export function simulateRun(scenario: RunScenario): RunTimeline {
  assertAscending(`run ${scenario.id} statusSteps`, scenario.statusSteps.map((s) => s.at));
  if (scenario.gateAtRunMs != null) {
    const gate = scenario.gateAtRunMs;
    for (const worker of scenario.workers) {
      if (worker.launchAt < gate) {
        throw new Error(
          `[mock] run ${scenario.id}: worker ${worker.task} launches before the approval gate`,
        );
      }
    }
  }
  const workers: WorkerTimeline[] = scenario.workers.map((script) => {
    if (script.steps.length === 0) {
      throw new Error(`[mock] worker ${script.task}: needs at least one phase step`);
    }
    if (script.steps[0].at !== script.launchAt) {
      throw new Error(`[mock] worker ${script.task}: first step must sit at launchAt`);
    }
    assertAscending(`worker ${script.task}`, script.steps.map((s) => s.at));
    const quiet = script.quiet ?? [];
    const openQuiet = quiet.find((w) => w.until === undefined);
    return {
      ...script,
      heartbeatMs: script.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      quiet,
      quietFromEnd: openQuiet ? openQuiet.from : null,
    };
  });

  const derived: ScriptedActivity[] = [];
  // One "wave N launched: …" line per wave, in the executor's own wording.
  const waves = [...new Set(workers.map((w) => w.waveIndex))].sort((a, b) => a - b);
  for (const waveIndex of waves) {
    const inWave = workers.filter((w) => w.waveIndex === waveIndex);
    derived.push({
      at: Math.min(...inWave.map((w) => w.launchAt)),
      actor: "executor",
      message: `wave ${waveIndex} launched: ${inWave.map((w) => w.task).join(", ")}`,
    });
  }
  // The monitor narrates every phase change it derives.
  for (const worker of workers) {
    for (let i = 1; i < worker.steps.length; i += 1) {
      const step = worker.steps[i];
      if (step.silentInLog) continue;
      const previous = worker.steps[i - 1].phase;
      derived.push({
        at: step.at,
        actor: "monitor",
        message:
          step.note ??
          `${worker.task}: ${previous} → ${step.phase}` +
            (step.blockReason ? ` (${step.blockReason})` : ""),
      });
    }
    if (worker.mergeRequest) {
      for (const ci of worker.mergeRequest.ci) {
        derived.push({
          at: ci.at,
          actor: "monitor",
          message: `${worker.task}: pipeline ${ci.status} on !${worker.mergeRequest.iid}`,
        });
      }
    }
  }

  const merged = [...derived, ...(scenario.activity ?? [])].sort(
    (a, b) => a.at - b.at || a.actor.localeCompare(b.actor) || a.message.localeCompare(b.message),
  );
  const activity: TimedActivity[] = merged.map((entry, i) => ({ ...entry, id: i + 1 }));

  return {
    scenario,
    workers,
    activity,
    nextActivityId: activity.length + 1,
  };
}

// ---------------------------------------------------------------------------
// The two clocks
// ---------------------------------------------------------------------------

/** Everything the visitor's own actions contribute to the clock mapping. */
export interface RunClockInput {
  /** Milliseconds since the page loaded. */
  elapsedMs: number;
  /** Demo time at which the visitor approved the pending plan, if they did. */
  approvedAtElapsedMs?: number | null;
  /** Run time the clock was pinned to by a cancel. */
  frozenAtRunMs?: number | null;
}

/**
 * Demo time → run time. Monotonically non-decreasing in `elapsedMs` for a
 * fixed input, which is what stops the board from ever rewinding.
 */
export function runClockMs(timeline: RunTimeline, input: RunClockInput): number {
  const { scenario } = timeline;
  if (input.frozenAtRunMs != null) return input.frozenAtRunMs;
  if (scenario.frozenAtRunMs != null) return scenario.frozenAtRunMs;
  const sinceBirth = Math.max(0, input.elapsedMs - (scenario.birthElapsedMs ?? 0));
  const free = scenario.startedAtRunMs + sinceBirth;
  if (scenario.gateAtRunMs == null) return free;
  if (input.approvedAtElapsedMs == null) return Math.min(free, scenario.gateAtRunMs - 1);
  // Resume from the gate: the wave starts when the human said so, not when
  // the page happened to load.
  const sinceApproval = Math.max(0, input.elapsedMs - input.approvedAtElapsedMs);
  return scenario.gateAtRunMs + sinceApproval;
}

/**
 * Wall-clock epoch (ms) that run time 0 corresponds to. Fixed for the lifetime
 * of a run except across the approval gate, where the clock restarts from the
 * moment the visitor said yes.
 */
export function runEpochMs(
  timeline: RunTimeline,
  input: RunClockInput,
  demoStart: number,
): number {
  const { scenario } = timeline;
  if (scenario.gateAtRunMs != null && input.approvedAtElapsedMs != null) {
    return demoStart + input.approvedAtElapsedMs - scenario.gateAtRunMs;
  }
  return demoStart + (scenario.birthElapsedMs ?? 0) - scenario.startedAtRunMs;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** A worker as of one instant of run time, still in run-relative units. */
export interface WorkerSnapshot {
  task: string;
  branch: string;
  contract: string;
  waveIndex: number;
  conversationId: string;
  phase: WorkerPhase;
  blockReason: string | null;
  executionStatus: string | null;
  lastAgentMessage: string | null;
  mrIid: number | null;
  ciStatus: string | null;
  model: string | null;
  createdAtRunMs: number;
  updatedAtRunMs: number;
  /** Run time of the newest heartbeat, or null when it never woke up. */
  lastActivityAtRunMs: number | null;
}

function stepAt(worker: WorkerTimeline, runMs: number): PhaseStep {
  let current = worker.steps[0];
  for (const step of worker.steps) {
    if (step.at > runMs) break;
    current = step;
  }
  return current;
}

/**
 * Newest heartbeat at or before `runMs`. Heartbeats tick at `heartbeatMs`
 * from launch and are suppressed inside quiet windows and once the worker
 * stops working, which is the only way `stale` is ever produced.
 */
export function lastHeartbeatAt(worker: WorkerTimeline, runMs: number): number | null {
  if (runMs < worker.launchAt) return null;
  let cap = runMs;
  for (const window of worker.quiet) {
    const until = window.until ?? Number.POSITIVE_INFINITY;
    if (runMs >= window.from && runMs < until) {
      cap = Math.min(cap, window.from);
      break;
    }
  }
  const beats = Math.floor((cap - worker.launchAt) / worker.heartbeatMs);
  return worker.launchAt + beats * worker.heartbeatMs;
}

export function workerAt(worker: WorkerTimeline, runMs: number): WorkerSnapshot | null {
  if (runMs < worker.launchAt) return null;
  const step = stepAt(worker, runMs);
  const mr = worker.mergeRequest && worker.mergeRequest.at <= runMs ? worker.mergeRequest : null;
  let ciStatus: string | null = null;
  if (mr) {
    for (const entry of mr.ci) {
      if (entry.at > runMs) break;
      ciStatus = entry.status;
    }
  }
  return {
    task: worker.task,
    branch: worker.branch,
    contract: worker.contract,
    waveIndex: worker.waveIndex,
    conversationId: worker.conversationId,
    phase: step.phase,
    blockReason: step.blockReason ?? null,
    executionStatus: step.executionStatus ?? PHASE_EXECUTION_STATUS[step.phase],
    lastAgentMessage: step.message ?? null,
    mrIid: mr ? mr.iid : null,
    ciStatus,
    model: worker.model ?? null,
    createdAtRunMs: worker.launchAt,
    updatedAtRunMs: step.at,
    lastActivityAtRunMs: lastHeartbeatAt(worker, runMs),
  };
}

export interface RunSnapshot {
  status: RunStatus;
  currentWave: number;
  updatedAtRunMs: number;
  notes: string[];
  managerExecutionStatus: string | null;
  workers: WorkerSnapshot[];
  activity: TimedActivity[];
}

/** The whole run as of one instant of run time. */
export function snapshotAt(timeline: RunTimeline, runMs: number): RunSnapshot {
  const { scenario } = timeline;
  let status: RunStatus = scenario.statusSteps[0]?.status ?? "planning";
  let currentWave = scenario.statusSteps[0]?.currentWave ?? 0;
  let updatedAtRunMs = scenario.createdAtRunMs;
  for (const step of scenario.statusSteps) {
    if (step.at > runMs) break;
    status = step.status;
    currentWave = step.currentWave;
    updatedAtRunMs = step.at;
  }
  let managerExecutionStatus: string | null = null;
  for (const step of scenario.managerStatusSteps ?? []) {
    if (step.at > runMs) break;
    managerExecutionStatus = step.status;
  }
  const workers: WorkerSnapshot[] = [];
  for (const worker of timeline.workers) {
    const snapshot = workerAt(worker, runMs);
    if (snapshot) {
      workers.push(snapshot);
      updatedAtRunMs = Math.max(updatedAtRunMs, snapshot.updatedAtRunMs);
    }
  }
  return {
    status,
    currentWave,
    updatedAtRunMs,
    notes: (scenario.notes ?? []).filter((n) => n.at <= runMs).map((n) => n.text),
    managerExecutionStatus,
    workers,
    activity: timeline.activity.filter((entry) => entry.at <= runMs),
  };
}

// ---------------------------------------------------------------------------
// Board derivations (mirrors of the real server's, kept honest by the tests)
// ---------------------------------------------------------------------------

/** Seconds since a worker's last heartbeat — the board's Age column. */
export function ageSecondsOf(
  snapshot: WorkerSnapshot,
  runEpoch: number,
  now: number,
): number | null {
  if (snapshot.lastActivityAtRunMs == null) return null;
  return Math.max(0, Math.round((now - (runEpoch + snapshot.lastActivityAtRunMs)) / 1000));
}

/** Same rule as the real monitor: quiet for too long, and still expected to move. */
export function isStale(snapshot: WorkerSnapshot, ageSeconds: number | null): boolean {
  if (snapshot.phase === "done" || snapshot.phase === "pr-open") return false;
  if (snapshot.executionStatus && TERMINAL_EXECUTION_STATUSES.has(snapshot.executionStatus)) {
    return false;
  }
  if (ageSeconds == null) return false;
  return ageSeconds * 1000 > STALE_AFTER_MS;
}

/** Worst-first ordering, mirroring `phaseSortWeight` on the server. */
export function phaseSortWeight(phase: WorkerPhase, stale: boolean): number {
  if (phase === "blocked") return 0;
  if (stale) return 1;
  if (phase === "assigned") return 2;
  if (phase === "working") return 3;
  if (phase === "pushed") return 4;
  if (phase === "pr-open") return 5;
  return 6;
}
