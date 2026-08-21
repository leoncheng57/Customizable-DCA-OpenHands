// server/gitlab.ts
//
// Lightweight GitLab REST API client.
// Standalone functions with an auth object.

import { logger } from "./logger.js";

const TIMEOUT_MS = 15_000;

/** Default GitLab host. */
export const GITLAB_COM = "https://gitlab.com";

/**
 * Which GitLab credential a read-only feature should use.
 *
 * GITLAB_TOKEN wins. GITLAB_COM_TOKEN is a legacy fallback from a migration
 * window when GITLAB_TOKEN meant a self-hosted instance. Several features
 * preferred the leftover, which is why they read as "no credential" on
 * deployments that had one all along. Kept as a fallback only so a deployment
 * that did set it does not regress.
 */
export function resolveGitlabAuth(config: {
  gitlab: { readToken?: string; baseUrl?: string };
  gitlabCom: { token?: string };
}): { token?: string; baseUrl: string } {
  const baseUrl = config.gitlab.baseUrl ?? GITLAB_COM;
  // The fallback is host-specific by name and by definition, so it is only offered when the host
  // is actually gitlab.com. Otherwise a deployment pointed at a self-hosted instance with only the
  // leftover set would send a gitlab.com credential to it. Being unauthenticated is a visible
  // failure; sending a token to the wrong host is not.
  const fallback = baseUrl === GITLAB_COM ? config.gitlabCom.token : undefined;
  return { token: config.gitlab.readToken ?? fallback, baseUrl };
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface GitLabAuth {
  baseUrl: string; // e.g. "https://gitlab.example.com"
  token: string;   // PRIVATE-TOKEN value
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function apiBase(auth: GitLabAuth): string {
  return `${auth.baseUrl.replace(/\/+$/, "")}/api/v4`;
}

/**
 * Extract the GitLab project path from a repo URL.
 *
 * "https://gitlab.example.com/group/foo/bar.git" -> "group/foo/bar"
 *
 * Returns null if the URL cannot be parsed.
 */
export function projectPathFromUrl(repoUrl: string): string | null {
  try {
    const parsed = new URL(repoUrl);
    let path = parsed.pathname.replace(/^\//, "");
    if (path.endsWith(".git")) {
      path = path.slice(0, -4);
    }
    return path || null;
  } catch {
    return null;
  }
}

// ── searchBlobs ─────────────────────────────────────────────────────────────

export interface BlobSearchResult {
  /** File path within the repository. */
  path: string;
  basename: string;
  /** Git ref (commit SHA) the match was found on. */
  ref: string;
  /** GitLab numeric project ID the blob belongs to. */
  projectId: number;
  /** Matching content snippet. */
  data: string;
}

/**
 * GitLab code search, optionally scoped to a group.
 *
 * Searches blobs (file contents) across every project the token can see.
 * Returns matches, or an empty array on any error. Never throws.
 */
export async function searchBlobs(
  auth: GitLabAuth,
  search: string,
  options: { perPage?: number; timeoutMs?: number; groupId?: string } = {},
): Promise<BlobSearchResult[]> {
  const { perPage = 50, timeoutMs = TIMEOUT_MS, groupId } = options;
  const searchPath = groupId
    ? `/groups/${encodeURIComponent(groupId)}/search`
    : "/search";
  const url = new URL(`${apiBase(auth)}${searchPath}`);
  url.searchParams.set("scope", "blobs");
  url.searchParams.set("search", search);
  url.searchParams.set("per_page", String(perPage));

  try {
    const res = await fetch(url.toString(), {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, search }, "GitLab searchBlobs failed");
      return [];
    }
    const data = (await res.json()) as Array<{
      path?: string;
      basename?: string;
      ref?: string;
      project_id?: number;
      data?: string;
    }>;
    return data
      .filter((b) => typeof b.path === "string" && typeof b.project_id === "number")
      .map((b) => ({
        path: b.path as string,
        basename: b.basename ?? "",
        ref: b.ref ?? "main",
        projectId: b.project_id as number,
        data: b.data ?? "",
      }));
  } catch (err) {
    logger.warn({ err, search }, "GitLab searchBlobs error");
    return [];
  }
}

// ── getProjectPath ──────────────────────────────────────────────────────────

export interface GitLabProjectInfo {
  /** group/subgroup/project path. */
  path: string;
  /** Project web URL. */
  webUrl: string;
  /** Human-readable project name. */
  name: string;
  /** Project description, when set. */
  description: string;
}

/**
 * Resolve a project's path, web URL, name, and description from its numeric ID
 * (GET /api/v4/projects/:id). Returns null on any error. Never throws.
 */
export async function getProjectPath(
  auth: GitLabAuth,
  projectId: number,
  options: { timeoutMs?: number } = {},
): Promise<GitLabProjectInfo | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  try {
    const res = await fetch(`${apiBase(auth)}/projects/${projectId}`, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      path_with_namespace?: string;
      web_url?: string;
      name?: string;
      description?: string;
    };
    if (!data.path_with_namespace) return null;
    return {
      path: data.path_with_namespace,
      webUrl: data.web_url ?? "",
      name: data.name ?? data.path_with_namespace.split("/").pop() ?? "",
      description: data.description ?? "",
    };
  } catch (err) {
    logger.warn({ err, projectId }, "GitLab getProjectPath error");
    return null;
  }
}

// ── getFileContent ──────────────────────────────────────────────────────────

/**
 * Fetch raw file content from a GitLab repository.
 *
 * Uses GET /api/v4/projects/:id/repository/files/:path/raw
 *
 * Returns the file content as a string, or null on any error (missing file,
 * network failure, etc.). Never throws.
 */
export interface FileContentResult {
  content: string | null;
  /** HTTP status of the fetch (e.g. 200/403/404), or null if the request threw (network/timeout). */
  status: number | null;
}

export async function getFileContentResult(
  auth: GitLabAuth,
  projectPath: string,
  filePath: string,
  ref = "main",
  options: { timeoutMs?: number } = {},
): Promise<FileContentResult> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const encodedFile = encodeURIComponent(filePath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/repository/files/${encodedFile}/raw?ref=${encodeURIComponent(ref)}`;

  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, projectPath, filePath, ref },
        "GitLab getFileContent failed",
      );
      return { content: null, status: res.status };
    }

    return { content: await res.text(), status: res.status };
  } catch (err) {
    logger.warn({ err, projectPath, filePath }, "GitLab getFileContent error");
    return { content: null, status: null };
  }
}

/** Back-compat wrapper: just the file content (null on any failure). */
export async function getFileContent(
  auth: GitLabAuth,
  projectPath: string,
  filePath: string,
  ref = "main",
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  return (await getFileContentResult(auth, projectPath, filePath, ref, options)).content;
}

// ── listRepositoryTree ──────────────────────────────────────────────────────

export interface RepositoryTreeEntry {
  path: string;
  type: "tree" | "blob";
}

/**
 * List files/directories in a GitLab repository path.
 *
 * Uses GET /api/v4/projects/:id/repository/tree with pagination
 * (up to 5 pages of 100 entries).
 *
 * Returns the entries, or null on any error (missing path, network
 * failure, etc.). Never throws.
 */
export async function listRepositoryTree(
  auth: GitLabAuth,
  projectPath: string,
  path: string,
  options: { ref?: string; recursive?: boolean; timeoutMs?: number } = {},
): Promise<RepositoryTreeEntry[] | null> {
  const { ref = "main", recursive = false, timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const entries: RepositoryTreeEntry[] = [];

  try {
    for (let page = 1; page <= 5; page++) {
      const url = new URL(`${apiBase(auth)}/projects/${encodedProject}/repository/tree`);
      url.searchParams.set("path", path);
      url.searchParams.set("ref", ref);
      url.searchParams.set("recursive", String(recursive));
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const res = await fetch(url.toString(), {
        headers: { "PRIVATE-TOKEN": auth.token },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        logger.warn({ status: res.status, projectPath, path, ref }, "GitLab listRepositoryTree failed");
        return null;
      }

      const data = (await res.json()) as Array<{ path?: string; type?: string }>;
      for (const entry of data) {
        if (typeof entry.path !== "string") continue;
        entries.push({ path: entry.path, type: entry.type === "tree" ? "tree" : "blob" });
      }

      if (data.length < 100) break;
    }
    return entries;
  } catch (err) {
    logger.warn({ err, projectPath, path }, "GitLab listRepositoryTree error");
    return null;
  }
}

// ── getLatestCommitDate ─────────────────────────────────────────────────────

/**
 * Get the committed date (ISO string) of the most recent commit touching a
 * path in a GitLab repository.
 *
 * Uses GET /api/v4/projects/:id/repository/commits?path=...&per_page=1
 *
 * Returns the ISO date string, or null on any error or when the path has no
 * commits. Never throws.
 */
export async function getLatestCommitDate(
  auth: GitLabAuth,
  projectPath: string,
  path: string,
  options: { ref?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const { ref = "main", timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = new URL(`${apiBase(auth)}/projects/${encodedProject}/repository/commits`);
  url.searchParams.set("path", path);
  url.searchParams.set("ref_name", ref);
  url.searchParams.set("per_page", "1");

  try {
    const res = await fetch(url.toString(), {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.warn({ status: res.status, projectPath, path }, "GitLab getLatestCommitDate failed");
      return null;
    }

    const data = (await res.json()) as Array<{ committed_date?: string }>;
    return data[0]?.committed_date ?? null;
  } catch (err) {
    logger.warn({ err, projectPath, path }, "GitLab getLatestCommitDate error");
    return null;
  }
}

// ── findMergeRequests ───────────────────────────────────────────────────────

export interface MergeRequestSearchParams {
  state?: "opened" | "closed" | "merged" | "all";
  source_branch?: string;
  search?: string;
  in?: string;
  labels?: string;
  order_by?: string;
  sort?: "asc" | "desc";
  per_page?: number;
}

export interface MergeRequestSummary {
  iid: number;
  web_url: string;
  source_branch: string;
  title: string;
  state: string;
  merged_at: string | null;
  author: { username: string; name: string } | null;
  labels: string[];
  reviewers: Array<{ id: number; username: string }>;
}

/**
 * Search for merge requests in a GitLab project.
 *
 * Uses GET /api/v4/projects/:id/merge_requests with query params.
 *
 * Returns an array of MR summaries, or an empty array on error. Never throws.
 */
export async function findMergeRequests(
  auth: GitLabAuth,
  projectPath: string,
  params: MergeRequestSearchParams = {},
  options: { timeoutMs?: number } = {},
): Promise<MergeRequestSummary[]> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = new URL(`${apiBase(auth)}/projects/${encodedProject}/merge_requests`);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, projectPath },
        "GitLab findMergeRequests failed",
      );
      return [];
    }

    const data = (await res.json()) as Array<{
      iid: number;
      web_url?: string;
      source_branch?: string;
      title?: string;
      state?: string;
      merged_at?: string | null;
      author?: { username: string; name: string };
      labels?: string[];
      reviewers?: Array<{ id: number; username: string }>;
    }>;

    return data.map((mr) => ({
      iid: mr.iid,
      web_url: mr.web_url ?? "",
      source_branch: mr.source_branch ?? "",
      title: mr.title ?? "",
      state: mr.state ?? "",
      merged_at: mr.merged_at ?? null,
      author: mr.author ?? null,
      labels: mr.labels ?? [],
      reviewers: (mr.reviewers ?? []).filter((r) => r.id),
    }));
  } catch (err) {
    logger.warn({ err, projectPath }, "GitLab findMergeRequests error");
    return [];
  }
}

// ── findIssues ───────────────────────────────────────────────────────────────

export interface IssueSearchParams {
  state?: "opened" | "closed" | "all";
  /**
   * Which issues to list relative to the token's user. GitLab's project issues
   * endpoint defaults to `created_by_me`, so a discovery caller that wants
   * everyone's issues (not just ones the bot opened) MUST pass `scope: "all"`.
   */
  scope?: "created_by_me" | "assigned_to_me" | "all";
  /** "None" = unassigned, "Any" = assigned to anyone, or a numeric user id. */
  assignee_id?: "None" | "Any" | number;
  labels?: string;
  /** Exclude issues carrying any of these labels (GitLab `not[labels]`). */
  not_labels?: string;
  order_by?: "created_at" | "updated_at" | "priority" | "popularity";
  sort?: "asc" | "desc";
  per_page?: number;
}

export interface IssueSummary {
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
  labels: string[];
  assignees: Array<{ username: string }>;
  created_at: string;
  updated_at: string;
  user_notes_count: number;
  upvotes: number;
  has_tasks: boolean;
}

/**
 * List issues in a GitLab project.
 *
 * Uses GET /api/v4/projects/:id/issues with query params. Returns an array of
 * issue summaries, or an empty array on any error. Never throws — this is a
 * read-only discovery helper, so a failed lookup must not surface as a crash.
 */
export async function findIssues(
  auth: GitLabAuth,
  projectPath: string,
  params: IssueSearchParams = {},
  options: { timeoutMs?: number } = {},
): Promise<IssueSummary[]> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = new URL(`${apiBase(auth)}/projects/${encodedProject}/issues`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // GitLab spells "exclude these labels" as not[labels].
    url.searchParams.set(k === "not_labels" ? "not[labels]" : k, String(v));
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath }, "GitLab findIssues failed");
      return [];
    }
    const data = (await res.json()) as Array<{
      iid?: number;
      project_id?: number;
      title?: string;
      web_url?: string;
      state?: string;
      labels?: string[];
      assignees?: Array<{ username?: string }>;
      created_at?: string;
      updated_at?: string;
      user_notes_count?: number;
      upvotes?: number;
      has_tasks?: boolean;
    }>;
    return data
      .filter((i) => typeof i.iid === "number")
      .map((i) => ({
        iid: i.iid as number,
        project_id: i.project_id ?? 0,
        title: i.title ?? "",
        web_url: i.web_url ?? "",
        state: i.state ?? "",
        labels: i.labels ?? [],
        assignees: (i.assignees ?? []).filter((a) => a.username).map((a) => ({ username: a.username as string })),
        created_at: i.created_at ?? "",
        updated_at: i.updated_at ?? "",
        user_notes_count: i.user_notes_count ?? 0,
        upvotes: i.upvotes ?? 0,
        has_tasks: Boolean(i.has_tasks),
      }));
  } catch (err) {
    logger.warn({ err, projectPath }, "GitLab findIssues error");
    return [];
  }
}

// ── fetchMrDiscussions ────────────────────────────────────────────────────

export interface MrDiscussionNote {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  system: boolean;
  resolved: boolean;
  position?: {
    newPath?: string;
    newLine?: number;
    oldPath?: string;
    oldLine?: number;
  };
}

export interface MrDiscussion {
  id: string;
  notes: MrDiscussionNote[];
  resolved: boolean;
}

/**
 * Fetch all discussion threads on a merge request.
 * Returns discussions with their notes, filtered to non-system notes.
 */
export async function fetchMrDiscussions(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  options: { timeoutMs?: number } = {},
): Promise<MrDiscussion[]> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const discussions: MrDiscussion[] = [];

  try {
    for (let page = 1; page <= 10; page++) {
      const url = new URL(
        `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${mrIid}/discussions`,
      );
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const res = await fetch(url.toString(), {
        headers: { "PRIVATE-TOKEN": auth.token },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        logger.warn({ status: res.status, mrIid }, "GitLab fetchMrDiscussions failed");
        break;
      }

      const data = (await res.json()) as Array<{
        id: string;
        notes?: Array<{
          id: number;
          author?: { username?: string };
          body?: string;
          created_at?: string;
          system?: boolean;
          resolved?: boolean;
          resolvable?: boolean;
          position?: {
            new_path?: string;
            new_line?: number;
            old_path?: string;
            old_line?: number;
          };
        }>;
      }>;

      for (const disc of data) {
        const notes = (disc.notes ?? [])
          .filter((n) => !n.system)
          .map((n) => ({
            id: n.id,
            author: n.author?.username ?? "unknown",
            body: n.body ?? "",
            createdAt: n.created_at ?? "",
            system: !!n.system,
            resolved: !!n.resolved,
            position: n.position
              ? {
                  newPath: n.position.new_path,
                  newLine: n.position.new_line,
                  oldPath: n.position.old_path,
                  oldLine: n.position.old_line,
                }
              : undefined,
          }));

        if (notes.length > 0) {
          const allResolved = notes.every((n) => n.resolved);
          discussions.push({ id: disc.id, notes, resolved: allResolved });
        }
      }

      if (data.length < 100) break;
    }
  } catch (err) {
    logger.warn({ err, mrIid }, "GitLab fetchMrDiscussions error");
  }

  return discussions;
}

/**
 * Resolve a GitLab project ID from a project path (e.g. "group/subgroup/foo" → 12345).
 */
export async function getProjectId(
  auth: GitLabAuth,
  projectPath: string,
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  try {
    const res = await fetch(`${apiBase(auth)}/projects/${encodedProject}`, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    return typeof data.id === "number" ? data.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a GitLab project's default branch (e.g. "main", "master").
 * Returns "main" on any error. Never throws.
 */
export async function getDefaultBranch(
  auth: GitLabAuth,
  projectPath: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  try {
    const res = await fetch(`${apiBase(auth)}/projects/${encodedProject}?statistics=false`, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return "main";
    const data = (await res.json()) as { default_branch?: string };
    return data.default_branch || "main";
  } catch {
    return "main";
  }
}

// ── addNoteAwardEmoji ─────────────────────────────────────────────────────

/**
 * Add an award emoji reaction to a merge request note.
 * Ignores "already exists" errors (idempotent). Never throws.
 */
export async function addNoteAwardEmoji(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  noteId: number,
  emoji = "bee",
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${mrIid}/notes/${noteId}/award_emoji`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: emoji }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // GitLab returns 404/400 with "has already been taken" for a
      // duplicate award — treat that as success (idempotent).
      const text = await res.text().catch(() => "");
      if (/already been taken|already exists/i.test(text)) {
        return true;
      }
      logger.warn({ status: res.status, mrIid, noteId, emoji }, "GitLab addAwardEmoji failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, mrIid, noteId }, "GitLab addAwardEmoji error");
    return false;
  }
}

// ── postMrNote ──────────────────────────────────────────────────────────────

/**
 * Post a comment (note) on a merge request. Returns the created note id, or
 * null on failure. Never throws.
 */
export async function postMrNote(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  body: string,
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${mrIid}/notes`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": auth.token, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, mrIid }, "GitLab postMrNote failed");
      return null;
    }
    const data = (await res.json()) as { id?: number };
    return data.id ?? null;
  } catch (err) {
    logger.warn({ err, mrIid }, "GitLab postMrNote error");
    return null;
  }
}

// ── Write Operations ────────────────────────────────────────────────────────

/**
 * Create a new branch in a project.
 */
export async function createBranch(
  auth: GitLabAuth,
  project: string,
  branch: string,
  ref: string,
): Promise<{ name: string; commit: { id: string } } | null> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(project)}/repository/branches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": auth.token, "Content-Type": "application/json" },
      body: JSON.stringify({ branch, ref }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body, branch }, "GitLab createBranch failed");
      return null;
    }
    return (await res.json()) as { name: string; commit: { id: string } };
  } catch (err) {
    logger.warn({ err, branch }, "GitLab createBranch error");
    return null;
  }
}

/**
 * Delete a branch from a project.
 */
export async function deleteBranch(
  auth: GitLabAuth,
  project: string,
  branch: string,
): Promise<boolean> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(project)}/repository/branches/${encodeURIComponent(branch)}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok || res.status === 404; // 404 means already gone
  } catch (err) {
    logger.warn({ err, branch }, "GitLab deleteBranch error");
    return false;
  }
}

export interface CommitAction {
  action: "create" | "update" | "delete";
  file_path: string;
  content?: string;
}

/**
 * Commit one or more file changes to a branch.
 */
export async function commitFiles(
  auth: GitLabAuth,
  project: string,
  branch: string,
  commitMessage: string,
  actions: CommitAction[],
): Promise<{ id: string; short_id: string } | null> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(project)}/repository/commits`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": auth.token, "Content-Type": "application/json" },
      body: JSON.stringify({ branch, commit_message: commitMessage, actions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body, branch }, "GitLab commitFiles failed");
      return null;
    }
    return (await res.json()) as { id: string; short_id: string };
  } catch (err) {
    logger.warn({ err, branch }, "GitLab commitFiles error");
    return null;
  }
}

export interface MergeRequestResult {
  iid: number;
  web_url: string;
  state: string;
  merge_status: string;
  title: string;
  /** Raw markdown description; GitLab sends null when the MR has none. */
  description?: string | null;
}

/**
 * Create a merge request.
 */
export async function createMergeRequest(
  auth: GitLabAuth,
  project: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description: string,
): Promise<MergeRequestResult | null> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(project)}/merge_requests`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": auth.token, "Content-Type": "application/json" },
      body: JSON.stringify({
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
        remove_source_branch: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body, sourceBranch }, "GitLab createMergeRequest failed");
      return null;
    }
    return (await res.json()) as MergeRequestResult;
  } catch (err) {
    logger.warn({ err, sourceBranch }, "GitLab createMergeRequest error");
    return null;
  }
}

/**
 * Get a merge request by IID.
 */
export async function getMergeRequest(
  auth: GitLabAuth,
  project: string,
  mrIid: number,
): Promise<MergeRequestResult | null> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(project)}/merge_requests/${mrIid}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as MergeRequestResult;
  } catch (err) {
    logger.warn({ err, mrIid }, "GitLab getMergeRequest error");
    return null;
  }
}

// ── mergeMergeRequest ───────────────────────────────────────────────────────

export type MergeMergeRequestResult =
  | { ok: true; mr: MergeRequestResult }
  | {
      ok: false;
      /** Machine-readable failure class for the caller to map to UI/HTTP. */
      reason: "not_mergeable" | "unauthorized" | "not_found" | "conflict" | "error";
      /** HTTP status GitLab returned, or null when the request itself failed. */
      status: number | null;
      message: string;
    };

/**
 * Accept (merge) a merge request via PUT /projects/:id/merge_requests/:iid/merge.
 *
 * Returns a structured result instead of throwing:
 *   - 405 → not_mergeable (draft, failed pipeline, unresolved discussions, …)
 *   - 401/403 → unauthorized (token lacks permission on the project)
 *   - 404 → not_found
 *   - 409 → conflict (SHA moved / merge already in progress)
 * Never throws.
 */
export async function mergeMergeRequest(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  options: { timeoutMs?: number } = {},
): Promise<MergeMergeRequestResult> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}/merge`;
  const { timeoutMs = TIMEOUT_MS } = options;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "PRIVATE-TOKEN": auth.token, "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      return { ok: true, mr: (await res.json()) as MergeRequestResult };
    }
    const body = await res.text();
    logger.warn({ status: res.status, body, projectPath, mrIid }, "GitLab mergeMergeRequest failed");
    switch (res.status) {
      case 405:
        return { ok: false, reason: "not_mergeable", status: 405, message: "The merge request is not in a mergeable state" };
      case 401:
      case 403:
        return { ok: false, reason: "unauthorized", status: res.status, message: "The GitLab token is not allowed to merge this merge request" };
      case 404:
        return { ok: false, reason: "not_found", status: 404, message: "Merge request not found" };
      case 409:
        return { ok: false, reason: "conflict", status: 409, message: "The merge request changed while merging (try again)" };
      default:
        return { ok: false, reason: "error", status: res.status, message: `GitLab merge failed (HTTP ${res.status})` };
    }
  } catch (err) {
    logger.warn({ err, projectPath, mrIid }, "GitLab mergeMergeRequest error");
    return { ok: false, reason: "error", status: null, message: "GitLab is unreachable" };
  }
}

// ── parseMergeRequestUrl ────────────────────────────────────────────────────

export interface ParsedMergeRequestUrl {
  /** Hostname of the GitLab instance, e.g. "gitlab.com". */
  host: string;
  /** Full project path, e.g. "group/subgroup/project". */
  projectPath: string;
  /** Merge request internal ID (iid). */
  iid: number;
}

/**
 * Parse a GitLab MR URL like
 *   https://gitlab.com/group/subgroup/project/-/merge_requests/123
 * into { host, projectPath, iid }.
 *
 * Tolerates trailing tab segments (/diffs, /commits, ...), query strings,
 * fragments, and trailing slashes. Returns null when the URL is not a valid
 * http(s) GitLab MR URL. Pure function — no I/O.
 */
export function parseMergeRequestUrl(url: string): ParsedMergeRequestUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  // Path shape: /<group>/<...>/<project>/-/merge_requests/<iid>[/...]
  const match = parsed.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?\/?$/);
  if (!match) return null;

  const projectPath = match[1].replace(/\/+$/, "");
  const iid = Number.parseInt(match[2], 10);
  if (!projectPath || !Number.isFinite(iid) || iid <= 0) return null;

  return { host: parsed.hostname, projectPath, iid };
}

// ── getMergeRequestDetails ─────────────────────────────────────────────────

export interface MergeRequestDetails {
  iid: number;
  title: string;
  description: string;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: { username: string; name: string } | null;
  created_at: string;
  updated_at: string;
  changes_count: string | null;
  /** Null unless merged. `state` says merged but not when, and when is what dates a release. */
  merged_at: string | null;
  /** The commit the merge produced, which a tag has to contain for the change to be released. */
  merge_commit_sha: string | null;
}

/**
 * Fetch full merge request details (title, description, author, branches).
 *
 * Uses GET /api/v4/projects/:id/merge_requests/:iid
 *
 * Returns the details, or null on any error. Never throws.
 */
export async function getMergeRequestDetails(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  options: { timeoutMs?: number } = {},
): Promise<MergeRequestDetails | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${mrIid}`;

  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath, mrIid }, "GitLab getMergeRequestDetails failed");
      return null;
    }
    const data = (await res.json()) as {
      iid: number;
      title?: string;
      description?: string | null;
      state?: string;
      web_url?: string;
      source_branch?: string;
      target_branch?: string;
      author?: { username: string; name: string };
      created_at?: string;
      updated_at?: string;
      changes_count?: string | null;
      merged_at?: string | null;
      merge_commit_sha?: string | null;
    };
    return {
      iid: data.iid,
      title: data.title ?? "",
      description: data.description ?? "",
      state: data.state ?? "",
      web_url: data.web_url ?? "",
      source_branch: data.source_branch ?? "",
      target_branch: data.target_branch ?? "",
      author: data.author ?? null,
      created_at: data.created_at ?? "",
      updated_at: data.updated_at ?? "",
      changes_count: data.changes_count ?? null,
      merged_at: data.merged_at ?? null,
      merge_commit_sha: data.merge_commit_sha ?? null,
    };
  } catch (err) {
    logger.warn({ err, projectPath, mrIid }, "GitLab getMergeRequestDetails error");
    return null;
  }
}

// ── getMergeRequestChanges ─────────────────────────────────────────────────

export interface MergeRequestFileChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

/**
 * Fetch the file changes (diffs) for a merge request.
 *
 * Uses GET /api/v4/projects/:id/merge_requests/:iid/changes — the same
 * endpoint the platform GitLab MCP tool wraps (platform/mcp/gitlab.ts),
 * exposed here for deterministic route-level ingestion.
 *
 * Returns the changes, or null on any error. Never throws.
 */
export async function getMergeRequestChanges(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  options: { timeoutMs?: number } = {},
): Promise<MergeRequestFileChange[] | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${mrIid}/changes`;

  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath, mrIid }, "GitLab getMergeRequestChanges failed");
      return null;
    }
    const data = (await res.json()) as {
      changes?: Array<{
        old_path?: string;
        new_path?: string;
        diff?: string;
        new_file?: boolean;
        deleted_file?: boolean;
        renamed_file?: boolean;
      }>;
    };
    return (data.changes ?? []).map((c) => ({
      old_path: c.old_path ?? "",
      new_path: c.new_path ?? "",
      diff: c.diff ?? "",
      new_file: !!c.new_file,
      deleted_file: !!c.deleted_file,
      renamed_file: !!c.renamed_file,
    }));
  } catch (err) {
    logger.warn({ err, projectPath, mrIid }, "GitLab getMergeRequestChanges error");
    return null;
  }
}

// ── findUserByUsername ─────────────────────────────────────────────────────

/**
 * Resolve a GitLab user ID from a username (exact match).
 * Returns the user ID, or null if not found. Never throws.
 */
export async function findUserByUsername(
  auth: GitLabAuth,
  username: string,
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  if (!username) return null;
  const { timeoutMs = TIMEOUT_MS } = options;
  const url = new URL(`${apiBase(auth)}/users`);
  url.searchParams.set("username", username);

  try {
    const res = await fetch(url.toString(), {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const users = (await res.json()) as Array<{ id: number }>;
    return users[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err, username }, "GitLab findUserByUsername error");
    return null;
  }
}

// ── findTokenOwnerUserId ──────────────────────────────────────────────────

/**
 * Return the GitLab user ID that owns the provided token. Never throws.
 */
export async function findTokenOwnerUserId(
  auth: GitLabAuth,
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  try {
    const res = await fetch(`${apiBase(auth)}/user`, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    return typeof data.id === "number" ? data.id : null;
  } catch (err) {
    logger.warn({ err }, "GitLab findTokenOwnerUserId error");
    return null;
  }
}

// ── updateMergeRequest ────────────────────────────────────────────────────

/**
 * Update a merge request (assignees, reviewers, etc.).
 * Accepts a partial update object — only the provided fields are changed.
 * Never throws.
 */
export async function updateMergeRequest(
  auth: GitLabAuth,
  projectPath: string,
  mrIid: number,
  update: { assignee_ids?: number[]; reviewer_ids?: number[] },
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${mrIid}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "PRIVATE-TOKEN": auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, mrIid, projectPath }, "GitLab updateMergeRequest failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, mrIid, projectPath }, "GitLab updateMergeRequest error");
    return false;
  }
}

// ── Release plumbing: tags, pipelines, triggers ──────────────────────────────
//
// Added for the client-library release dashboard. The read side (tags, pipelines) answers "is this
// library ready to release"; the write side (triggerPipeline) starts the existing `bump-version`
// job, which opens a merge request and does not publish anything.
//
// There is deliberately no createTag here. On these repositories a tag matching `v*.*.*` is what
// fires the publish jobs, and npm cannot unpublish after 72 hours while Maven Central and
// Packagist are worse. Tagging belongs to a person for now.

export interface GitLabTag {
  name: string;
  /** ISO date of the commit the tag points at, not of the tag object. */
  committedDate: string | null;
  commitId: string | null;
}

/**
 * The project's tags, newest first as GitLab orders them by update date.
 * Returns null on any failure, so callers can tell "no tags" from "could not ask".
 */
export async function listTags(
  auth: GitLabAuth,
  projectPath: string,
  options: { perPage?: number; timeoutMs?: number } = {},
): Promise<GitLabTag[] | null> {
  const { perPage = 20, timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/repository/tags?per_page=${perPage}`;
  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath }, "GitLab listTags failed");
      return null;
    }
    const data = (await res.json()) as { name?: string; commit?: { id?: string; committed_date?: string } }[];
    return data.map((t) => ({
      name: String(t.name ?? ""),
      committedDate: t.commit?.committed_date ?? null,
      commitId: t.commit?.id ?? null,
    }));
  } catch (err) {
    logger.warn({ err, projectPath }, "GitLab listTags error");
    return null;
  }
}

export interface GitLabCompare {
  /** Commits on `to` that are not on `from`. */
  commits: { id: string; title: string; authorName: string; createdAt: string }[];
  /** GitLab caps a comparison; when true there are more commits than are listed here. */
  truncated: boolean;
}

/**
 * What has landed on a branch since a tag. This is the "is there anything to release" signal, and
 * the commit subjects are what tell a human whether it is worth releasing.
 */
export async function compareRefs(
  auth: GitLabAuth,
  projectPath: string,
  from: string,
  to: string,
  options: { timeoutMs?: number } = {},
): Promise<GitLabCompare | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/repository/compare`
    + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=false`;
  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath, from, to }, "GitLab compareRefs failed");
      return null;
    }
    const data = (await res.json()) as {
      commits?: { id?: string; title?: string; author_name?: string; created_at?: string }[];
      compare_timeout?: boolean;
    };
    return {
      commits: (data.commits ?? []).map((c) => ({
        id: String(c.id ?? ""),
        title: String(c.title ?? ""),
        authorName: String(c.author_name ?? ""),
        createdAt: String(c.created_at ?? ""),
      })),
      truncated: Boolean(data.compare_timeout),
    };
  } catch (err) {
    logger.warn({ err, projectPath, from, to }, "GitLab compareRefs error");
    return null;
  }
}

export interface GitLabPipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
}

export async function listPipelines(
  auth: GitLabAuth,
  projectPath: string,
  options: { ref?: string; perPage?: number; timeoutMs?: number } = {},
): Promise<GitLabPipeline[] | null> {
  const { ref, perPage = 5, timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const query = new URLSearchParams({ per_page: String(perPage) });
  if (ref) query.set("ref", ref);
  const url = `${apiBase(auth)}/projects/${encodedProject}/pipelines?${query}`;
  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath }, "GitLab listPipelines failed");
      return null;
    }
    const data = (await res.json()) as {
      id?: number; status?: string; ref?: string; sha?: string; web_url?: string;
      created_at?: string; updated_at?: string;
    }[];
    return data.map((p) => ({
      id: Number(p.id ?? 0),
      status: String(p.status ?? "unknown"),
      ref: String(p.ref ?? ""),
      sha: String(p.sha ?? ""),
      webUrl: String(p.web_url ?? ""),
      createdAt: String(p.created_at ?? ""),
      updatedAt: String(p.updated_at ?? ""),
    }));
  } catch (err) {
    logger.warn({ err, projectPath }, "GitLab listPipelines error");
    return null;
  }
}

/**
 * Pipelines that ran for a merge request, latest first (GitLab's default
 * ordering for GET /projects/:id/merge_requests/:iid/pipelines).
 * Returns null on any failure, so callers can tell "no pipelines" from
 * "could not ask". Never throws.
 */
export async function listMergeRequestPipelines(
  auth: GitLabAuth,
  projectPath: string,
  iid: number,
  options: { timeoutMs?: number } = {},
): Promise<GitLabPipeline[] | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/merge_requests/${iid}/pipelines`;
  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath, iid }, "GitLab listMergeRequestPipelines failed");
      return null;
    }
    const data = (await res.json()) as {
      id?: number; status?: string; ref?: string; sha?: string; web_url?: string;
      created_at?: string; updated_at?: string;
    }[];
    return data.map((p) => ({
      id: Number(p.id ?? 0),
      status: String(p.status ?? "unknown"),
      ref: String(p.ref ?? ""),
      sha: String(p.sha ?? ""),
      webUrl: String(p.web_url ?? ""),
      createdAt: String(p.created_at ?? ""),
      updatedAt: String(p.updated_at ?? ""),
    }));
  } catch (err) {
    logger.warn({ err, projectPath, iid }, "GitLab listMergeRequestPipelines error");
    return null;
  }
}

export interface GitLabPipelineJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  webUrl: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Seconds, as reported by GitLab; null while the job has not run. */
  duration: number | null;
}

/**
 * Jobs of a single pipeline (one page, up to 100 — enough for this repo's
 * pipelines). Returns null on any failure, so callers can tell "no jobs"
 * from "could not ask". Never throws.
 */
export async function listPipelineJobs(
  auth: GitLabAuth,
  projectPath: string,
  pipelineId: number,
  options: { timeoutMs?: number } = {},
): Promise<GitLabPipelineJob[] | null> {
  const { timeoutMs = TIMEOUT_MS } = options;
  const encodedProject = encodeURIComponent(projectPath);
  const url = `${apiBase(auth)}/projects/${encodedProject}/pipelines/${pipelineId}/jobs?per_page=100`;
  try {
    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, projectPath, pipelineId }, "GitLab listPipelineJobs failed");
      return null;
    }
    const data = (await res.json()) as {
      id?: number; name?: string; stage?: string; status?: string; web_url?: string;
      started_at?: string | null; finished_at?: string | null; duration?: number | null;
    }[];
    return data.map((j) => ({
      id: Number(j.id ?? 0),
      name: String(j.name ?? ""),
      stage: String(j.stage ?? ""),
      status: String(j.status ?? "unknown"),
      webUrl: String(j.web_url ?? ""),
      startedAt: j.started_at ?? null,
      finishedAt: j.finished_at ?? null,
      duration: typeof j.duration === "number" ? j.duration : null,
    }));
  } catch (err) {
    logger.warn({ err, projectPath, pipelineId }, "GitLab listPipelineJobs error");
    return null;
  }
}

// ── Narrow reads for the parity checks ──────────────────────────────────────
//
// Both follow the same rule, and it is the reason they do not reuse the helpers above: only a
// definitive answer counts. A 404 means the thing is not there. Anything else — a rejected token,
// a timeout, a 500 — means we could not look, and "could not look" must never be allowed to change
// a verdict an agent reached. So the return type is three-valued and the callers respect it.

/**
 * Does `path` exist in the project at `ref`?
 *
 * true / false are answers. null means the question could not be asked.
 */
export async function pathExistsInProject(
  auth: GitLabAuth,
  projectPath: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(projectPath)}`
    + `/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  try {
    // HEAD: GitLab returns the file metadata in headers, so nothing is transferred.
    const res = await fetchImpl(url, {
      method: "HEAD",
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

/** The head commit sha of `ref`, or null when it could not be read. */
export async function headShaOf(
  auth: GitLabAuth,
  projectPath: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url = `${apiBase(auth)}/projects/${encodeURIComponent(projectPath)}`
    + `/repository/commits/${encodeURIComponent(ref)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { "PRIVATE-TOKEN": auth.token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { id?: string };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}
