// Client API for manager/worker parallel runs (/api/openhands/manager).
// Mirrors the server types locally, matching the app's lib/api.ts idiom.

export type WorkerPhase =
  | "assigned"
  | "working"
  | "pushed"
  | "pr-open"
  | "done"
  | "blocked";

export type RunStatus =
  | "planning"
  | "plan-ready"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkerSpec {
  task: string;
  branch: string;
  contract: string;
  ownsPaths?: string[];
  offLimitsPaths?: string[];
}

export interface WaveSpec {
  index: number;
  baseBranch: string;
  workers: WorkerSpec[];
}

export interface RunPlan {
  waves: WaveSpec[];
  /** Repo the plan targets — only set by the manager on repo-less runs. */
  repoUrl?: string;
}

export interface RunRecord {
  id: string;
  title: string;
  /** Null until a one-click promotion resolves the repository. */
  repoUrl: string | null;
  projectPath: string | null;
  /** True while the repo was inferred (best guess) rather than confirmed. */
  repoInferred: boolean;
  baseBranch: string;
  goal: string;
  status: RunStatus;
  plan: RunPlan | null;
  currentWave: number;
  managerConversationId: string | null;
  managerEventCursor: string | null;
  maxWorkersPerWave: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: string[];
}

export interface BoardWorker {
  id: string;
  runId: string;
  waveIndex: number;
  task: string;
  branch: string;
  contract: string;
  conversationId: string | null;
  phase: WorkerPhase;
  blockReason: string | null;
  mrUrl: string | null;
  mrIid: number | null;
  ciStatus: string | null;
  executionStatus: string | null;
  lastActivityAt: string | null;
  /** LLM currently powering this worker (set at launch, changed by nudges). */
  model: string | null;
  /** Latest assistant message, truncated server-side for the board. */
  lastAgentMessage: string | null;
  createdAt: string;
  updatedAt: string;
  ageSeconds: number | null;
  stale: boolean;
}

export interface ActivityEntry {
  id: number;
  runId: string;
  actor: "monitor" | "executor" | "manager" | "human";
  message: string;
  createdAt: string;
}

export interface BoardState {
  run: RunRecord;
  workers: BoardWorker[];
  activity: ActivityEntry[];
  managerExecutionStatus: string | null;
  managerNeedsAttention: boolean;
  /** Model new workers launch with (workers may diverge via model nudges). */
  defaultWorkerModel: string;
}

export interface RepoStats {
  projectPath: string;
  repoSizeBytes: number | null;
  level: "info" | "warn" | "confirm" | "unknown";
  projectedBytes: number | null;
}

export interface CreateRunInput {
  title?: string;
  /**
   * Optional since one-click promote: when omitted the server infers the repo
   * from the conversation (and falls back to a repo-less planning run).
   */
  repoUrl?: string;
  /** Defaults to "main" server-side. */
  baseBranch?: string;
  /** Optional note; the promoted conversation itself is the goal context. */
  goal?: string;
  plan?: RunPlan;
  maxWorkersPerWave?: number;
  /** The existing conversation to promote into the run's manager (required). */
  managerConversationId: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const BASE = "/api/openhands/manager";

export const managerApi = {
  listRuns: () =>
    fetch(`${BASE}/runs`).then((r) => json<{ items: RunRecord[] }>(r)),
  createRun: (input: CreateRunInput) =>
    fetch(`${BASE}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<RunRecord>(r)),
  board: (id: string) =>
    fetch(`${BASE}/runs/${id}`).then((r) => json<BoardState>(r)),
  approve: (id: string) =>
    fetch(`${BASE}/runs/${id}/approve`, { method: "POST" }).then((r) =>
      json<{ result: { ok: boolean; message: string }; run: RunRecord }>(r),
    ),
  rejectPlan: (id: string, reason: string) =>
    fetch(`${BASE}/runs/${id}/reject-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }).then((r) =>
      json<{ ok: boolean; message: string; run: RunRecord }>(r),
    ),
  nudge: (id: string, task: string, message: string, model?: string) =>
    fetch(`${BASE}/runs/${id}/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model ? { task, message, model } : { task, message }),
    }).then((r) => json<{ ok: boolean; message: string }>(r)),
  cancel: (id: string) =>
    fetch(`${BASE}/runs/${id}/cancel`, { method: "POST" }).then((r) =>
      json<{ ok: boolean; message: string }>(r),
    ),
  /**
   * Run membership of a conversation. Returns null on 404 ("genuinely not in
   * a run"); THROWS on transient errors so callers can keep their previous
   * state instead of wrongly demoting a manager to a plain conversation.
   */
  conversationRun: async (conversationId: string) => {
    const r = await fetch(`${BASE}/conversations/${conversationId}/run`);
    if (r.status === 404) return null;
    return json<{
      runId: string;
      role: "manager" | "worker";
      task?: string;
      title: string | null;
      status: RunStatus | null;
    }>(r);
  },
  conversationRoles: () =>
    fetch(`${BASE}/conversation-roles`).then((r) =>
      json<{ roles: Record<string, ConversationRole> }>(r),
    ),
  repoStats: (repoUrl: string, workers: number) =>
    fetch(
      `${BASE}/repo-stats?repoUrl=${encodeURIComponent(repoUrl)}&workers=${workers}`,
    ).then((r) => json<RepoStats>(r)),
};

export const PHASE_TONES: Record<WorkerPhase, string> = {
  blocked: "bg-red-100 text-red-800",
  assigned: "bg-gray-100 text-gray-700",
  working: "bg-blue-100 text-blue-800",
  pushed: "bg-amber-100 text-amber-800",
  "pr-open": "bg-violet-100 text-violet-800",
  done: "bg-emerald-100 text-emerald-800",
};

/** Statuses a run never leaves; a terminal run releases its conversations. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const RUN_STATUS_TONES: Record<RunStatus, string> = {
  planning: "bg-blue-100 text-blue-800",
  "plan-ready": "bg-amber-100 text-amber-800",
  active: "bg-blue-100 text-blue-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-700",
};

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface ConversationRole {
  role: "manager" | "worker";
  runId: string;
  task?: string;
}

export type GroupedConversation<T> =
  | { kind: "plain"; item: T; role?: ConversationRole }
  | { kind: "manager"; item: T; runId: string; workers: Array<{ item: T; task?: string }> };

/**
 * Partition a conversation list into run hierarchies: worker conversations
 * nest under their run's manager row when the manager is present in the list;
 * otherwise they stay flat (with their role attached) — never hidden.
 */
export function groupConversationsByRun<T extends { id: string }>(
  items: T[],
  roles: Record<string, ConversationRole>,
): Array<GroupedConversation<T>> {
  const managerIdByRun = new Map<string, string>();
  for (const [cid, r] of Object.entries(roles)) {
    if (r.role === "manager") managerIdByRun.set(r.runId, cid);
  }
  const presentIds = new Set(items.map((i) => i.id));
  const nestedWorkerIds = new Set<string>();
  const workersByRun = new Map<string, Array<{ item: T; task?: string }>>();
  for (const item of items) {
    const role = roles[item.id];
    if (!role || role.role !== "worker") continue;
    const managerId = managerIdByRun.get(role.runId);
    if (!managerId || !presentIds.has(managerId)) continue; // stays flat
    nestedWorkerIds.add(item.id);
    const list = workersByRun.get(role.runId) ?? [];
    list.push({ item, task: role.task });
    workersByRun.set(role.runId, list);
  }
  const out: Array<GroupedConversation<T>> = [];
  for (const item of items) {
    if (nestedWorkerIds.has(item.id)) continue;
    const role = roles[item.id];
    if (role?.role === "manager") {
      const workers = (workersByRun.get(role.runId) ?? []).sort((a, b) =>
        (a.task ?? "").localeCompare(b.task ?? ""),
      );
      out.push({ kind: "manager", item, runId: role.runId, workers });
    } else {
      out.push({ kind: "plain", item, role });
    }
  }
  return out;
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return "–";
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
