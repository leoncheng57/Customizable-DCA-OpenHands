/**
 * Postgres store for manager/worker runs (schema "openhands").
 *
 * Follows the hive job-store pattern: inline idempotent DDL at init, a typed
 * store object, parameterized queries throughout. The activity table doubles
 * as the persisted, replayable activity log shown on the run board.
 */

import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../../db.js";
import type {
  ActivityActor,
  ActivityEntry,
  RunPlan,
  RunRecord,
  RunStatus,
  WorkerPhase,
  WorkerRecord,
} from "./types.js";

async function init(db: AppDatabase): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS manager_runs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      repo_url TEXT,
      project_path TEXT,
      repo_inferred BOOLEAN NOT NULL DEFAULT FALSE,
      base_branch TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      plan JSONB,
      current_wave INTEGER NOT NULL DEFAULT 0,
      manager_conversation_id TEXT,
      manager_event_cursor TEXT,
      max_workers_per_wave INTEGER NOT NULL DEFAULT 8,
      created_by TEXT NOT NULL,
      notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS manager_workers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES manager_runs(id) ON DELETE CASCADE,
      wave_index INTEGER NOT NULL,
      task TEXT NOT NULL,
      branch TEXT NOT NULL,
      contract TEXT NOT NULL,
      conversation_id TEXT,
      phase TEXT NOT NULL DEFAULT 'assigned',
      block_reason TEXT,
      mr_url TEXT,
      mr_iid INTEGER,
      ci_status TEXT,
      execution_status TEXT,
      last_activity_at TIMESTAMPTZ,
      model TEXT,
      last_agent_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id, task)
    )
  `);
  // Model indicator + last-message preview (issues #266/#267): existing
  // installs get the columns idempotently; fresh installs have them above.
  await db.query(
    `ALTER TABLE manager_workers ADD COLUMN IF NOT EXISTS model TEXT`,
  );
  await db.query(
    `ALTER TABLE manager_workers ADD COLUMN IF NOT EXISTS last_agent_message TEXT`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS manager_workers_run_idx ON manager_workers (run_id, wave_index)`,
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS manager_activity (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES manager_runs(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS manager_activity_run_idx ON manager_activity (run_id, id)`,
  );
  // One-click promote: the repo may be unknown at creation (resolved later by
  // the manager's proposed plan), so existing installs must drop the NOT NULL
  // constraints. Try/caught, hive-style — a fresh install (nullable columns
  // above) or an already-migrated one makes these no-ops.
  for (const sql of [
    `ALTER TABLE manager_runs ALTER COLUMN repo_url DROP NOT NULL`,
    `ALTER TABLE manager_runs ALTER COLUMN project_path DROP NOT NULL`,
    `ALTER TABLE manager_runs ADD COLUMN IF NOT EXISTS repo_inferred BOOLEAN NOT NULL DEFAULT FALSE`,
  ]) {
    try {
      await db.query(sql);
    } catch {
      /* already nullable / older postgres — the CREATE TABLE covers fresh installs */
    }
  }
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return iso(v);
}

function rowToRun(r: Record<string, unknown>): RunRecord {
  return {
    id: String(r.id),
    title: String(r.title),
    repoUrl: (r.repo_url as string | null) ?? null,
    projectPath: (r.project_path as string | null) ?? null,
    repoInferred: Boolean(r.repo_inferred),
    baseBranch: String(r.base_branch),
    goal: String(r.goal),
    status: String(r.status) as RunStatus,
    plan: (r.plan as RunPlan | null) ?? null,
    currentWave: Number(r.current_wave),
    managerConversationId: (r.manager_conversation_id as string | null) ?? null,
    managerEventCursor: (r.manager_event_cursor as string | null) ?? null,
    maxWorkersPerWave: Number(r.max_workers_per_wave),
    createdBy: String(r.created_by),
    notes: Array.isArray(r.notes) ? (r.notes as string[]) : [],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function rowToWorker(r: Record<string, unknown>): WorkerRecord {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    waveIndex: Number(r.wave_index),
    task: String(r.task),
    branch: String(r.branch),
    contract: String(r.contract),
    conversationId: (r.conversation_id as string | null) ?? null,
    phase: String(r.phase) as WorkerPhase,
    blockReason: (r.block_reason as string | null) ?? null,
    mrUrl: (r.mr_url as string | null) ?? null,
    mrIid: r.mr_iid == null ? null : Number(r.mr_iid),
    ciStatus: (r.ci_status as string | null) ?? null,
    executionStatus: (r.execution_status as string | null) ?? null,
    lastActivityAt: isoOrNull(r.last_activity_at),
    model: (r.model as string | null) ?? null,
    lastAgentMessage: (r.last_agent_message as string | null) ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function rowToActivity(r: Record<string, unknown>): ActivityEntry {
  return {
    id: Number(r.id),
    runId: String(r.run_id),
    actor: String(r.actor) as ActivityActor,
    message: String(r.message),
    createdAt: iso(r.created_at),
  };
}

export interface CreateRunInput {
  title: string;
  repoUrl: string | null;
  projectPath: string | null;
  repoInferred: boolean;
  baseBranch: string;
  goal: string;
  status: RunStatus;
  plan: RunPlan | null;
  maxWorkersPerWave: number;
  createdBy: string;
}

export interface ManagerStore {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit?: number): Promise<RunRecord[]>;
  listActiveRuns(): Promise<RunRecord[]>;
  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus;
      plan: RunPlan | null;
      currentWave: number;
      managerConversationId: string | null;
      managerEventCursor: string | null;
      title: string;
      repoUrl: string | null;
      projectPath: string | null;
      repoInferred: boolean;
    }>,
  ): Promise<RunRecord | null>;
  addRunNote(id: string, note: string): Promise<void>;
  createWorker(input: {
    runId: string;
    waveIndex: number;
    task: string;
    branch: string;
    contract: string;
  }): Promise<WorkerRecord>;
  listWorkers(runId: string): Promise<WorkerRecord[]>;
  getWorkerByTask(runId: string, task: string): Promise<WorkerRecord | null>;
  updateWorker(
    id: string,
    patch: Partial<{
      conversationId: string | null;
      phase: WorkerPhase;
      blockReason: string | null;
      mrUrl: string | null;
      mrIid: number | null;
      ciStatus: string | null;
      executionStatus: string | null;
      lastActivityAt: string | null;
      model: string | null;
      lastAgentMessage: string | null;
    }>,
  ): Promise<WorkerRecord | null>;
  addActivity(
    runId: string,
    actor: ActivityActor,
    message: string,
  ): Promise<void>;
  listActivity(runId: string, limit?: number): Promise<ActivityEntry[]>;
  /** Which run (if any) does this conversation belong to, and in what role? */
  findRunByConversation(conversationId: string): Promise<
    | { runId: string; role: "manager" }
    | { runId: string; role: "worker"; task: string }
    | null
  >;
  /** Role of every run-member conversation, keyed by conversation id. */
  listConversationRoles(): Promise<
    Record<string, { role: "manager" | "worker"; runId: string; task?: string }>
  >;
}

const WORKER_PATCH_COLUMNS: Record<string, string> = {
  conversationId: "conversation_id",
  phase: "phase",
  blockReason: "block_reason",
  mrUrl: "mr_url",
  mrIid: "mr_iid",
  ciStatus: "ci_status",
  executionStatus: "execution_status",
  lastActivityAt: "last_activity_at",
  model: "model",
  lastAgentMessage: "last_agent_message",
};

const RUN_PATCH_COLUMNS: Record<string, string> = {
  status: "status",
  plan: "plan",
  currentWave: "current_wave",
  managerConversationId: "manager_conversation_id",
  managerEventCursor: "manager_event_cursor",
  title: "title",
  repoUrl: "repo_url",
  projectPath: "project_path",
  repoInferred: "repo_inferred",
};

export async function createManagerStore(
  db: AppDatabase,
): Promise<ManagerStore> {
  await init(db);

  const store: ManagerStore = {
    async createRun(input) {
      const res = await db.query(
        `INSERT INTO manager_runs
           (id, title, repo_url, project_path, repo_inferred, base_branch, goal,
            status, plan, max_workers_per_wave, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          randomUUID(),
          input.title,
          input.repoUrl,
          input.projectPath,
          input.repoInferred,
          input.baseBranch,
          input.goal,
          input.status,
          input.plan == null ? null : JSON.stringify(input.plan),
          input.maxWorkersPerWave,
          input.createdBy,
        ],
      );
      return rowToRun(res.rows[0]);
    },

    async getRun(id) {
      const res = await db.query(`SELECT * FROM manager_runs WHERE id = $1`, [
        id,
      ]);
      return res.rows[0] ? rowToRun(res.rows[0]) : null;
    },

    async listRuns(limit = 50) {
      const res = await db.query(
        `SELECT * FROM manager_runs ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map(rowToRun);
    },

    async listActiveRuns() {
      const res = await db.query(
        `SELECT * FROM manager_runs
         WHERE status IN ('planning','plan-ready','active')
         ORDER BY created_at ASC`,
      );
      return res.rows.map(rowToRun);
    },

    async updateRun(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, col] of Object.entries(RUN_PATCH_COLUMNS)) {
        if (!(key in patch)) continue;
        const value = (patch as Record<string, unknown>)[key];
        params.push(key === "plan" && value != null ? JSON.stringify(value) : value);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length === 0) return store.getRun(id);
      params.push(id);
      const res = await db.query(
        `UPDATE manager_runs SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return res.rows[0] ? rowToRun(res.rows[0]) : null;
    },

    async addRunNote(id, note) {
      await db.query(
        `UPDATE manager_runs
         SET notes = notes || $2::jsonb, updated_at = now()
         WHERE id = $1`,
        [id, JSON.stringify([note])],
      );
    },

    async createWorker(input) {
      const res = await db.query(
        `INSERT INTO manager_workers (id, run_id, wave_index, task, branch, contract)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          randomUUID(),
          input.runId,
          input.waveIndex,
          input.task,
          input.branch,
          input.contract,
        ],
      );
      return rowToWorker(res.rows[0]);
    },

    async listWorkers(runId) {
      const res = await db.query(
        `SELECT * FROM manager_workers WHERE run_id = $1
         ORDER BY wave_index ASC, task ASC`,
        [runId],
      );
      return res.rows.map(rowToWorker);
    },

    async getWorkerByTask(runId, task) {
      const res = await db.query(
        `SELECT * FROM manager_workers WHERE run_id = $1 AND task = $2`,
        [runId, task],
      );
      return res.rows[0] ? rowToWorker(res.rows[0]) : null;
    },

    async updateWorker(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, col] of Object.entries(WORKER_PATCH_COLUMNS)) {
        if (!(key in patch)) continue;
        params.push((patch as Record<string, unknown>)[key]);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length === 0) {
        const res = await db.query(
          `SELECT * FROM manager_workers WHERE id = $1`,
          [id],
        );
        return res.rows[0] ? rowToWorker(res.rows[0]) : null;
      }
      params.push(id);
      const res = await db.query(
        `UPDATE manager_workers SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return res.rows[0] ? rowToWorker(res.rows[0]) : null;
    },

    async addActivity(runId, actor, message) {
      await db.query(
        `INSERT INTO manager_activity (run_id, actor, message) VALUES ($1,$2,$3)`,
        [runId, actor, message],
      );
    },

    async listActivity(runId, limit = 200) {
      const res = await db.query(
        `SELECT * FROM manager_activity WHERE run_id = $1
         ORDER BY id DESC LIMIT $2`,
        [runId, limit],
      );
      return res.rows.map(rowToActivity).reverse();
    },

    async findRunByConversation(conversationId) {
      const asManager = await db.query(
        `SELECT id FROM manager_runs WHERE manager_conversation_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      );
      if (asManager.rows[0]) {
        return { runId: String(asManager.rows[0].id), role: "manager" };
      }
      const asWorker = await db.query(
        `SELECT run_id, task FROM manager_workers WHERE conversation_id = $1 LIMIT 1`,
        [conversationId],
      );
      if (asWorker.rows[0]) {
        return {
          runId: String(asWorker.rows[0].run_id),
          role: "worker",
          task: String(asWorker.rows[0].task),
        };
      }
      return null;
    },

    async listConversationRoles() {
      const roles: Record<
        string,
        { role: "manager" | "worker"; runId: string; task?: string }
      > = {};
      const managers = await db.query(
        `SELECT id, manager_conversation_id FROM manager_runs
         WHERE manager_conversation_id IS NOT NULL`,
      );
      for (const r of managers.rows) {
        roles[String(r.manager_conversation_id)] = {
          role: "manager",
          runId: String(r.id),
        };
      }
      const workers = await db.query(
        `SELECT run_id, task, conversation_id FROM manager_workers
         WHERE conversation_id IS NOT NULL`,
      );
      for (const r of workers.rows) {
        roles[String(r.conversation_id)] = {
          role: "worker",
          runId: String(r.run_id),
          task: String(r.task),
        };
      }
      return roles;
    },
  };
  return store;
}
