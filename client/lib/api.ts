// client/lib/api.ts
//
// Typed fetch helpers for the OpenHands BFF (/api/openhands). All requests
// are same-origin and authenticated by the hub's oauth2-proxy session.
import type { ChatImage } from "../../server/openhands/images.js";
import type { RawOpenHandsEvent } from "./events.js";
import type { ConversationStats } from "./statusBar.js";

export interface OpenHandsStatus {
  configured: boolean;
  allowlisted: boolean;
  publicUrl: string | null;
  server: { version?: string; uptime?: number } | null;
  /** LLM model new conversations are created with (BFF default). */
  model?: string;
  /** Server-side allowlist for new conversations. */
  models?: string[];
}

export type ToolHealthState = "ok" | "unknown" | "error";

export interface ToolsHealth {
  server: { health: ToolHealthState; version: string | null; uptime: number | null; latencyMs: number };
  tools: Array<{ id: string; description: string; health: ToolHealthState; detail?: string; latencyMs?: number }>;
  skills: Array<{ name: string; health: ToolHealthState; detail: string }>;
  mcp: Array<{ name: string; health: ToolHealthState; detail: string }>;
  integrations: Array<{ id: string; label: string; health: ToolHealthState; detail: string; latencyMs?: number }>;
  probedAt: string;
}

export interface NotificationSettings {
  enabled: boolean;
  notifyIdle: boolean;
  mentionMe: boolean;
  mentionEmails: string[];
  userEmail: string;
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyConfigured: boolean;
  ntfyFromEnv: boolean;
}

export interface CondenserSettings {
  enabled: boolean;
  maxSize: number;
  maxTokens: number | null;
  keepFirst: number;
}

export interface AgentSettings {
  condenser: CondenserSettings;
}

/** One row of GET /api/openhands/skills — see server/openhands/skills.ts. */
export interface SkillEntry {
  name: string;
  description: string;
  version: string;
  source: string;
  /** Explicitly installed (appears in the upstream installed list). */
  installed: boolean;
  /** Loaded from a source (public/user) without being explicitly installed. */
  autoLoaded: boolean;
  installEnabled: boolean;
  denied: boolean;
  /** EFFECTIVE state as the server computed it (the client re-derives it too). */
  enabled: boolean;
}

/** The three `load_*_skills` flags of the agent-server's default profile. */
export interface SkillSources {
  user: boolean;
  public: boolean;
  project: boolean;
}

export interface SkillsSettings {
  skills: SkillEntry[];
  /** Raw `agent_context.disabled_skills`, drift included. */
  disabledSkills: string[];
  sources: SkillSources;
  /** Every source is off — toggles persist but nothing gets loaded. */
  loadingDisabled: boolean;
  /** The effective-set probe failed, so auto-loaded skills may be missing. */
  loadedUnavailable: boolean;
}

export interface RepoOption {
  /** GitLab path_with_namespace, e.g. "group/subgroup/foo". */
  path: string;
  name: string;
  /** https clone URL without the .git suffix — the create form's repoUrl. */
  url: string;
}

export interface ConversationSummary {
  id: string;
  title?: string | null;
  execution_status: string;
  created_at?: string;
  updated_at?: string;
  metrics?: { accumulated_cost?: number } | null;
  /** Per-LLM cost and token usage — the source the status bar reads (issue #43). */
  stats?: ConversationStats | null;
  /** Agent config snapshot — the model this conversation actually runs on. */
  agent?: { llm?: { model?: string } } | null;
  /** Where the agent works — classifies shared-folder vs isolated mode (issue #31). */
  workspace?: { working_dir?: string | null } | null;
  /** Upstream confirmation policy — IS the Plan/Build mode (see lib/planMode). */
  confirmation_policy?: { kind?: string } | null;
}

export interface SuggestedIssue {
  iid: number;
  title: string;
  webUrl: string;
  labels: string[];
  updatedAt: string;
  commentCount: number;
  upvotes: number;
  /** Why this issue is suggested (open/unassigned/recently active …). */
  reason: string;
}

export interface SuggestedIssuesResponse {
  repo: string;
  repoUrl: string;
  items: SuggestedIssue[];
}

export interface TerminalCommand {
  id: string;
  command: string;
  cwd: string | null;
  timestamp?: string;
  exit_code: number | null;
}

export interface TerminalOutput {
  id?: string;
  timestamp?: string;
  command_id?: string;
  order?: number;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

export interface WorkspaceRepo {
  name: string;
  path: string;
}

export interface WorkspaceDirectory {
  name: string;
  path: string;
}

export interface GitChange {
  status: string;
  path: string;
}

export interface GitCommit {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  timestamp: string;
}

export interface GitDiff {
  original: string | null;
  modified: string | null;
  truncated?: boolean;
}

export interface WorkspaceFile {
  name: string;
  path: string;
}

export interface WorkspaceTree {
  path: string;
  dirs: WorkspaceDirectory[];
  /** Regular files directly inside `path` (first page only, bounded). */
  files: WorkspaceFile[];
  nextPageId: string | null;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
}

export interface MrInfo {
  iid: number;
  projectPath: string;
  title: string;
  state: string;
  /** GitLab merge_status, e.g. "can_be_merged" / "cannot_be_merged". */
  mergeStatus: string;
  webUrl: string;
  /** Raw markdown MR description ("" when the MR has none). */
  description: string;
  /** Latest pipeline for the MR, or null when none has run yet. */
  pipeline: { status: string; webUrl: string } | null;
}

export interface MrComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
}

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

/** Latest MR pipeline broken down per stage/job; null when none has run. */
export interface MrPipelineProgress {
  pipeline: { id: number; status: string; webUrl: string };
  stages: MrPipelineStage[];
}

export interface PreviewRepoHint {
  match: string;
  label: string;
  port: number;
  runCommand: string;
}

export interface PreviewConfig {
  /** True when the BFF can reach a preview origin (proxy is wired up). */
  enabled: boolean;
  defaultPort: number;
  portRange: { min: number; max: number };
  repos: PreviewRepoHint[];
}

/**
 * Proxy mount (no trailing slash) for a conversation — the value the previewed
 * app must be served under (the proxy is path-preserving). Fills the
 * `{previewBase}` placeholder in run-command hints. Without a port this is the
 * stable, port-independent `/preview/app` path (the default since Phase 2);
 * pass an explicit port only for the advanced manual-port fallback.
 */
export function previewBase(id: string, port?: number | null): string {
  return `/api/openhands/conversations/${id}/preview/${port ?? "app"}`;
}

/**
 * Same-origin URL of the live-preview reverse proxy for a conversation.
 * The iframe/new-tab target; `path` is appended under the proxy mount.
 * Port-less form targets the stable /preview/app route.
 */
export function previewUrl(id: string, port?: number | null, path = "/"): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${previewBase(id, port)}${suffix}`;
}

export type PreviewStatusKind = "running" | "starting" | "exited" | "stopped" | "workspace-missing";

export interface PreviewStatus {
  status: PreviewStatusKind;
  /** Registered port when one exists, else the conversation's derived default. */
  port: number;
  /** Stable path-based proxy mount (`…/preview/app`). */
  previewBase: string;
  /** True when a conversation → port registration exists (start / PUT target). */
  registered: boolean;
}

export interface PreviewStartResult {
  status: string;
  port: number;
  previewBase: string;
  repo: string;
  /** The exact allowlisted command the BFF launched (for display/debugging). */
  command: string;
}

export interface PreviewLogs {
  log: string;
  logFile: string;
}

export interface DiskUsage {
  /** Shared workspace root the numbers describe (the shared workspace volume mount). */
  workspaceRoot: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** 0–100, df's own Capacity figure. */
  usedPercent: number;
  checkedAt: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: unknown };
      message = body.error ?? (typeof body.detail === "string" ? body.detail : message);
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// The bot-clonable repo set changes rarely, but the hub re-fetches it (behind
// a status round-trip that may reach GitLab) on every page load, so the pinned
// quick picks flash a "Loading repositories…" state before appearing. Persist
// the last good list in localStorage and seed the picker from it, so the pins
// render immediately while a fresh copy is fetched in the background.
const REPOS_CACHE_KEY = "openhands.repos.v1";
const REPOS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Parse a persisted repo-cache payload, returning the items if still fresh. */
export function parseReposCache(raw: string | null, now = Date.now()): RepoOption[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: number; items?: unknown };
    if (typeof parsed.at !== "number" || !Array.isArray(parsed.items)) return null;
    if (now - parsed.at > REPOS_CACHE_TTL_MS) return null;
    return parsed.items as RepoOption[];
  } catch {
    return null;
  }
}

/** Last known repo list from localStorage, or null when absent/stale/unavailable. */
export function cachedRepos(): RepoOption[] | null {
  if (typeof localStorage === "undefined") return null;
  return parseReposCache(localStorage.getItem(REPOS_CACHE_KEY));
}

function storeRepos(items: RepoOption[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(REPOS_CACHE_KEY, JSON.stringify({ at: Date.now(), items }));
  } catch {
    /* private-mode / quota — the network fetch still works, just no cache */
  }
}

export const openHandsApi = {
  status: () => fetch("/api/openhands/status").then((r) => json<OpenHandsStatus>(r)),

  list: () =>
    fetch("/api/openhands/conversations").then((r) => json<{ items: ConversationSummary[] }>(r)),

  repos: () =>
    fetch("/api/openhands/repos")
      .then((r) => json<{ items: RepoOption[] }>(r))
      .then((r) => {
        storeRepos(r.items);
        return r;
      }),

  workspaceRepos: (conversation?: string) => {
    const qs = conversation ? `?conversation=${encodeURIComponent(conversation)}` : "";
    return fetch(`/api/openhands/git/repos${qs}`).then((r) => json<{ items: WorkspaceRepo[] }>(r));
  },

  changes: (repo: string, ref?: string) => {
    const query = new URLSearchParams({ repo });
    if (ref) query.set("ref", ref);
    return fetch(`/api/openhands/git/changes?${query}`).then((r) => json<GitChange[]>(r));
  },

  commits: (repo: string) =>
    fetch(`/api/openhands/git/commits?${new URLSearchParams({ repo })}`).then((r) =>
      json<{ commits: GitCommit[]; has_more: boolean }>(r),
    ),

  commitChanges: (repo: string, sha: string) =>
    fetch(`/api/openhands/git/commits/${sha}/changes?${new URLSearchParams({ repo })}`).then((r) =>
      json<GitChange[]>(r),
    ),

  diff: (path: string, options: { ref?: string; commit?: string } = {}) => {
    const query = new URLSearchParams({ path });
    if (options.ref) query.set("ref", options.ref);
    if (options.commit) query.set("commit", options.commit);
    return fetch(`/api/openhands/git/diff?${query}`).then((r) => json<GitDiff>(r));
  },

  suggestedIssues: (repo: string) =>
    fetch(`/api/openhands/suggested-issues?repo=${encodeURIComponent(repo)}`).then((r) =>
      json<SuggestedIssuesResponse>(r),
    ),

  tools: (refresh = false) =>
    fetch(`/api/openhands/tools${refresh ? "?refresh=1" : ""}`).then((r) => json<ToolsHealth>(r)),

  localFolders: () =>
    fetch("/api/openhands/local-folders").then((r) => json<{ items: Array<{ name: string; path: string }> }>(r)),

  create: (input: {
    prompt: string;
    repoUrl?: string;
    localPath?: string;
    useWorktree?: boolean;
    model?: string;
    images?: ChatImage[];
    mode?: "build" | "plan";
  }) =>
    fetch("/api/openhands/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ id: string; started: boolean }>(r)),

  notifications: () =>
    fetch("/api/openhands/notifications").then((r) => json<NotificationSettings>(r)),

  testNotification: () =>
    fetch("/api/openhands/notifications/test", { method: "POST" }).then((r) =>
      json<{ ok: boolean; url: string; topic: string }>(r),
    ),

  updateNotifications: (
    input: Pick<NotificationSettings, "enabled" | "notifyIdle" | "mentionMe"> &
      Partial<Pick<NotificationSettings, "ntfyUrl" | "ntfyTopic">>,
  ) =>
    fetch("/api/openhands/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<NotificationSettings>(r)),

  agentSettings: () =>
    fetch("/api/openhands/agent-settings").then((r) => json<AgentSettings>(r)),

  updateAgentSettings: (input: { condenser: Partial<CondenserSettings> }) =>
    fetch("/api/openhands/agent-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<AgentSettings>(r)),

  skills: () => fetch("/api/openhands/skills").then((r) => json<SkillsSettings>(r)),

  // Global (default-profile) skill toggles — decision #17. Both keys optional;
  // `skills` maps a skill name to its wanted EFFECTIVE state.
  updateSkills: (input: { skills?: Record<string, boolean>; sources?: Partial<SkillSources> }) =>
    fetch("/api/openhands/skills", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<SkillsSettings>(r)),

  get: (id: string) =>
    fetch(`/api/openhands/conversations/${id}`).then((r) => json<ConversationSummary>(r)),

  // Newest-first (order=desc): next_page_id walks toward OLDER events, which
  // is what the bottom-anchored transcript pages on.
  events: (id: string, limit = 300, pageId?: string, newestFirst = false) =>
    fetch(
      `/api/openhands/conversations/${id}/events?limit=${limit}${newestFirst ? "&order=desc" : ""}${pageId ? `&page_id=${encodeURIComponent(pageId)}` : ""}`,
    ).then((r) => json<{ items: RawOpenHandsEvent[]; next_page_id: string | null }>(r)),

  // Upstream returns the FinishAction summary as a bare JSON string (null when
  // the agent never finished) — bounded regardless of transcript length.
  finalResponse: (id: string) =>
    fetch(`/api/openhands/conversations/${id}/agent_final_response`).then((r) =>
      json<string | null>(r),
    ),

  send: (id: string, text: string, model?: string, images?: ChatImage[]) =>
    fetch(`/api/openhands/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(model ? { model } : {}),
        ...(images?.length ? { images } : {}),
      }),
    }).then((r) => json<unknown>(r)),

  action: (id: string, action: "run" | "pause") =>
    fetch(`/api/openhands/conversations/${id}/${action}`, { method: "POST" }).then((r) =>
      json<unknown>(r),
    ),

  // Plan ⇄ Build switch; `notify` (build only) also delivers the canned
  // "plan approved — implement" message and restarts the run.
  setMode: (id: string, mode: "build" | "plan", notify = false) =>
    fetch(`/api/openhands/conversations/${id}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, notify }),
    }).then((r) => json<{ mode: "build" | "plan"; notified: boolean }>(r)),

  respondToConfirmation: (id: string, accept: boolean) =>
    fetch(`/api/openhands/conversations/${id}/respond_to_confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept }),
    }).then((r) => json<unknown>(r)),

  remove: (id: string) =>
    fetch(`/api/openhands/conversations/${id}`, { method: "DELETE" }).then((r) => json<unknown>(r)),

  terminalCommands: (pageId?: string) =>
    fetch(`/api/openhands/terminal/commands?limit=50${pageId ? `&page_id=${encodeURIComponent(pageId)}` : ""}`).then((r) =>
      json<{ items: TerminalCommand[]; next_page_id: string | null }>(r),
    ),

  terminalOutput: (commandId: string, orderGt?: number) =>
    fetch(`/api/openhands/terminal/commands/${encodeURIComponent(commandId)}/output?limit=100${orderGt === undefined ? "" : `&order_gt=${orderGt}`}`).then((r) =>
      json<{ items: TerminalOutput[]; next_page_id: string | null; truncated: boolean }>(r),
    ),

  tree: (path?: string, pageId?: string, conversation?: string) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (pageId) params.set("page_id", pageId);
    if (conversation) params.set("conversation", conversation);
    const qs = params.toString();
    return fetch(`/api/openhands/files/tree${qs ? `?${qs}` : ""}`).then((r) => json<WorkspaceTree>(r));
  },

  fileContent: (path: string, conversation?: string) => {
    const params = new URLSearchParams({ path });
    if (conversation) params.set("conversation", conversation);
    return fetch(`/api/openhands/files/content?${params}`).then((r) => json<WorkspaceFileContent>(r));
  },

  diskUsage: () => fetch("/api/openhands/disk").then((r) => json<DiskUsage>(r)),

  previewConfig: () =>
    fetch("/api/openhands/preview/config").then((r) => json<PreviewConfig>(r)),

  previewStatus: (id: string) =>
    fetch(`/api/openhands/conversations/${id}/preview/status`).then((r) => json<PreviewStatus>(r)),

  previewStart: (id: string, repoMatch?: string) =>
    fetch(`/api/openhands/conversations/${id}/preview/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repoMatch ? { repoMatch } : {}),
    }).then((r) => json<PreviewStartResult>(r)),

  previewStop: (id: string) =>
    fetch(`/api/openhands/conversations/${id}/preview/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) => json<{ stopped: boolean }>(r)),

  previewLogs: (id: string) =>
    fetch(`/api/openhands/conversations/${id}/preview/logs`).then((r) => json<PreviewLogs>(r)),

  previewSetTarget: (id: string, port: number) =>
    fetch(`/api/openhands/conversations/${id}/preview/target`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    }).then((r) => json<{ port: number; previewBase: string }>(r)),

  getMr: (url: string) =>
    fetch(`/api/openhands/mr?url=${encodeURIComponent(url)}`).then((r) => json<MrInfo>(r)),

  getMrComments: (url: string) =>
    fetch(`/api/openhands/mr/comments?url=${encodeURIComponent(url)}`).then((r) =>
      json<{ items: MrComment[] }>(r),
    ),

  getMrPipeline: (url: string) =>
    fetch(`/api/openhands/mr/pipeline?url=${encodeURIComponent(url)}`).then((r) =>
      json<MrPipelineProgress | null>(r),
    ),

  mergeMr: (url: string) =>
    fetch("/api/openhands/mr/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => json<MrInfo>(r)),
};

/** Terminal states — polling slows down once one is reached. */
export const TERMINAL_STATUSES = new Set(["finished", "error", "stuck"]);

export function statusTone(status: string): "ok" | "busy" | "warn" | "error" {
  if (status === "finished") return "ok";
  if (status === "running") return "busy";
  if (status === "error" || status === "stuck") return "error";
  return "warn"; // idle / paused / waiting_for_confirmation
}
