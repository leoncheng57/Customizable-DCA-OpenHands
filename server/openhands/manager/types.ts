/**
 * Manager/worker parallel runs — shared server types.
 *
 * A RUN is one manager/worker engagement: a goal, an ordered list of WAVES,
 * and one manager conversation. Each wave holds up to MAX_WORKERS_PER_WAVE
 * WORKERS; a worker is exactly one OpenHands conversation working in its own
 * `sessions/<uuid>` clone of the target repo on one branch.
 *
 * Control-plane split (deliberate):
 *   - Judgment  = the manager CONVERSATION (plans, decides on triggers).
 *   - Mechanics = deterministic server code (launch, monitor, gate, validate).
 * The manager holds no handle to workers — every effect goes through the
 * executor, which validates each command. There is NO merge capability
 * anywhere in this feature; humans merge in GitLab.
 */

/** Hard cap on parallel workers per wave (shared agent-server pod). */
export const MAX_WORKERS_PER_WAVE = 8;

/** A worker phase, derived by the monitor — never self-reported. */
export type WorkerPhase =
  | "assigned" // row exists, conversation not confirmed running yet
  | "working" // conversation running
  | "pushed" // branch exists on origin, no MR yet
  | "pr-open" // draft MR exists
  | "done" // run completed / wave landed
  | "blocked"; // error/stuck/awaiting input, or finished without an MR

export type RunStatus =
  | "planning" // manager conversation drafting a plan
  | "plan-ready" // plan proposed, awaiting human approval
  | "active" // a wave is executing
  | "completed"
  | "failed"
  | "cancelled";

/** Statuses a run never leaves. A terminal run releases its conversations:
 * the manager conversation may be promoted again into a fresh run. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface WorkerSpec {
  /** Stable slug within the run, e.g. "alert-dedupe". */
  task: string;
  branch: string;
  /** One-paragraph goal plus ownership boundaries. */
  contract: string;
  /** Paths this worker owns (informational, embedded in the contract). */
  ownsPaths?: string[];
  /** Paths explicitly off-limits. */
  offLimitsPaths?: string[];
}

export interface WaveSpec {
  /** 1-based wave number. */
  index: number;
  /** Base ref workers clone from. Wave 1 uses the run base branch. */
  baseBranch: string;
  workers: WorkerSpec[];
}

export interface RunPlan {
  waves: WaveSpec[];
  /**
   * Repository the plan targets. Only meaningful while the run itself has no
   * repo yet (one-click promote could not infer one): the manager is asked to
   * determine it from the conversation and include it here.
   */
  repoUrl?: string;
}

export interface RunRecord {
  id: string;
  title: string;
  /** Null while a one-click promotion has not resolved a repository yet. */
  repoUrl: string | null;
  /** GitLab project path derived from repoUrl, e.g. "group/sub/repo". */
  projectPath: string | null;
  /**
   * True while repoUrl was INFERRED from the conversation (one-click promote)
   * rather than supplied by a human or resolved by the manager's plan. An
   * inferred repo is a best guess: the plan's repoUrl may override it, and the
   * approval UI flags it for verification.
   */
  repoInferred: boolean;
  baseBranch: string;
  goal: string;
  status: RunStatus;
  plan: RunPlan | null;
  /** 1-based index of the wave currently executing (0 = none yet). */
  currentWave: number;
  managerConversationId: string | null;
  /** Last manager-conversation event id already processed for commands. */
  managerEventCursor: string | null;
  maxWorkersPerWave: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Best-guess decisions and notes surfaced to the human. */
  notes: string[];
}

export interface WorkerRecord {
  id: string;
  runId: string;
  waveIndex: number;
  task: string;
  branch: string;
  contract: string;
  conversationId: string | null;
  phase: WorkerPhase;
  /** Human-readable reason when phase is "blocked". */
  blockReason: string | null;
  mrUrl: string | null;
  mrIid: number | null;
  ciStatus: string | null;
  /** Last observed agent-server execution_status. */
  executionStatus: string | null;
  /** Last time the conversation showed activity (agent-server updated_at). */
  lastActivityAt: string | null;
  /** LLM currently powering this worker (set at launch, changed by nudges). */
  model: string | null;
  /** Latest assistant message, truncated for the board (monitor-derived). */
  lastAgentMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Board previews store at most this many characters of the last AI message. */
export const LAST_AGENT_MESSAGE_MAX_CHARS = 300;

export type ActivityActor = "monitor" | "executor" | "manager" | "human";

export interface ActivityEntry {
  id: number;
  runId: string;
  actor: ActivityActor;
  message: string;
  createdAt: string;
}

/**
 * On-demand view a manager may request into a worker's transcript. All modes
 * are READ-ONLY — inspecting never sends anything into the worker's
 * conversation (only nudge_worker does that).
 */
export type InspectMode = "recent" | "last-message" | "last-error" | "last-tool";

export const INSPECT_MODES = [
  "recent",
  "last-message",
  "last-error",
  "last-tool",
] as const;

/** Commands the manager conversation may issue via fenced JSON blocks. */
export type ManagerCommand =
  | { command: "propose_plan"; plan: RunPlan; rationale?: string; repoUrl?: string }
  | { command: "launch_wave"; wave: number }
  | { command: "nudge_worker"; task: string; message: string; model?: string }
  | { command: "inspect_worker"; task: string; mode?: InspectMode }
  | { command: "request_human"; reason: string }
  | { command: "complete_run"; summary: string };

export const MANAGER_COMMAND_NAMES = [
  "propose_plan",
  "launch_wave",
  "nudge_worker",
  "inspect_worker",
  "request_human",
  "complete_run",
] as const;

/** Wake triggers the monitor sends to the manager conversation. */
export type TriggerKind =
  | "worker-blocked"
  | "worker-stale"
  | "wave-complete"
  | "run-review";

/** A worker is stale when running with no upstream activity for this long. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** Terminal agent-server execution statuses (mirrors client lib). */
export const TERMINAL_EXECUTION_STATUSES = new Set([
  "finished",
  "error",
  "stuck",
]);

export interface BoardWorker extends WorkerRecord {
  /** Seconds since lastActivityAt, null when unknown. */
  ageSeconds: number | null;
  stale: boolean;
}

export interface BoardState {
  run: RunRecord;
  workers: BoardWorker[];
  activity: ActivityEntry[];
  managerExecutionStatus: string | null;
  /** True when the manager conversation last ended in error/stuck. */
  managerNeedsAttention: boolean;
  /** Model new workers launch with (workers may diverge via model nudges). */
  defaultWorkerModel: string;
}

/** Sort weight: lower sorts first (worst-first board ordering). */
export function phaseSortWeight(w: BoardWorker): number {
  if (w.phase === "blocked") return 0;
  if (w.stale) return 1;
  if (w.phase === "assigned") return 2;
  if (w.phase === "working") return 3;
  if (w.phase === "pushed") return 4;
  if (w.phase === "pr-open") return 5;
  return 6; // done
}
