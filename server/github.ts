// Minimal GitHub REST adapter with GitLab-shaped outputs, so the manager
// monitor can join worker branches/PRs on github.com repos through the same
// code path it uses for GitLab (headShaOf / findMergeRequests /
// listMergeRequestPipelines equivalents). Pure mapping helpers are exported
// separately for unit tests.
import { logger } from "./logger.js";

const TIMEOUT_MS = 10_000;
const API = "https://api.github.com";

export interface GitHubAuth {
  token: string;
}

export function isGitHubRepoUrl(repoUrl: string): boolean {
  try {
    return new URL(repoUrl).hostname === "github.com";
  } catch {
    return false;
  }
}

function headers(auth: GitHubAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "customizable-dca",
  };
}

async function ghGet<T>(auth: GitHubAuth, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: headers(auth),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status !== 404) logger.warn({ status: res.status, path }, "GitHub API call failed");
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, path }, "GitHub API call errored");
    return null;
  }
}

/** GitLab-shaped headShaOf: sha of a branch head, or null when absent. */
export async function ghHeadShaOf(auth: GitHubAuth, projectPath: string, branch: string): Promise<string | null> {
  const body = await ghGet<{ commit?: { sha?: string } }>(
    auth,
    `/repos/${projectPath}/branches/${encodeURIComponent(branch)}`,
  );
  return body?.commit?.sha ?? null;
}

interface GitHubPull {
  number: number;
  html_url?: string;
  head?: { ref?: string };
  title?: string;
  state?: string; // "open" | "closed"
  merged_at?: string | null;
  user?: { login?: string };
}

/** Map a GitHub PR to the GitLab MergeRequestSummary shape the monitor reads. */
export function mapPullToMrSummary(pr: GitHubPull): {
  iid: number;
  web_url: string;
  source_branch: string;
  title: string;
  state: string;
  merged_at: string | null;
  author: { username: string; name: string } | null;
  labels: string[];
  reviewers: Array<{ id: number; username: string }>;
} {
  // GitLab states: opened / merged / closed. GitHub folds merged into closed,
  // so disambiguate with merged_at.
  const state = pr.state === "open" ? "opened" : pr.merged_at ? "merged" : "closed";
  return {
    iid: pr.number,
    web_url: pr.html_url ?? "",
    source_branch: pr.head?.ref ?? "",
    title: pr.title ?? "",
    state,
    merged_at: pr.merged_at ?? null,
    author: pr.user?.login ? { username: pr.user.login, name: pr.user.login } : null,
    labels: [],
    reviewers: [],
  };
}

/**
 * GitLab-shaped findMergeRequests limited to what the monitor uses:
 * source_branch filtering + opened/all state. Never throws.
 */
export async function ghFindPullRequests(
  auth: GitHubAuth,
  projectPath: string,
  params: { source_branch?: string; state?: "opened" | "all"; per_page?: number } = {},
): Promise<ReturnType<typeof mapPullToMrSummary>[]> {
  const owner = projectPath.split("/")[0];
  const search = new URLSearchParams({
    state: params.state === "all" ? "all" : "open",
    per_page: String(params.per_page ?? 10),
  });
  if (params.source_branch) search.set("head", `${owner}:${params.source_branch}`);
  const pulls = await ghGet<GitHubPull[]>(auth, `/repos/${projectPath}/pulls?${search}`);
  return (pulls ?? []).map(mapPullToMrSummary);
}

interface GitHubCheckRun {
  status?: string; // queued | in_progress | completed
  conclusion?: string | null; // success | failure | cancelled | skipped | timed_out | neutral | action_required
}

/**
 * Collapse GitHub check runs into one GitLab pipeline status
 * (success / failed / canceled / skipped / running / pending), matching the
 * monitor's CI_TERMINAL_STATUSES vocabulary. Null when there are no checks.
 */
export function mapCheckRunsToPipelineStatus(runs: GitHubCheckRun[]): string | null {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status !== "completed")) return "running";
  if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "action_required")) {
    return "failed";
  }
  if (runs.some((r) => r.conclusion === "cancelled")) return "canceled";
  if (runs.every((r) => r.conclusion === "skipped" || r.conclusion === "neutral")) return "skipped";
  return "success";
}

/** GitLab-shaped listMergeRequestPipelines: [{ status }] for a PR's head. */
export async function ghListPullRequestPipelines(
  auth: GitHubAuth,
  projectPath: string,
  prNumber: number,
): Promise<Array<{ status: string }> | null> {
  const pr = await ghGet<{ head?: { sha?: string } }>(auth, `/repos/${projectPath}/pulls/${prNumber}`);
  const sha = pr?.head?.sha;
  if (!sha) return null;
  const checks = await ghGet<{ check_runs?: GitHubCheckRun[] }>(
    auth,
    `/repos/${projectPath}/commits/${sha}/check-runs?per_page=50`,
  );
  const status = mapCheckRunsToPipelineStatus(checks?.check_runs ?? []);
  return status ? [{ status }] : [];
}

/** Repo size in bytes (GitHub reports KB), or null. */
export async function ghFetchRepoSizeBytes(auth: GitHubAuth, projectPath: string): Promise<number | null> {
  const repo = await ghGet<{ size?: number }>(auth, `/repos/${projectPath}`);
  return typeof repo?.size === "number" ? repo.size * 1024 : null;
}

// ── Pull request viewer (MR sidebar) ────────────────────────────────────────
// GitLab-shaped PR read/merge helpers so the conversation sidebar's MR routes
// can serve github.com PR URLs through the same response contracts they use
// for GitLab MRs.

export interface ParsedPullRequestUrl {
  /** Hostname, e.g. "github.com". */
  host: string;
  /** "owner/repo". */
  projectPath: string;
  /** Pull request number (GitLab-iid equivalent). */
  iid: number;
}

/**
 * Parse a GitHub PR URL like https://github.com/owner/repo/pull/123 into
 * { host, projectPath, iid }. Tolerates trailing tab segments (/files,
 * /checks, ...), query strings, fragments, and trailing slashes. Returns null
 * when the URL is not a valid http(s) PR URL. Pure function — no I/O.
 */
export function parsePullRequestUrl(url: string): ParsedPullRequestUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?\/?$/);
  if (!match) return null;

  const iid = Number.parseInt(match[2], 10);
  if (!Number.isFinite(iid) || iid <= 0) return null;
  return { host: parsed.hostname, projectPath: match[1], iid };
}

interface GitHubPullDetail extends GitHubPull {
  body?: string | null;
  /** Null while GitHub is still computing mergeability. */
  mergeable?: boolean | null;
  head?: { ref?: string; sha?: string };
}

/** MrInfo-shaped PR snapshot (same contract the /mr route returns for GitLab). */
export interface PullMrInfo {
  iid: number;
  projectPath: string;
  title: string;
  state: string;
  mergeStatus: string;
  webUrl: string;
  description: string;
  pipeline: { status: string; webUrl: string } | null;
}

/** Map a PR + collapsed checks status to the GitLab-shaped MrInfo contract. */
export function mapPullToMrInfo(
  projectPath: string,
  pr: GitHubPullDetail,
  pipeline: { status: string; webUrl: string } | null,
): PullMrInfo {
  const state = pr.state === "open" ? "opened" : pr.merged_at ? "merged" : "closed";
  // GitLab merge_status vocabulary: the client only enables the merge button
  // on "can_be_merged"; GitHub reports mergeable=null while it recomputes.
  const mergeStatus = pr.mergeable === true ? "can_be_merged" : pr.mergeable === false ? "cannot_be_merged" : "checking";
  return {
    iid: pr.number,
    projectPath,
    title: pr.title ?? "",
    state,
    mergeStatus,
    webUrl: pr.html_url ?? "",
    description: pr.body ?? "",
    pipeline,
  };
}

async function ghListCheckRuns(auth: GitHubAuth, projectPath: string, sha: string): Promise<GitHubCheckRun[]> {
  const checks = await ghGet<{ check_runs?: GitHubCheckRun[] }>(
    auth,
    `/repos/${projectPath}/commits/${sha}/check-runs?per_page=50`,
  );
  return checks?.check_runs ?? [];
}

/**
 * Live PR state + collapsed checks status for the sidebar card.
 * Null when the PR does not exist or GitHub is unreachable.
 */
export async function ghGetPullRequestInfo(
  auth: GitHubAuth,
  projectPath: string,
  prNumber: number,
): Promise<PullMrInfo | null> {
  const pr = await ghGet<GitHubPullDetail>(auth, `/repos/${projectPath}/pulls/${prNumber}`);
  if (!pr) return null;
  const runs = pr.head?.sha ? await ghListCheckRuns(auth, projectPath, pr.head.sha) : [];
  const status = mapCheckRunsToPipelineStatus(runs);
  const pipeline = status && pr.html_url ? { status, webUrl: `${pr.html_url}/checks` } : null;
  return mapPullToMrInfo(projectPath, pr, pipeline);
}

interface GitHubIssueComment {
  id: number;
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
}

/** Map a PR conversation comment to the GitLab-shaped MrComment contract. */
export function mapIssueCommentToMrComment(comment: GitHubIssueComment): {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
} {
  return {
    id: comment.id,
    author: comment.user?.login ?? "",
    body: comment.body ?? "",
    createdAt: comment.created_at ?? "",
    // GitHub conversation comments have no resolved flag (only review
    // threads do, which this list deliberately excludes — like the GitLab
    // route excludes inline diff notes).
    resolved: false,
  };
}

/** Chronological PR conversation comments (review/diff threads excluded). */
export async function ghListPullComments(
  auth: GitHubAuth,
  projectPath: string,
  prNumber: number,
): Promise<ReturnType<typeof mapIssueCommentToMrComment>[]> {
  const comments = await ghGet<GitHubIssueComment[]>(
    auth,
    `/repos/${projectPath}/issues/${prNumber}/comments?per_page=50`,
  );
  return (comments ?? []).map(mapIssueCommentToMrComment);
}

interface GitHubNamedCheckRun extends GitHubCheckRun {
  name?: string;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** Map one check run to the GitLab-shaped pipeline-job contract. */
export function mapCheckRunToJob(run: GitHubNamedCheckRun): {
  name: string;
  status: string;
  webUrl: string;
  duration: number | null;
} {
  let status: string;
  if (run.status !== "completed") {
    status = run.status === "in_progress" ? "running" : "pending";
  } else if (run.conclusion === "success") {
    status = "success";
  } else if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required") {
    status = "failed";
  } else if (run.conclusion === "cancelled") {
    status = "canceled";
  } else {
    status = "skipped"; // skipped / neutral / stale
  }
  const started = run.started_at ? Date.parse(run.started_at) : NaN;
  const completed = run.completed_at ? Date.parse(run.completed_at) : NaN;
  const duration =
    Number.isFinite(started) && Number.isFinite(completed) && completed >= started
      ? (completed - started) / 1000
      : null;
  return { name: run.name ?? "", status, webUrl: run.html_url ?? "", duration };
}

/**
 * The PR head's check runs as a single GitLab-shaped pipeline stage for the
 * card's pipeline-progress section. Null when no checks have run (matching
 * the GitLab route's "no pipeline yet" contract).
 */
export async function ghGetPullChecksProgress(
  auth: GitHubAuth,
  projectPath: string,
  prNumber: number,
): Promise<{
  pipeline: { id: number; status: string; webUrl: string };
  stages: Array<{ name: string; status: string; jobs: ReturnType<typeof mapCheckRunToJob>[] }>;
} | null> {
  const pr = await ghGet<GitHubPullDetail>(auth, `/repos/${projectPath}/pulls/${prNumber}`);
  const sha = pr?.head?.sha;
  if (!sha) return null;
  const runs = (await ghListCheckRuns(auth, projectPath, sha)) as GitHubNamedCheckRun[];
  if (runs.length === 0) return null;
  const status = mapCheckRunsToPipelineStatus(runs) ?? "pending";
  return {
    pipeline: { id: prNumber, status, webUrl: `${pr?.html_url ?? ""}/checks` },
    stages: [{ name: "checks", status, jobs: runs.map(mapCheckRunToJob) }],
  };
}

export type MergePullRequestResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_mergeable" | "unauthorized" | "not_found" | "conflict" | "error";
      status: number | null;
      message: string;
    };

/**
 * Merge a pull request via PUT /repos/:owner/:repo/pulls/:number/merge,
 * mapping GitHub's failure statuses onto the same reason vocabulary the
 * GitLab merge route uses. Never throws.
 */
export async function ghMergePullRequest(
  auth: GitHubAuth,
  projectPath: string,
  prNumber: number,
): Promise<MergePullRequestResult> {
  const path = `/repos/${projectPath}/pulls/${prNumber}/merge`;
  try {
    const res = await fetch(`${API}${path}`, {
      method: "PUT",
      headers: { ...headers(auth), "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const body = await res.text();
    logger.warn({ status: res.status, body, projectPath, prNumber }, "GitHub merge PR failed");
    switch (res.status) {
      case 405: // not mergeable (failing checks, draft, branch protection)
      case 422: // validation failed
        return { ok: false, reason: "not_mergeable", status: 405, message: "The pull request is not in a mergeable state" };
      case 401:
      case 403:
        return { ok: false, reason: "unauthorized", status: res.status, message: "The GitHub token is not allowed to merge this pull request" };
      case 404:
        return { ok: false, reason: "not_found", status: 404, message: "Pull request not found" };
      case 409:
        return { ok: false, reason: "conflict", status: 409, message: "The pull request head changed while merging (try again)" };
      default:
        return { ok: false, reason: "error", status: res.status, message: `GitHub merge failed (HTTP ${res.status})` };
    }
  } catch (err) {
    logger.warn({ err, projectPath, prNumber }, "GitHub merge PR error");
    return { ok: false, reason: "error", status: null, message: "GitHub is unreachable" };
  }
}
