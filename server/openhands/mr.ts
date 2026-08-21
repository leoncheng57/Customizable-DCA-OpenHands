// server/openhands/mr.ts
//
// Pure shaping helpers for the MR sidebar's Phase 2 routes (/mr/comments,
// /mr/pipeline). No I/O — the BFF fetches via the platform GitLab client and
// hands the raw results here, so the aggregation rules are unit-testable.
import type { GitLabPipelineJob, MrDiscussion } from "../gitlab.js";

// ── Comments ────────────────────────────────────────────────────────────────

export interface MrComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
}

export const MR_COMMENTS_MAX = 50;

/**
 * Flatten MR discussion threads into a single chronological comment list for
 * the sidebar. System notes are already dropped by fetchMrDiscussions;
 * position-anchored diff notes are dropped too (v1 shows conversation-level
 * comments only — inline review notes need diff context to make sense).
 * Capped at the most recent MR_COMMENTS_MAX notes.
 */
export function flattenMrComments(discussions: MrDiscussion[], max = MR_COMMENTS_MAX): MrComment[] {
  const comments: MrComment[] = [];
  for (const disc of discussions) {
    for (const note of disc.notes) {
      if (note.system || note.position) continue;
      comments.push({
        id: note.id,
        author: note.author,
        body: note.body,
        createdAt: note.createdAt,
        resolved: note.resolved,
      });
    }
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  return comments.slice(-max);
}

// ── Pipeline stages ─────────────────────────────────────────────────────────

export interface MrPipelineJob {
  name: string;
  status: string;
  webUrl: string;
  /** Seconds, null while the job has not run. */
  duration: number | null;
}

export interface MrPipelineStage {
  name: string;
  status: string;
  jobs: MrPipelineJob[];
}

/** Waiting-room job states GitLab reports before a job runs. */
const PENDING_STATUSES = new Set(["pending", "created", "waiting_for_resource", "preparing", "scheduled"]);

/**
 * Derive a stage's status from its jobs, mirroring GitLab semantics closely
 * enough for a sidebar: any failure wins, then anything still moving, then
 * anything queued, then the terminal-but-not-green states, then success.
 */
const STAGE_STATUS_PRECEDENCE = ["failed", "running", "pending", "canceled", "manual", "skipped"] as const;

export function deriveStageStatus(jobStatuses: string[]): string {
  if (jobStatuses.length === 0) return "skipped";
  const normalized = jobStatuses.map((s) => (PENDING_STATUSES.has(s) ? "pending" : s));
  for (const status of STAGE_STATUS_PRECEDENCE) {
    if (normalized.includes(status)) return status;
  }
  return normalized.every((s) => s === "success") ? "success" : normalized[0];
}

/**
 * Group a pipeline's jobs into ordered stages. Jobs are sorted by id (GitLab
 * assigns ids in creation order, which follows stage order), stages appear in
 * first-job order, and each stage's status is derived from its jobs.
 */
export function aggregatePipelineStages(jobs: GitLabPipelineJob[]): MrPipelineStage[] {
  const sorted = [...jobs].sort((a, b) => a.id - b.id);
  const byStage = new Map<string, GitLabPipelineJob[]>();
  for (const job of sorted) {
    const stage = job.stage || "pipeline";
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(job);
    else byStage.set(stage, [job]);
  }
  return [...byStage.entries()].map(([name, stageJobs]) => ({
    name,
    status: deriveStageStatus(stageJobs.map((j) => j.status)),
    jobs: stageJobs.map((j) => ({
      name: j.name,
      status: j.status,
      webUrl: j.webUrl,
      duration: j.duration,
    })),
  }));
}
