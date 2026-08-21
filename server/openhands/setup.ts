// server/openhands/setup.ts
//
// BFF for an OpenHands (Agent Canvas) instance — a shared remote
// deployment, or the local compose service (`OPENHANDS_LOCAL=1` in .env)
// which is fully standalone: laptop-only agent loop, your ANTHROPIC_API_KEY,
// no remote connection. The browser only ever talks to these
// authenticated app routes; the agent-server API key (OPENHANDS_API_KEY, or
// OPENHANDS_API_KEY_FILE on the shared compose volume) stays server-side.
//
// Fail-closed: every route except /status requires the caller's oauth2-proxy
// email to be on OPENHANDS_ALLOWED_EMAILS — the deployed instance is
// single-tenant (one pod, one GitLab identity), so the allowlist is the
// tenancy boundary, mirroring the Canvas host's own oauth2-proxy allowlist.
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Request, Response, Router as RouterT } from "express";
import type { ServerAppDeps, ServerAppResult } from "../app-types.js";
import { logger } from "../logger.js";
import {
  fetchMrDiscussions,
  findIssues,
  getMergeRequest,
  listMergeRequestPipelines,
  listPipelineJobs,
  mergeMergeRequest,
  parseMergeRequestUrl,
  type IssueSummary,
  type MergeRequestResult,
} from "../gitlab.js";
import {
  ghGetPullChecksProgress,
  ghGetPullRequestInfo,
  ghListPullComments,
  ghMergePullRequest,
  parsePullRequestUrl,
} from "../github.js";
import { aggregatePipelineStages, flattenMrComments } from "./mr.js";
import { toImageDataUrl, validateChatImages, type ChatImage } from "./images.js";
import { sanitizeBashOutputs, stripAnsi, type BashOutputEvent } from "./terminal.js";
import { createNtfyNotifier, effectiveNtfyConfig, postNtfy, type Notifier } from "./notifier.js";
import { createApiKeyResolver, createUpstream } from "./upstream.js";
import { inferConversationRepo } from "./repo-infer.js";
import { createAutoResumer, type AutoResumer } from "./autoResume.js";
import {
  condenserResponse,
  conversationAgentSettings,
  validateCondenserPatch,
  type UpstreamAgentSettings,
} from "./agentSettings.js";
import {
  loadedSkillsRequest,
  skillsResponse,
  validateSkillsPatch,
  type SkillsPayload,
  type UpstreamAgentContext,
  type UpstreamInstalledSkills,
  type UpstreamLoadedSkills,
} from "./skills.js";
import { mapWsFrame, sseSerialize, wsAuthFrame, wsEventsUrl } from "./stream.js";
import {
  PLAN_APPROVED_MESSAGE,
  confirmationPolicyForMode,
  parseConversationMode,
  securityAnalyzerForMode,
  taskForMode,
} from "./planMode.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Enumerating public skills git-pulls the OpenHands/extensions repo upstream,
// which is far slower than a normal API call on a cold cache — but it is a
// page-load read, so it gets a bounded wait and degrades instead of hanging.
const SKILLS_LOAD_TIMEOUT_MS = 20_000;
// Durable per-conversation workspace layout. Each conversation gets its own
// directory under the shared workspace PVC so agents no longer collide in a
// single working tree. The BFF mints the conversation UUID up front, hands it
// to Agent Canvas as `conversation_id`, and derives the working dir from it.
const WORKSPACE_ROOT = "/home/openhands/workspace";
const SESSIONS_ROOT = `${WORKSPACE_ROOT}/sessions`;
// Host projects bind mount (compose: OPENHANDS_PROJECTS_DIR → this path).
// Conversations may target an existing directory under it instead of a fresh
// per-conversation sessions/<uuid> dir — the local-folder workflow.
const LOCAL_ROOT = `${WORKSPACE_ROOT}/local`;

/**
 * Build the durable working directory for a conversation and prove it stays
 * under the workspace root. `id` must already be a canonical UUID; this
 * function is intentionally strict (throws) so a malformed id can never widen
 * the agent's filesystem scope beyond `${SESSIONS_ROOT}/<uuid>`.
 */
export function sessionWorkingDir(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new Error("invalid conversation id for workspace path");
  }
  const dir = path.posix.normalize(path.posix.join(SESSIONS_ROOT, id));
  const rel = path.posix.relative(SESSIONS_ROOT, dir);
  if (dir !== `${SESSIONS_ROOT}/${id}` || rel !== id || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
    throw new Error("workspace path escapes the sessions root");
  }
  return dir;
}

/**
 * Resolve a user-supplied relative path to a working directory under the
 * local-projects bind mount, or null when it is unusable. Intentionally
 * strict — this value widens the agent's working tree onto a host mount, so
 * every segment is validated and the normalized result must stay under
 * LOCAL_ROOT. Dotfile/dot-dir segments are rejected (no `.git`, no `..`, no
 * hidden dirs) to match the file endpoints' dotfile blocking.
 */
export function localWorkingDir(relPath: string): string | null {
  if (typeof relPath !== "string") return null;
  const trimmed = relPath.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed.length > 512) return null;
  if (trimmed.includes("\\") || trimmed.includes("\0")) return null;
  const segments = trimmed.split("/");
  if (segments.length > 8) return null;
  for (const seg of segments) {
    if (!seg || seg.startsWith(".") || seg.length > 128) return null;
    if (!/^[\w][\w .-]*$/.test(seg) || seg.endsWith(" ")) return null;
  }
  const dir = path.posix.normalize(path.posix.join(LOCAL_ROOT, ...segments));
  const rel = path.posix.relative(LOCAL_ROOT, dir);
  if (dir !== `${LOCAL_ROOT}/${segments.join("/")}` || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
    return null;
  }
  return dir;
}

/**
 * User-message content for agent-canvas. SendMessageRequest (and
 * initial_message) take `content: (TextContent | ImageContent)[]`; each
 * validated attachment becomes one ImageContent block carrying a data URL.
 */
export function messageContent(text: string, images: ChatImage[]): Array<Record<string, unknown>> {
  return [
    { type: "text", text },
    ...images.map((img) => ({ type: "image", image_urls: [toImageDataUrl(img)] })),
  ];
}

/**
 * Validate a conversation's reported `workspace.working_dir` before trusting it
 * as a filesystem scope root. The upstream value is NEVER trusted blindly: it
 * must be a bounded, already-normalized POSIX path with no traversal or
 * backslash/NUL trickery, and it must resolve inside the shared workspace root.
 * Returns the normalized path, or null when the value is unusable — callers
 * fail closed (400) on null rather than widening the agent's filesystem scope.
 */
export function validateWorkingDir(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null;
  if (value.includes("..") || value.includes("\\") || value.includes("\0")) return null;
  // A trailing slash is non-canonical for a directory path and would break
  // exact scope-root comparisons; reject it up front (normalize keeps it).
  if (value.endsWith("/")) return null;
  const normalized = path.posix.normalize(value);
  // Reject anything that was not already canonical (e.g. "." segments) so the
  // cached scope root matches exactly what we compare against.
  if (normalized !== value) return null;
  if (normalized !== WORKSPACE_ROOT && !normalized.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  return normalized;
}
/**
 * True when an upstream fetch failed because its AbortSignal.timeout fired
 * (Node rejects with a DOMException named "TimeoutError"; "AbortError" is the
 * pre-timeout() spelling some runtimes still use). Used to distinguish a
 * wedged-but-alive agent-server (504) from an unreachable one (502).
 */
export function isUpstreamTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
// Agent Canvas stores bash-event UUIDs without hyphens even though the API
// describes them as UUIDs. Accept both canonical representations.
const BASH_COMMAND_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// Repos the create form may point the agent at. Deliberately narrow by
// default (the two GitLab hosts a typical token reaches); override with
// OPENHANDS_REPO_URL_PATTERN for other hosts. Must stay https-anchored.
const REPO_RE = (() => {
  const pattern = process.env.OPENHANDS_REPO_URL_PATTERN;
  if (pattern) {
    try {
      return new RegExp(pattern);
    } catch {
      // Fall through to the default on an invalid pattern — visible via the
      // create-form 400 rather than a boot crash.
    }
  }
  return /^https:\/\/(gitlab\.com|github\.com)\/[\w./-]+$/;
})();
const MAX_PROMPT_CHARS = 20_000;
// Appended to every initial task message. GitLab serves issue/MR attachments
// from web-session-only `/uploads/` routes: PRIVATE-TOKEN is ignored there, so
// a curl gets a sign-in redirect and (behind Cloudflare) a bot-challenge HTML
// page. Saving that as `.png` and viewing it attaches invalid image bytes to
// the LLM request, which fails with an unrecoverable LLMBadRequestError that
// is replayed on every resume — the conversation is permanently poisoned
// (issue #258). The guardrail keeps the agent from walking into that trap.
const ATTACHMENT_GUARDRAIL = [
  "Environment constraints (always apply):",
  "- GitLab attachment URLs containing `/uploads/` (screenshots or files embedded in issue/MR descriptions, e.g. `https://gitlab.com/-/project/<id>/uploads/<secret>/<file>`) CANNOT be downloaded here: those web routes ignore `PRIVATE-TOKEN` and return a sign-in redirect or a Cloudflare challenge page instead of the file. Do not fetch or view them — work from the issue/MR text alone.",
  "- Never open a downloaded file with the image viewer without first confirming it is a real image (`file <path>` must report image data, not HTML/ASCII text). Attaching a non-image as an image permanently breaks this conversation.",
  "- If a screenshot or attachment is essential to the task, ask the user to paste or attach it directly in the chat instead (image upload is supported).",
].join("\n");

/**
 * Appended to every initial task message so any merge request the agent opens
 * carries a prominent link back to the conversation that produced it. The
 * conversation id is minted server-side before the message is built, so the
 * exact session URL is known up front. Kept as an exact quoted line so the
 * result is greppable/idempotent (`/openhands/native/conversations/<id>`).
 */
export function mrSessionLinkGuardrail(sessionUrl: string): string {
  return [
    "MR traceability (always apply):",
    "- Every merge request you create in this conversation MUST begin its description with exactly this line, followed by a blank line, before any other content:",
    `  > 🤖 **Created by an OpenHands session** — [view the conversation that produced this MR](${sessionUrl})`,
    "- Keep this line first and intact whenever you later edit or rewrite the MR description; never duplicate it.",
  ].join("\n");
}
const UPSTREAM_TIMEOUT_MS = 30_000;
const WORKTREE_SETUP_TIMEOUT_SECONDS = 60;
// The agent-server rejects events/search pages larger than 100 (an
// AssertionError → 500), so bigger transcript reads must paginate.
const EVENTS_PAGE_SIZE = 100;
const EVENTS_MAX_LIMIT = 500;
// Transcript reads are 3s UI polls, so they must fail fast and never stack.
// A wedged agent-server request otherwise holds a uvicorn worker for the full
// 30s default timeout while the client keeps piling on new polls; with enough
// stacked walks the agent-server's worker pool exhausts and EVERY OpenHands
// endpoint (including list conversations on the Hub) becomes unreachable
// (incident on a shared deployment, 2026-08-19). Three layers of protection:
//   - a short per-page timeout so a wedged read releases its worker quickly,
//   - single-flight coalescing so identical concurrent polls share one walk,
//   - a per-conversation cool-off after a timeout so the upstream gets air.
const EVENTS_READ_TIMEOUT_MS = 10_000;
const EVENTS_TIMEOUT_COOLOFF_MS = 20_000;
// Log transcript walks slower than this — cheap slow-step attribution
// (agent-server contention vs LLM latency; issue #48).
const EVENTS_SLOW_WALK_LOG_MS = 2_000;
// Reap SSE bridges whose upstream websocket has been silent this long — the
// client only streams during active runs, so a frameless stream is wedged.
const STREAM_IDLE_MAX_MS = 5 * 60_000;
const EVENTS_COOLOFF_MAX_ENTRIES = 512;
const TERMINAL_DEFAULT_LIMIT = 50;
const TERMINAL_MAX_LIMIT = 100;
const REPOS_CACHE_MS = 5 * 60_000;
const REPOS_FAILURE_CACHE_MS = 30_000;
const REPOS_MAX_PROJECTS = 500;
// Conversation → working-dir scope resolution. The scope is resolved from the
// conversation's ACTUAL working_dir (never synthesised from the id) because
// shared deployments have MIXED layouts: newer conversations live under sessions/<uuid>
// while legacy ones still point at the flat workspace root. A short bounded
// TTL cache keeps 3s UI polling from adding an upstream call per scoped
// request; the map is capped so a flood of distinct ids cannot grow it without
// bound (oldest entry is evicted first).
const CONV_ROOT_CACHE_MS = 60_000;
const CONV_ROOT_CACHE_MAX = 256;
// /git/repos fan-out caps. The route probes each candidate directory with one
// upstream git/changes call, so scanning sessions/* multiplies that cost. Cap
// both the number of session directories we descend into and the total number
// of candidate directories we ever probe.
const REPOS_MAX_SESSION_DIRS = 25;
const REPOS_MAX_CANDIDATES = 100;
// Workspace disk usage probe. The command is FIXED — no user input ever
// reaches it — so the /disk route is a single-purpose read-only probe, not
// the generic arbitrary-command endpoint the interactive-terminal design doc
// forbids. The result is cached (and concurrent requests deduped) so any
// number of polling browsers cause at most ~2 probes a minute, which also
// bounds the `df` noise this adds to the shared bash-event history.
const DISK_USAGE_COMMAND = `df -kP ${WORKSPACE_ROOT}`;
const DISK_USAGE_TIMEOUT_SECONDS = 15;
const DISK_USAGE_CACHE_MS = 30_000;

export interface DiskUsage {
  workspaceRoot: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** df's own Capacity figure (accounts for reserved blocks), 0–100. */
  usedPercent: number;
  checkedAt: string;
}

/**
 * Parse POSIX-portable `df -kP <path>` output (header line + one data line:
 * filesystem, 1024-blocks, used, available, capacity%, mount point). Returns
 * null when the output does not look like that — callers fail closed (502)
 * rather than render a made-up number.
 */
export function parseDfOutput(stdout: string): Omit<DiskUsage, "workspaceRoot" | "checkedAt"> | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // The data line is the last one; a long device name may wrap onto its own
  // line, in which case the numbers still lead the final line.
  const data = lines.length >= 2 ? lines[lines.length - 1] : "";
  const match = /(?:^|\s)(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s/.exec(data);
  if (!match) return null;
  const [totalKb, usedKb, availableKb, percent] = match.slice(1).map(Number);
  if (totalKb <= 0 || percent > 100) return null;
  return {
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    availableBytes: availableKb * 1024,
    usedPercent: percent,
  };
}
const COMMIT_SHA_RE = /^[0-9a-fA-F]{4,64}$/;
const GIT_REF_RE = /^(?:HEAD|[0-9a-fA-F]{4,64}|[A-Za-z0-9][A-Za-z0-9._/-]{0,255})$/;
const GIT_COMMITS_LIMIT = 20;
const MAX_DIFF_BYTES = 512 * 1024;
const FILE_CONTENT_MAX_BYTES = 256 * 1024;
// Suggested-issues discovery. Bounded result set; a GitLab project path like
// "group/subgroup/name" (letters, digits, dots, dashes, underscores, slashes).
const SUGGESTED_ISSUES_MAX = 20;
const ISSUE_REPO_PATH_RE = /^[\w.][\w.\-/]{0,199}$/;

/**
 * Is the bot an actual MEMBER of `repo`? Three-way outcome so callers can
 * keep the membership security boundary (public/internal projects resolve an
 * id without membership) and can tell transient GitLab failures (-> 502)
 * apart from a genuine not-found/not-member (-> 404).
 */
export async function probeBotMembership(
  auth: { baseUrl: string; token: string },
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"member" | "not-member" | "not-found" | "error"> {
  try {
    const res = await fetchImpl(
      `${auth.baseUrl}/api/v4/projects/${encodeURIComponent(repo)}`,
      {
        headers: { "PRIVATE-TOKEN": auth.token },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status === 404) return "not-found";
    if (!res.ok) return "error";
    const body = (await res.json()) as {
      permissions?: {
        project_access?: { access_level?: number } | null;
        group_access?: { access_level?: number } | null;
      };
    };
    const member = Boolean(
      body.permissions?.project_access || body.permissions?.group_access,
    );
    return member ? "member" : "not-member";
  } catch {
    return "error";
  }
}
// Labels that mean "not ready to pick up" — excluded from suggestions.
const SUGGESTED_ISSUES_EXCLUDED_LABELS = ["blocked", "on hold", "wontfix", "duplicate", "needs design"];
// Freshness window (days) used only to phrase why an issue is suggested.
const SUGGESTED_ISSUES_FRESH_DAYS = 30;

/** Human-readable explanation of why an open, unassigned issue is suggested. */
function suggestionReason(issue: IssueSummary): string {
  const parts = ["Open and unassigned"];
  const updated = Date.parse(issue.updated_at);
  if (Number.isFinite(updated) && Date.now() - updated <= SUGGESTED_ISSUES_FRESH_DAYS * 86_400_000) {
    parts.push("recently active");
  }
  if (issue.upvotes > 0) parts.push(`${issue.upvotes} upvote${issue.upvotes === 1 ? "" : "s"}`);
  if (issue.user_notes_count > 0) parts.push(`${issue.user_notes_count} comment${issue.user_notes_count === 1 ? "" : "s"} of context`);
  return parts.join(" · ");
}
// ── Live frontend preview ────────────────────────────────────────────────
// Reverse-proxy an HTTP port the agent started inside the pod (e.g. `vite`)
// out to the browser. The proxy target HOST is fixed (config), only the port
// and trailing path vary, so this cannot be pointed at an arbitrary internal
// address. Ports are constrained to unprivileged user ports; the agent-server
// port is refused so the preview can never relay the agent API.
const PREVIEW_PORT_MIN = 1024;
const PREVIEW_PORT_MAX = 65_535;
const PREVIEW_AGENT_SERVER_PORT = 8000;
const PREVIEW_TIMEOUT_MS = 20_000;
// Cap a single proxied response so a runaway app cannot stream unbounded bytes
// through the hub. Generous enough for a built SPA bundle chunk.
const PREVIEW_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
// Only these request headers are forwarded upstream — never the hub session
// cookie or the agent-server key. Response side, we pass Content-Type through
// (so the browser renders HTML/JS/CSS correctly) plus a few safe caching hints.
const PREVIEW_FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "range"];
const PREVIEW_FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"];
// Advisory repo → run-command/port map surfaced by GET /preview/config. The BFF
// never execs these; the agent (or user) runs the command in the session. v1
// seeds the repo this hub itself lives in. `{previewBase}` in a runCommand is a
// template the CLIENT fills with the conversation- and port-specific proxy
// mount — the previewed app must be served under that base path (the proxy is
// path-preserving, see the preview route below).
interface PreviewRepo {
  /** Substring matched against a conversation's cloned repo path/url. */
  match: string;
  label: string;
  port: number;
  runCommand: string;
}
const PREVIEW_REPOS: PreviewRepo[] = [
  {
    match: "customizable-dca-openhands",
    label: "Customizable DCA (vite dev server)",
    port: 5173,
    // host 0.0.0.0 is the repo's dev-server default; VITE_ALLOWED_HOSTS lets
    // the proxy's Host header through (vite.config.ts). `--strictPort` on the
    // derived {previewPort} fails fast instead of silently drifting to a port
    // another session already grabbed.
    runCommand: "npm install && VITE_BASE_PATH={previewBase} VITE_ALLOWED_HOSTS=all npm run dev:ui -- --port {previewPort} --strictPort",
  },
];
const PREVIEW_DEFAULT_PORT = PREVIEW_REPOS[0]?.port ?? 5173;
// Derived per-conversation port range: one shared pod = one port space, so
// every conversation hashes to its own default port and dev servers stop
// colliding on 5173. Kept clear of the agent-server port (8000).
const PREVIEW_DERIVED_PORT_BASE = 20_000;
const PREVIEW_DERIVED_PORT_SPAN = 10_000;
// Control commands (start/stop/probes) run through the upstream bash API with
// a short bounded timeout — the dev server itself is detached via setsid, so
// nothing here waits on npm install.
const PREVIEW_CONTROL_TIMEOUT_SECONDS = 20;
// Short HEAD-probe timeout for /preview/status — a live dev server answers
// fast; a longer wait would only delay the "stopped" verdict the panel polls.
const PREVIEW_PROBE_TIMEOUT_MS = 3_000;
// Bound the pod-state probe rate: the panel polls status every ~5s, so a tiny
// TTL cache dedupes multi-tab pollers without hiding fresh transitions.
const PREVIEW_STATE_CACHE_MS = 4_000;
const PREVIEW_PORTS_MAX = 256;
const PREVIEW_LOG_TAIL_LINES = 200;

/**
 * Derive the stable default preview port for a conversation:
 * 20000 + (FNV-1a hash of the lowercased id) % 10000. Same id → same port
 * across BFF restarts and browsers; different sessions land on different
 * ports so their dev servers no longer fight over 5173. Throws on a non-UUID
 * so a malformed id can never produce a port.
 */
export function derivePreviewPort(id: string): number {
  if (!UUID_RE.test(id)) throw new Error("invalid conversation id for preview port");
  const key = id.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PREVIEW_DERIVED_PORT_BASE + (hash % PREVIEW_DERIVED_PORT_SPAN);
}

/**
 * Fixed pod-side runtime file paths for a conversation's preview process.
 * The id is re-validated (throws) so a crafted id can never place these files
 * outside /tmp or smuggle shell metacharacters into the control commands.
 * The portfile doubles as the persisted conversation→port registration: it
 * lives in the workspace pod, so it survives BFF restarts and dies with the
 * pod — exactly the lifetime of the dev server it describes.
 */
export function previewRuntimePaths(id: string): { pidFile: string; logFile: string; portFile: string } {
  if (!UUID_RE.test(id)) throw new Error("invalid conversation id for preview runtime paths");
  const key = id.toLowerCase();
  return {
    pidFile: `/tmp/preview-${key}.pid`,
    logFile: `/tmp/preview-${key}.log`,
    portFile: `/tmp/preview-${key}.port`,
  };
}

/**
 * Single-quote a string for POSIX sh. Defense in depth: every interpolated
 * value is already server-derived (validated UUID paths, allowlisted repo
 * config), but quoting keeps that invariant local instead of global.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function createWorktreeCommand(sourceDir: string, targetDir: string): string {
  return `mkdir -p ${shellQuote(path.posix.dirname(targetDir))} && git -C ${shellQuote(sourceDir)} worktree add --detach ${shellQuote(targetDir)} HEAD`;
}

export function removeWorktreeCommand(sourceDir: string, targetDir: string): string {
  return `git -C ${shellQuote(sourceDir)} worktree remove --force ${shellQuote(targetDir)}`;
}

/** Port-independent proxy mount for a conversation (the Phase 2 stable URL). */
export function previewAppBase(id: string): string {
  return `/api/openhands/conversations/${id}/preview/app`;
}

/**
 * Fill the `{previewBase}`/`{previewPort}` placeholders of an allowlisted
 * PREVIEW_REPOS run command. Only ever called with server-side templates —
 * browser input never reaches the command text.
 */
export function fillRunCommand(template: string, base: string, port: number): string {
  return template.replaceAll("{previewBase}", base).replaceAll("{previewPort}", String(port));
}

/**
 * Resolve the PREVIEW_REPOS entry to start. `repoMatch` (optional, from the
 * browser) only SELECTS an allowlisted entry — by exact `match` or substring
 * containment — it is never executed or interpolated. Defaults to the first
 * entry; returns null when nothing matches (callers 400).
 */
export function resolvePreviewRepo(repoMatch?: unknown): PreviewRepo | null {
  if (repoMatch === undefined || repoMatch === null || repoMatch === "") return PREVIEW_REPOS[0] ?? null;
  if (typeof repoMatch !== "string" || repoMatch.length > 512) return null;
  return PREVIEW_REPOS.find((repo) => repo.match === repoMatch || repoMatch.includes(repo.match)) ?? null;
}

export type PreviewStatusKind = "running" | "starting" | "exited" | "stopped" | "workspace-missing";

/**
 * Classify a preview's lifecycle state from independent observations.
 * Reachability wins (whatever answers the probe IS the preview); otherwise a
 * pruned workspace explains the silence (workspace janitor, 2h TTL), a live
 * pidfile with a live process group means the server is still coming up, a
 * pidfile whose process group is GONE means the start crashed (npm install
 * failure, --strictPort conflict, OOM-killed vite — the log tail has the
 * story), and nothing at all is stopped.
 */
export function classifyPreviewStatus(input: { reachable: boolean; pidFileExists: boolean; processAlive: boolean; workspaceExists: boolean }): PreviewStatusKind {
  if (input.reachable) return "running";
  if (!input.workspaceExists) return "workspace-missing";
  if (input.pidFileExists) return input.processAlive ? "starting" : "exited";
  return "stopped";
}

/**
 * Parse the fixed `pid=…` / `alive=…` / `port=…` / `ws=…` lines emitted by the
 * status probe script. Tolerates missing lines (fails toward "absent" — except
 * `alive=`, which fails toward "alive" so a truncated probe can never flip a
 * genuinely-starting server to "exited") and rejects an unparseable port so
 * garbage in the portfile can never reach the proxy.
 */
export function parsePreviewStateProbe(stdout: string): { pidFileExists: boolean; processAlive: boolean; workspaceExists: boolean; registeredPort: number | null } {
  const lines = stdout.split("\n").map((line) => line.trim());
  const value = (prefix: string): string | null => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line === undefined ? null : line.slice(prefix.length);
  };
  return {
    pidFileExists: value("pid=") === "1",
    processAlive: value("alive=") !== "0",
    workspaceExists: value("ws=") === "1",
    registeredPort: parsePreviewPort(value("port=") ?? ""),
  };
}

/**
 * Validate a browser-supplied preview port. Returns the numeric port, or null
 * when it is not an integer in the unprivileged range or is the agent-server's
 * own port (callers fail closed with 400 on null).
 */
export function parsePreviewPort(value: unknown): number | null {
  const port = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < PREVIEW_PORT_MIN || port > PREVIEW_PORT_MAX) return null;
  if (port === PREVIEW_AGENT_SERVER_PORT) return null;
  return port;
}

/**
 * Resolve the origin (scheme://host, no port) the preview proxy targets.
 * Prefers the explicit OPENHANDS_PREVIEW_ORIGIN; otherwise strips the port from
 * the agent-server internal URL. Returns null when neither yields a usable
 * http(s) host, so the proxy fails closed rather than fetch a bad URL.
 */
export function previewTargetOrigin(cfg: Pick<OpenHandsBffConfig, "previewOrigin" | "internalUrl">): string | null {
  const source = cfg.previewOrigin || cfg.internalUrl;
  if (!source) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // If the override already pins a port, honour it as the base and let the
    // caller append :<port> only when it did not. We normalise to scheme+host
    // and return the port separately via previewTargetUrl.
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
}

/**
 * Build the absolute upstream URL for a preview request. PATH-PRESERVING: the
 * full original hub path (mount included, query included) is forwarded to the
 * app port, so an app served under the preview base path (e.g. Vite with
 * VITE_BASE_PATH set to the mount) sees exactly the URLs it emitted — no HTML
 * rewriting. `originalPath` is only ever appended as a path (leading slashes
 * collapsed so `//host` cannot smuggle a new authority); scheme/host/port stay
 * fixed. Returns null when the origin is unresolvable.
 */
export function previewTargetUrl(
  cfg: Pick<OpenHandsBffConfig, "previewOrigin" | "internalUrl">,
  port: number,
  originalPath: string,
): string | null {
  const origin = previewTargetOrigin(cfg);
  if (!origin) return null;
  const cleanPath = originalPath.replace(/^\/+/, "");
  return `${origin}:${port}/${cleanPath}`;
}

export const DEFAULT_MODELS = [
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

/**
 * EU-data-residency OpenAI keys 401 against the global api.openai.com
 * ("Attempted to access resource from outside project geography EU"), so
 * `openai/` ids carry an explicit EU base_url. Override with
 * OPENHANDS_OPENAI_EU_BASE_URL or the pre-existing OPENAI_BASE_URL.
 */
export const OPENAI_EU_BASE_URL_DEFAULT = "https://eu.api.openai.com/v1";

/** True for model ids served by OpenAI (litellm `openai/` prefix). */
export function isOpenAiModel(model: string): boolean {
  return model.startsWith("openai/");
}

/**
 * LLM settings for the agent-server. The agent container is provisioned with
 * the Anthropic key only (LLM_API_KEY), so `openai/` ids must carry their own
 * api_key and EU base_url or litellm resolves no key at all and OpenAI replies
 * "Incorrect API key provided: None". Anthropic ids keep the agent's defaults.
 */
export function llmSettingsForModel(
  cfg: Pick<OpenHandsBffConfig, "openaiApiKey" | "openaiEuBaseUrl">,
  model: string,
): { model: string; base_url?: string; api_key?: string } {
  if (!isOpenAiModel(model)) return { model };
  const settings: { model: string; base_url: string; api_key?: string } = {
    model,
    base_url: cfg.openaiEuBaseUrl || OPENAI_EU_BASE_URL_DEFAULT,
  };
  if (cfg.openaiApiKey) settings.api_key = cfg.openaiApiKey;
  return settings;
}
export interface OpenHandsBffConfig {
  internalUrl: string;
  apiKey: string;
  /**
   * Path to a file holding the agent-server session API key. Local-dev
   * alternative to OPENHANDS_API_KEY: the agent-canvas container generates its
   * key at first boot (…/.openhands/agent-canvas/api-key.txt), so the compose
   * stack shares the state volume with the app and the BFF reads the key
   * lazily — no bootstrap script or restart ordering needed.
   */
  apiKeyFile?: string;
  publicUrl: string;
  allowedEmails: string[];
  model: string;
  models: string[];
  /**
   * GitLab token used to LIST repos for the create-form dropdown. Same bot
   * identity the deployed agent clones with (HIVE_GITLAB_SAAS_TOKEN), so the
   * dropdown only offers repos the agent can actually reach.
   */
  gitlabToken: string;
  gitlabBaseUrl: string;
  /**
   * Credentials for `openai/` model ids (see llmSettingsForModel). The agent
   * container only receives the Anthropic key, so the BFF forwards these per
   * conversation. Empty api_key leaves the agent to resolve one itself.
   */
  openaiApiKey: string;
  openaiEuBaseUrl: string;
  /**
   * GitHub token the MR sidebar uses to read/merge github.com pull requests
   * the agent linked. Same token the sandbox `gh` CLI gets
   * (OPENHANDS_GITHUB_TOKEN); empty disables the GitHub side of the sidebar.
   */
  githubToken: string;
  /**
   * Origin (scheme + host, optionally :port) the live-preview proxy targets —
   * i.e. where the app the agent starts inside the pod is reachable. When empty
   * it is derived from `internalUrl`'s host (the preview port replaces 8000).
   * Set OPENHANDS_PREVIEW_ORIGIN when the preview port is not reachable at the
   * agent-server host (e.g. a k8s deployment, where the ClusterIP Service only forwards
   * :8000 and the proxy must target a pod/headless address instead).
   */
  previewOrigin: string;
  /**
   * Auto-resume conversations interrupted by an agent-server restart (a dev
   * deployment). Default on; set OPENHANDS_AUTO_RESUME=0 to disable.
   */
  autoResume: boolean;
  /**
   * Public origin of THIS hub deployment (not the Agent Canvas `publicUrl`),
   * used to build the session link stamped into MR descriptions
   * (`{hubPublicUrl}/openhands/native/conversations/<id>`). Defaults to the
   * local dev UI; set OPENHANDS_HUB_PUBLIC_URL for other environments.
   */
  hubPublicUrl: string;
  /**
   * ntfy push notifications (https://docs.ntfy.sh). Env supplies defaults;
   * the Notifications page can override url/topic at runtime via agent-canvas
   * settings. Empty topic (env AND settings) disables the notifier sends.
   */
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyToken: string;
  notifyIdle: boolean;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenHandsBffConfig {
  const model = env.OPENHANDS_MODEL ?? "anthropic/claude-sonnet-5";
  const configuredModels = (env.OPENHANDS_MODELS ?? DEFAULT_MODELS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    internalUrl: (env.OPENHANDS_INTERNAL_URL ?? "").replace(/\/$/, ""),
    apiKey: env.OPENHANDS_API_KEY ?? "",
    apiKeyFile: env.OPENHANDS_API_KEY_FILE ?? "",
    publicUrl: (env.OPENHANDS_PUBLIC_URL ?? "").replace(/\/$/, ""),
    allowedEmails: (env.OPENHANDS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    model,
    models: Array.from(new Set([model, ...configuredModels])),
    // Standalone runner: GITLAB_TOKEN is the primary name; the hub's
    // HIVE_GITLAB_SAAS_* names still work for drop-in .env compatibility.
    gitlabToken: env.GITLAB_TOKEN ?? env.HIVE_GITLAB_SAAS_TOKEN ?? "",
    gitlabBaseUrl: (env.GITLAB_BASE_URL ?? env.HIVE_GITLAB_SAAS_BASE_URL ?? "https://gitlab.com").replace(/\/$/, ""),
    openaiApiKey: env.OPENAI_API_KEY ?? "",
    openaiEuBaseUrl: (env.OPENHANDS_OPENAI_EU_BASE_URL ?? env.OPENAI_BASE_URL ?? "").replace(/\/$/, ""),
    githubToken: env.OPENHANDS_GITHUB_TOKEN ?? "",
    previewOrigin: (env.OPENHANDS_PREVIEW_ORIGIN ?? "").replace(/\/$/, ""),
    autoResume: env.OPENHANDS_AUTO_RESUME !== "0",
    hubPublicUrl: (env.OPENHANDS_HUB_PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    ntfyUrl: (env.OPENHANDS_NTFY_URL ?? "https://ntfy.sh").replace(/\/$/, ""),
    ntfyTopic: env.OPENHANDS_NTFY_TOPIC ?? "",
    ntfyToken: env.OPENHANDS_NTFY_TOKEN ?? "",
    notifyIdle: env.OPENHANDS_NOTIFY_IDLE !== "0",
  };
}

/** Build the router (exported separately so tests can construct it directly). */
export async function createOpenHandsRouter(
  cfg: OpenHandsBffConfig,
  // Mutable runtime flags owned by setup(): the manager feature mounts after
  // this router is built, so its availability is read through this object.
  runtime: { managerEnabled: boolean } = { managerEnabled: false },
): Promise<RouterT> {
  const { Router } = await import("express");
  const router = Router();
  const configured = Boolean(cfg.internalUrl && (cfg.apiKey || cfg.apiKeyFile));

  // Static key wins; otherwise the key file is polled until it appears (the
  // agent-canvas container writes it at first boot, which can race the hub's
  // startup) and then cached for the router's lifetime — callers surface a
  // 502 until it exists. See ./upstream.ts.
  const upstream = createUpstream(cfg);
  // Raw key accessor for the websocket bridge (first-message auth, no headers).
  const resolveUpstreamApiKey = createApiKeyResolver(cfg);

  /** Forward an upstream JSON response (status + body) to the client. */
  async function relay(res: Response, r: globalThis.Response): Promise<void> {
    const text = await r.text();
    res.status(r.status).type("application/json").send(text || "{}");
  }

  function upstreamError(res: Response, err: unknown, what: string): void {
    logger.warn({ err, what }, "OpenHands BFF upstream call failed");
    // 504 for timeouts (upstream alive but wedged) vs 502 for everything else
    // (connection refused, key not ready, ...), so dashboards and the client
    // can tell "slow/stuck" from "down".
    if (isUpstreamTimeout(err)) {
      res.status(504).json({ error: `OpenHands timed out (${what})` });
      return;
    }
    res.status(502).json({ error: `OpenHands is unreachable (${what})` });
  }

  function workspacePath(value: unknown, defaultPath?: string, scopeRoot?: string): string | null {
    const path = value === undefined && defaultPath ? defaultPath : value;
    if (typeof path !== "string" || path.length > 4_096 || path.includes("..") || path.includes("\\") || path.includes("\0")) {
      return null;
    }
    // Global containment: always inside the shared workspace root. When a
    // conversation scope is supplied the path must additionally be the scope
    // root itself or beneath it, so a scoped view cannot reach a sibling
    // session or the flat workspace root.
    if (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`)) return null;
    if (scopeRoot && path !== scopeRoot && !path.startsWith(`${scopeRoot}/`)) return null;
    // Reject any dotfile/dotdir segment (.git, .netrc, .openhands, .git-credentials, ...)
    // so credentials and hidden config are never reachable, even without "..".
    if (path.split("/").some((segment) => segment.startsWith("."))) return null;
    return path;
  }

  // ── Conversation scope resolution ──────────────────────────────────────────
  // Resolve a conversation id to its ACTUAL working directory (see the module
  // comment on CONV_ROOT_CACHE_MS). Returns the validated scope root, or null
  // when the id cannot be resolved to a usable working dir. Never derives the
  // path from the id — deployments can mix sessions/<uuid> and legacy flat layouts.
  const convRootCache = new Map<string, { at: number; root: string | null }>();

  async function conversationRoot(id: string): Promise<string | null> {
    const cached = convRootCache.get(id);
    if (cached && Date.now() - cached.at < CONV_ROOT_CACHE_MS) return cached.root;
    let root: string | null = null;
    const r = await upstream(`/api/conversations/${id}`);
    if (r.ok) {
      const conv = (await r.json()) as { workspace?: { working_dir?: unknown } };
      root = validateWorkingDir(conv.workspace?.working_dir);
    }
    // Bounded cache: evict the oldest entry (insertion order) before growing.
    if (convRootCache.size >= CONV_ROOT_CACHE_MAX) {
      const oldest = convRootCache.keys().next().value;
      if (oldest !== undefined) convRootCache.delete(oldest);
    }
    convRootCache.set(id, { at: Date.now(), root });
    return root;
  }

  /**
   * Resolve the optional `conversation` query parameter into a scope.
   *   - returns { root: null } when absent (global, unscoped behaviour)
   *   - returns { root: <dir> } when present and resolvable
   *   - returns null after sending a 400 when the id is malformed or its
   *     working dir cannot be resolved/validated (fail closed, no data leak)
   */
  async function resolveScope(req: Request, res: Response): Promise<{ root: string | null } | null> {
    const conversation = req.query.conversation;
    if (conversation === undefined) return { root: null };
    if (typeof conversation !== "string" || !UUID_RE.test(conversation)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return null;
    }
    let root: string | null;
    try {
      root = await conversationRoot(conversation);
    } catch {
      root = null;
    }
    if (!root) {
      res.status(400).json({ error: "Unable to resolve the conversation workspace" });
      return null;
    }
    return { root };
  }

  const isAllowlisted = (req: Request): boolean => {
    const email = req.user?.email?.toLowerCase();
    return Boolean(email && cfg.allowedEmails.length > 0 && cfg.allowedEmails.includes(email));
  };

  // ── /status — reachable by any authenticated hub user ────────────────────
  router.get("/status", async (req, res) => {
    if (!configured) {
      res.json({ configured: false, allowlisted: false, publicUrl: cfg.publicUrl || null, server: null, model: cfg.model, models: cfg.models });
      return;
    }
    let server: unknown = null;
    try {
      const r = await upstream("/server_info");
      if (r.ok) {
        const info = (await r.json()) as { version?: string; uptime?: number };
        server = { version: info.version, uptime: info.uptime };
      }
    } catch {
      /* status stays best-effort */
    }
    res.json({ configured: true, allowlisted: isAllowlisted(req), publicUrl: cfg.publicUrl || null, server, model: cfg.model, models: cfg.models });
  });

  // ── Tools & health ─────────────────────────────────────────────────────────
  // Aggregated live view for the /openhands/tools page: agent-server info,
  // the agent's tool list (with grouped health probes), installed skills,
  // configured MCP servers, and BFF-side integration checks. Probes are real
  // requests, so results are cached briefly; ?refresh=1 busts the cache.
  type ToolHealth = "ok" | "unknown" | "error";
  interface ToolEntry { id: string; description: string; health: ToolHealth; detail?: string; latencyMs?: number }
  interface IntegrationEntry { id: string; label: string; health: ToolHealth; detail: string; latencyMs?: number }
  const TOOL_DESCRIPTIONS: Record<string, string> = {
    terminal: "Run shell commands in the workspace",
    file_editor: "Create & edit files",
    planning_file_editor: "Plan-mode file editing",
    read_file: "Read file contents",
    write_file: "Write files",
    edit: "Targeted string replacement",
    list_directory: "List directory entries",
    glob: "Find files by pattern",
    grep: "Search file contents",
    task: "Sub-task delegation",
    task_tool_set: "Task management tool set",
    task_tracker: "Track multi-step work",
    workflow: "Workflow execution",
    workflow_tool_set: "Workflow tool set",
    browser_tool_set: "Headless browser automation",
  };
  // Which probe covers which tool id. Everything filesystem-ish shares one
  // cheap search_subdirs call; terminal gets a real bash exec; task/workflow
  // sets are in-process (listed == available); the browser has no cheap probe.
  const FILE_TOOL_IDS = new Set(["file_editor", "planning_file_editor", "read_file", "write_file", "edit", "list_directory", "glob", "grep"]);
  const INPROCESS_TOOL_IDS = new Set(["task", "task_tool_set", "task_tracker", "workflow", "workflow_tool_set"]);

  const TOOLS_CACHE_MS = 30_000;
  let toolsCache: { at: number; body: unknown } | null = null;
  let toolsInFlight: Promise<unknown> | null = null;

  async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; err?: unknown }> {
    const start = Date.now();
    try {
      return { value: await fn(), ms: Date.now() - start };
    } catch (err) {
      return { value: null, ms: Date.now() - start, err };
    }
  }

  async function probeToolsHealth(): Promise<unknown> {
    // Agent server baseline.
    const serverProbe = await timed(async () => {
      const r = await upstream("/server_info");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { version?: string; uptime?: number };
    });
    const server = {
      health: (serverProbe.value ? "ok" : "error") as ToolHealth,
      version: serverProbe.value?.version ?? null,
      uptime: serverProbe.value?.uptime ?? null,
      latencyMs: serverProbe.ms,
    };

    // Tool list + grouped probes (run in parallel).
    const [toolList, bashProbe, fileProbe] = await Promise.all([
      timed(async () => {
        const r = await upstream("/api/tools/");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as string[];
      }),
      timed(async () => {
        const r = await upstream("/api/bash/execute_bash_command", {
          method: "POST",
          body: JSON.stringify({ command: "true", cwd: WORKSPACE_ROOT, timeout: 10 }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return true;
      }),
      timed(async () => {
        const r = await upstream(`/api/file/search_subdirs?${gitQuery(WORKSPACE_ROOT, { limit: 1 })}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return true;
      }),
    ]);

    const tools: ToolEntry[] = (Array.isArray(toolList.value) ? toolList.value : []).sort().map((id) => {
      const description = TOOL_DESCRIPTIONS[id] ?? "Agent tool";
      if (id === "terminal") {
        return bashProbe.value
          ? { id, description, health: "ok" as const, latencyMs: bashProbe.ms }
          : { id, description, health: "error" as const, detail: "bash probe failed", latencyMs: bashProbe.ms };
      }
      if (FILE_TOOL_IDS.has(id)) {
        return fileProbe.value
          ? { id, description, health: "ok" as const, latencyMs: fileProbe.ms }
          : { id, description, health: "error" as const, detail: "file API probe failed", latencyMs: fileProbe.ms };
      }
      if (INPROCESS_TOOL_IDS.has(id)) {
        return { id, description, health: "ok" as const, detail: "in-process" };
      }
      return { id, description, health: "unknown" as const, detail: "no cheap probe; verified on first agent use" };
    });

    // Skills + MCP (best-effort).
    const skillsProbe = await timed(async () => {
      const r = await upstream("/api/skills/installed");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { skills?: Array<{ name?: string; enabled?: boolean }> };
    });
    const skills = (skillsProbe.value?.skills ?? []).map((s) => ({
      name: s.name ?? "unnamed",
      health: (s.enabled === false ? "unknown" : "ok") as ToolHealth,
      detail: s.enabled === false ? "installed, disabled" : "installed",
    }));

    // MCP servers live at agent_settings.mcp_config (name → spec). Reads mask
    // secret env values, so specs carrying "**********" cannot be re-tested
    // via /api/mcp/test — those report "configured" honestly instead of a
    // fake probe. Unmasked specs (e.g. remote servers whose OAuth tokens are
    // stored server-side) get a real connect+tools/list probe.
    let mcp: Array<{ name: string; health: ToolHealth; detail: string; latencyMs?: number }> = [];
    try {
      const r = await upstream("/api/settings");
      if (r.ok) {
        const settings = (await r.json()) as Record<string, any>;
        const mcpConfig: Record<string, any> = settings?.agent_settings?.mcp_config ?? {};
        mcp = await Promise.all(
          Object.entries(mcpConfig).map(async ([name, spec]) => {
            if (spec?.enabled === false) {
              return { name, health: "unknown" as const, detail: "configured, disabled" };
            }
            if (JSON.stringify(spec).includes("**********")) {
              return { name, health: "unknown" as const, detail: "configured (secrets masked — verified on agent start)" };
            }
            const server = spec?.url
              ? { type: spec.transport ?? "streamable-http", url: spec.url, ...(spec.auth ? { auth: spec.auth } : {}) }
              : { type: "stdio", command: spec.command, args: spec.args ?? [], env: spec.env ?? {} };
            const probe = await timed(async () => {
              const res = await upstream("/api/mcp/test", {
                method: "POST",
                body: JSON.stringify({ name, server, timeout: 20 }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const body = (await res.json()) as { ok?: boolean; tools?: string[]; error?: string };
              if (!body.ok) throw new Error(body.error ?? "test failed");
              return body.tools?.length ?? 0;
            });
            return probe.value !== null
              ? { name, health: "ok" as const, detail: `connected · ${probe.value} tools`, latencyMs: probe.ms }
              : { name, health: "error" as const, detail: `probe failed (${probe.err instanceof Error ? probe.err.message.slice(0, 120) : "error"})` };
          }),
        );
      }
    } catch {
      /* best-effort */
    }

    // BFF-side integrations.
    const integrations: IntegrationEntry[] = [];

    const githubToken = process.env.OPENHANDS_GITHUB_TOKEN ?? "";
    if (githubToken) {
      const gh = await timed(async () => {
        const r = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "customizable-dca" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { login?: string };
      });
      integrations.push(
        gh.value
          ? { id: "github", label: "GitHub (gh)", health: "ok", detail: `token valid · authed as ${gh.value.login ?? "?"}`, latencyMs: gh.ms }
          : { id: "github", label: "GitHub (gh)", health: "error", detail: `token rejected (${gh.err instanceof Error ? gh.err.message : "error"}) — check OPENHANDS_GITHUB_TOKEN` },
      );
    } else {
      integrations.push({ id: "github", label: "GitHub (gh)", health: "unknown", detail: "no token — set OPENHANDS_GITHUB_TOKEN to let agents use gh" });
    }

    if (cfg.gitlabToken) {
      const gl = await timed(async () => {
        const r = await fetch(`${cfg.gitlabBaseUrl}/api/v4/user`, {
          headers: { "PRIVATE-TOKEN": cfg.gitlabToken },
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { username?: string };
      });
      integrations.push(
        gl.value
          ? { id: "gitlab", label: "GitLab", health: "ok", detail: `token valid · authed as ${gl.value.username ?? "?"}`, latencyMs: gl.ms }
          : { id: "gitlab", label: "GitLab", health: "error", detail: `token rejected (${gl.err instanceof Error ? gl.err.message : "error"}) — check GITLAB_TOKEN` },
      );
    } else {
      integrations.push({ id: "gitlab", label: "GitLab", health: "unknown", detail: "no token — set GITLAB_TOKEN for the MR panel and suggested issues" });
    }

    try {
      const settingsRes = await upstream("/api/settings");
      const settings = settingsRes.ok ? ((await settingsRes.json()) as Record<string, unknown>) : null;
      const ntfy = effectiveNtfyConfig(
        { url: cfg.ntfyUrl, topic: cfg.ntfyTopic, token: cfg.ntfyToken, notifyIdle: cfg.notifyIdle, hubPublicUrl: cfg.hubPublicUrl },
        settings,
      );
      integrations.push(
        ntfy.enabled
          ? { id: "ntfy", label: "ntfy", health: "ok", detail: `enabled · ${ntfy.url.replace(/^https?:\/\//, "")}/${ntfy.topic}` }
          : { id: "ntfy", label: "ntfy", health: "unknown", detail: "no topic configured — see the Notifications page" },
      );
    } catch {
      integrations.push({ id: "ntfy", label: "ntfy", health: "unknown", detail: "settings unavailable" });
    }

    integrations.push(
      runtime.managerEnabled
        ? { id: "manager-db", label: "Manager runs DB", health: "ok", detail: "postgres connected · schema openhands" }
        : { id: "manager-db", label: "Manager runs DB", health: "unknown", detail: "not wired — set PGHOST to enable manager runs" },
    );

    // Sandbox CLIs: one bash exec probing gh / glab / acli / ntn auth INSIDE
    // the agent container — proving what agents can actually run, not just
    // that the BFF holds tokens. Missing binaries read as fail with a hint.
    const cliProbe = await timed(async () => {
      const script = [
        `(timeout 8 gh auth status >/dev/null 2>&1 && echo gh=ok) || echo gh=fail`,
        `(timeout 8 glab api user >/dev/null 2>&1 && echo glab=ok) || echo glab=fail`,
        `(timeout 8 acli jira auth status >/dev/null 2>&1 && echo acli=ok) || echo acli=fail`,
        `(timeout 8 ntn api /v1/users/me -X GET >/dev/null 2>&1 && echo ntn=ok) || echo ntn=fail`,
      ].join("; ");
      const r = await upstream("/api/bash/execute_bash_command", {
        method: "POST",
        body: JSON.stringify({ command: script, cwd: WORKSPACE_ROOT, timeout: 30 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { output?: string; stdout?: string };
      return body.output ?? body.stdout ?? "";
    });
    const cliOut = cliProbe.value ?? "";
    const CLI_ROWS: Array<{ id: string; label: string; bin: string; hint: string }> = [
      { id: "gh-cli", label: "gh CLI (sandbox)", bin: "gh", hint: "set OPENHANDS_GITHUB_TOKEN and recreate the container" },
      { id: "glab-cli", label: "glab CLI (sandbox)", bin: "glab", hint: "run scripts/dev.sh (installs glab) and set GITLAB_TOKEN" },
      { id: "acli", label: "acli CLI (sandbox)", bin: "acli", hint: "set ATLASSIAN_SITE/EMAIL/API_TOKEN and run scripts/dev.sh" },
      { id: "ntn-cli", label: "ntn CLI (sandbox · Notion)", bin: "ntn", hint: "set NOTION_API_TOKEN and run scripts/dev.sh (installs ntn)" },
    ];
    for (const row of CLI_ROWS) {
      const ok = cliOut.includes(`${row.bin}=ok`);
      integrations.push(
        ok
          ? { id: row.id, label: row.label, health: "ok", detail: "authenticated inside the agent container", latencyMs: cliProbe.ms }
          : cliProbe.value === null
            ? { id: row.id, label: row.label, health: "unknown", detail: "probe unavailable (bash endpoint failed)" }
            : { id: row.id, label: row.label, health: "error", detail: `not working — ${row.hint}` },
      );
    }

    return { server, tools, skills, mcp, integrations, probedAt: new Date().toISOString() };
  }

  router.get("/tools", async (req, res) => {
    const refresh = req.query.refresh === "1";
    if (!refresh && toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_MS) {
      res.json(toolsCache.body);
      return;
    }
    toolsInFlight ??= probeToolsHealth().finally(() => {
      toolsInFlight = null;
    });
    try {
      const body = await toolsInFlight;
      toolsCache = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      upstreamError(res, err, "probe tools health");
    }
  });

  // ── Fail-closed gate for everything else ──────────────────────────────────
  router.use((req, res, next) => {
    if (!configured) {
      res.status(503).json({ error: "OpenHands is not configured on this deployment" });
      return;
    }
    if (!isAllowlisted(req)) {
      res.status(403).json({ error: "Your account is not allowlisted for the shared OpenHands instance" });
      return;
    }
    next();
  });

  const validId = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid conversation id" });
      return null;
    }
    return id;
  };

  function terminalQuery(req: Request, res: Response): { limit: number; pageId: string; orderGt: number | null } | null {
    const limitValue = req.query.limit;
    if (limitValue !== undefined && (typeof limitValue !== "string" || !/^\d+$/.test(limitValue) || Number(limitValue) < 1)) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return null;
    }
    const pageValue = req.query.page_id;
    if (pageValue !== undefined && (typeof pageValue !== "string" || !/^[\w-]+$/.test(pageValue) || pageValue.length > 512)) {
      res.status(400).json({ error: "Invalid page_id" });
      return null;
    }
    const orderValue = req.query.order_gt;
    if (orderValue !== undefined && (typeof orderValue !== "string" || !/^\d+$/.test(orderValue))) {
      res.status(400).json({ error: "order_gt must be a non-negative integer" });
      return null;
    }
    return {
      limit: Math.min(limitValue === undefined ? TERMINAL_DEFAULT_LIMIT : Number(limitValue), TERMINAL_MAX_LIMIT),
      pageId: typeof pageValue === "string" ? pageValue : "",
      orderGt: typeof orderValue === "string" ? Number(orderValue) : null,
    };
  }

  const validWorkspacePath = (value: unknown): string | null => {
    if (typeof value !== "string" || !value.startsWith(`${WORKSPACE_ROOT}/`) || value.includes("..")) return null;
    // Align with workspacePath (used by /files/*): reject any dot-segment so the
    // /git/* routes can never address .git, .netrc, .openhands, or
    // .git-credentials — hidden config and credentials stay unreachable.
    if (value.split("/").some((segment) => segment.startsWith("."))) return null;
    return value;
  };

  const validRef = (value: unknown): string | null => {
    if (value === undefined) return "";
    return typeof value === "string" && GIT_REF_RE.test(value) ? value : null;
  };

  function gitQuery(path: string, params: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams({ path });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return query.toString();
  }

  function truncateUtf8(value: string, maxBytes: number): string {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length <= maxBytes) return value;
    return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/, "");
  }

  function boundedDiff(diff: { original?: string | null; modified?: string | null }) {
    let budget = Math.floor((MAX_DIFF_BYTES - 128) / 2);
    let result = {
      original: diff.original === null ? null : truncateUtf8(diff.original ?? "", budget),
      modified: diff.modified === null ? null : truncateUtf8(diff.modified ?? "", budget),
      truncated: true,
    };
    // JSON escaping can grow control characters substantially, so measure the
    // exact payload and reduce both snapshots until it fits the response cap.
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_DIFF_BYTES && budget > 0) {
      budget = Math.floor(budget * 0.8);
      result = {
        original: diff.original === null ? null : truncateUtf8(diff.original ?? "", budget),
        modified: diff.modified === null ? null : truncateUtf8(diff.modified ?? "", budget),
        truncated: true,
      };
    }
    return result;
  }

  // ── Notification preferences ───────────────────────────────────────────────
  // Agent Canvas deliberately treats misc_settings as opaque frontend-owned
  // data and persists it on the PVC. The notifier sidecar reads this same
  // block every poll, so changes apply without a deployment or pod restart.
  interface CanvasSettings {
    misc_settings?: {
      customizable_dca?: {
        openhands_notifications?: {
          enabled?: boolean;
          notify_idle?: boolean;
          /** null is accepted in PATCH diffs as Agent Canvas' nested-key delete primitive. */
          mentions?: Record<string, boolean | null>;
          /** Legacy single-user shape, read during migration only. */
          mention_email?: string;
          /** ntfy overrides set from the Notifications page (env is fallback). */
          ntfy_url?: string | null;
          ntfy_topic?: string | null;
        };
        /**
         * Deliberate user pauses (conversation id → ISO timestamp). Persisted
         * on the PVC so the auto-resume reconciler (./autoResume.ts) can tell
         * a user's pause apart from a deployment casualty across restarts.
         * null in a PATCH diff is Agent Canvas' nested-key delete primitive.
         */
        openhands_user_pauses?: Record<string, string | null>;
      };
    };
  }

  /**
   * Record (or clear) the deliberate-pause marker for a conversation.
   * Best-effort: the user's pause/run already succeeded upstream, so a
   * settings hiccup must not fail the request — worst case the reconciler
   * makes the pre-marker conservative call on the next restart.
   */
  async function recordUserPause(id: string, paused: boolean): Promise<void> {
    try {
      const r = await upstream("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          misc_settings_diff: {
            customizable_dca: {
              openhands_user_pauses: { [id]: paused ? new Date().toISOString() : null },
            },
          },
        }),
      });
      if (!r.ok) logger.warn({ id, paused, status: r.status }, "OpenHands BFF: user-pause marker update rejected");
    } catch (err) {
      logger.warn({ err, id, paused }, "OpenHands BFF: user-pause marker update failed");
    }
  }

  function notificationResponse(settings: CanvasSettings, email: string) {
    const normalizedEmail = email.toLowerCase();
    const value = settings.misc_settings?.customizable_dca?.openhands_notifications;
    const mentionEmails = Object.entries(value?.mentions ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([address]) => address.toLowerCase());
    const legacyEmail = typeof value?.mention_email === "string" ? value.mention_email.toLowerCase() : null;
    if (legacyEmail && !mentionEmails.includes(legacyEmail)) mentionEmails.push(legacyEmail);
    const ntfyUrl = (typeof value?.ntfy_url === "string" && value.ntfy_url.trim()) || cfg.ntfyUrl;
    const ntfyTopic = (typeof value?.ntfy_topic === "string" && value.ntfy_topic.trim()) || cfg.ntfyTopic;
    return {
      enabled: value?.enabled !== false,
      notifyIdle: value?.notify_idle !== false,
      mentionMe: mentionEmails.includes(normalizedEmail),
      mentionEmails,
      userEmail: normalizedEmail,
      ntfyUrl,
      ntfyTopic,
      ntfyConfigured: Boolean(ntfyTopic),
      // Whether the values came from env (settings fields empty).
      ntfyFromEnv: !(typeof value?.ntfy_topic === "string" && value.ntfy_topic.trim()),
    };
  }

  const NTFY_TOPIC_RE = /^[\w.~-]{1,64}$/;

  router.get("/notifications", async (req, res) => {
    try {
      const r = await upstream("/api/settings");
      if (!r.ok) {
        await relay(res, r);
        return;
      }
      res.json(notificationResponse((await r.json()) as CanvasSettings, req.user!.email));
    } catch (err) {
      upstreamError(res, err, "read notification settings");
    }
  });

  router.patch("/notifications", async (req, res) => {
    const { enabled, notifyIdle, mentionMe, ntfyUrl, ntfyTopic } = req.body ?? {};
    if (typeof enabled !== "boolean" || typeof notifyIdle !== "boolean" || typeof mentionMe !== "boolean") {
      res.status(400).json({ error: "enabled, notifyIdle, and mentionMe must be booleans" });
      return;
    }
    // ntfy overrides are optional; empty string clears back to the env value.
    if (ntfyUrl !== undefined && (typeof ntfyUrl !== "string" || (ntfyUrl !== "" && !/^https?:\/\/[\w.:-]+$/.test(ntfyUrl.replace(/\/+$/, ""))))) {
      res.status(400).json({ error: "ntfyUrl must be an http(s) origin or empty" });
      return;
    }
    if (ntfyTopic !== undefined && (typeof ntfyTopic !== "string" || (ntfyTopic !== "" && !NTFY_TOPIC_RE.test(ntfyTopic)))) {
      res.status(400).json({ error: "ntfyTopic must match [A-Za-z0-9_.~-]{1,64} or be empty" });
      return;
    }
    const normalizedEmail = req.user!.email.toLowerCase();
    try {
      const r = await upstream("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          misc_settings_diff: {
            customizable_dca: {
              openhands_notifications: {
                enabled,
                notify_idle: notifyIdle,
                // Map entries deep-merge under the Agent Canvas file lock, so
                // each user toggles only their own mention without clobbering
                // anyone else's preference. null removes this user's entry.
                mentions: { [normalizedEmail]: mentionMe ? true : null },
                mention_email: null,
                // null deletes the override (falls back to env config).
                ...(ntfyUrl !== undefined ? { ntfy_url: ntfyUrl.replace(/\/+$/, "") || null } : {}),
                ...(ntfyTopic !== undefined ? { ntfy_topic: ntfyTopic || null } : {}),
              },
            },
          },
        }),
      });
      if (!r.ok) {
        await relay(res, r);
        return;
      }
      res.json(notificationResponse((await r.json()) as CanvasSettings, req.user!.email));
    } catch (err) {
      upstreamError(res, err, "update notification settings");
    }
  });

  // Send a test push to the effective ntfy target so the user can verify the
  // topic on their phone/desktop before relying on it.
  router.post("/notifications/test", async (req, res) => {
    try {
      const settingsRes = await upstream("/api/settings");
      const settings = settingsRes.ok ? ((await settingsRes.json()) as CanvasSettings) : {};
      const prefs = notificationResponse(settings, req.user!.email);
      if (!prefs.ntfyTopic) {
        res.status(400).json({ error: "No ntfy topic configured (set one below or via OPENHANDS_NTFY_TOPIC)" });
        return;
      }
      const posted = await postNtfy(
        { url: prefs.ntfyUrl, topic: prefs.ntfyTopic, token: cfg.ntfyToken },
        {
          title: "OpenHands test notification",
          body: "ntfy is wired up — you'll get pings on finished / error / stuck / awaiting input.",
          tag: "bell",
          click: `${cfg.hubPublicUrl}/openhands/notifications`,
        },
      );
      if (!posted.ok) {
        res.status(502).json({ error: `ntfy rejected the test message (HTTP ${posted.status})` });
        return;
      }
      res.json({ ok: true, url: prefs.ntfyUrl, topic: prefs.ntfyTopic });
    } catch (err) {
      upstreamError(res, err, "send test notification");
    }
  });

  // ── Agent settings (context condensation) ─────────────────────────────────
  // Long sessions slow down 4x+ because the stock condenser only fires at 240
  // events with the token trigger off, letting per-turn context grow past
  // 100-200k tokens (issue #48). These routes expose the condenser knobs of
  // the agent-server's *default profile*: reads relay GET /api/settings,
  // writes relay PATCH /api/settings with an `agent_settings_diff` (deep-merge,
  // so untouched fields like condenser_kind survive). Changes apply to new
  // conversations; running ones keep their frozen settings.
  router.get("/agent-settings", async (_req, res) => {
    try {
      const r = await upstream("/api/settings");
      if (!r.ok) {
        await relay(res, r);
        return;
      }
      res.json(condenserResponse((await r.json()) as UpstreamAgentSettings));
    } catch (err) {
      upstreamError(res, err, "read agent settings");
    }
  });

  router.patch("/agent-settings", async (req, res) => {
    try {
      const currentRes = await upstream("/api/settings");
      if (!currentRes.ok) {
        await relay(res, currentRes);
        return;
      }
      const current = condenserResponse((await currentRes.json()) as UpstreamAgentSettings).condenser;
      const validated = validateCondenserPatch(req.body?.condenser ?? req.body, current);
      if ("error" in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }
      const r = await upstream("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ agent_settings_diff: { condenser: validated.diff } }),
      });
      if (!r.ok) {
        await relay(res, r);
        return;
      }
      res.json(condenserResponse((await r.json()) as UpstreamAgentSettings));
    } catch (err) {
      upstreamError(res, err, "update agent settings");
    }
  });

  // ── Skills (global toggles) ───────────────────────────────────────────────
  // Which skills the agent actually loads is decided by two upstream
  // mechanisms at once — the per-install `enabled` flag and the default
  // profile's `agent_context.disabled_skills` deny-list — so reads fan out to
  // both and writes fan out to both. See ./skills.ts for the merge rules;
  // decision #17 for why this is global-only (the upstream API cannot mutate a
  // running conversation's agent_context, so a per-conversation toggle would
  // be a half-feature). Changes apply to NEW conversations.
  async function readSkills(res: Response): Promise<SkillsPayload | null> {
    const [installedRes, settingsRes] = await Promise.all([
      upstream("/api/skills/installed"),
      upstream("/api/settings"),
    ]);
    if (!installedRes.ok) {
      await relay(res, installedRes);
      return null;
    }
    if (!settingsRes.ok) {
      await relay(res, settingsRes);
      return null;
    }
    const installed = (await installedRes.json()) as UpstreamInstalledSkills;
    const settings = (await settingsRes.json()) as UpstreamAgentContext;

    // Third read: the merged effective set, so auto-loaded skills (which never
    // appear in /api/skills/installed) get a row and can be denied. Skipped
    // when every source is off — there is nothing to enumerate, and a public
    // load git-pulls the extensions repo. Best-effort: a failure degrades the
    // list rather than the page.
    const base = skillsResponse(installed, settings);
    if (base.loadingDisabled) return base;
    try {
      const loadedRes = await upstream(
        "/api/skills",
        { method: "POST", body: JSON.stringify(loadedSkillsRequest(base.sources)) },
        SKILLS_LOAD_TIMEOUT_MS,
      );
      if (!loadedRes.ok) throw new Error(`HTTP ${loadedRes.status}`);
      return skillsResponse(installed, settings, (await loadedRes.json()) as UpstreamLoadedSkills);
    } catch (err) {
      logger.warn({ err }, "OpenHands effective-skill probe failed; listing installed skills only");
      return skillsResponse(installed, settings, null, true);
    }
  }

  router.get("/skills", async (_req, res) => {
    try {
      const payload = await readSkills(res);
      if (payload) res.json(payload);
    } catch (err) {
      upstreamError(res, err, "read skills");
    }
  });

  router.patch("/skills", async (req, res) => {
    try {
      const current = await readSkills(res);
      if (!current) return;
      const plan = validateSkillsPatch(req.body, current);
      if ("error" in plan) {
        res.status(400).json({ error: plan.error });
        return;
      }
      // Install-level flags first, then the deny-list: if the settings PATCH
      // fails the deny-list (the authority) is unchanged, and the re-read
      // below reports exactly what stuck rather than what we asked for.
      for (const toggle of plan.installedToggles) {
        // Name already matched the upstream path pattern in validateSkillsPatch.
        const r = await upstream(`/api/skills/installed/${toggle.name}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: toggle.enabled }),
        });
        if (!r.ok) {
          await relay(res, r);
          return;
        }
      }
      if (plan.agentContextDiff) {
        const r = await upstream("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ agent_settings_diff: { agent_context: plan.agentContextDiff } }),
        });
        if (!r.ok) {
          await relay(res, r);
          return;
        }
      }
      const next = await readSkills(res);
      if (next) res.json(next);
    } catch (err) {
      upstreamError(res, err, "update skills");
    }
  });

  // ── Repos (create-form dropdown) ───────────────────────────────────────────
  // Lists GitLab projects the bot token is a member of — i.e. exactly the set
  // the deployed agent can clone. Walk GitLab pagination up to a bounded cap,
  // coalesce concurrent cache misses, and briefly cache failures so an outage
  // cannot turn page loads into a GitLab API thundering herd.
  type RepoItem = { path: string; name: string; url: string };
  type ReposCache = { at: number; items: RepoItem[]; error?: string };
  let reposCache: ReposCache | null = null;
  let reposRequest: Promise<RepoItem[]> | null = null;

  async function fetchRepos(): Promise<RepoItem[]> {
    const projects: {
      path_with_namespace?: string;
      name_with_namespace?: string;
      http_url_to_repo?: string;
    }[] = [];
    let page = "1";
    while (page && projects.length < REPOS_MAX_PROJECTS) {
      const url = new URL("/api/v4/projects", `${cfg.gitlabBaseUrl}/`);
      url.searchParams.set("membership", "true");
      url.searchParams.set("simple", "true");
      url.searchParams.set("archived", "false");
      url.searchParams.set("order_by", "last_activity_at");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", page);
      const r = await fetch(url, {
        headers: { "PRIVATE-TOKEN": cfg.gitlabToken },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`GitLab project listing failed (HTTP ${r.status})`);
      projects.push(...(await r.json()) as typeof projects);
      page = r.headers.get("x-next-page") ?? "";
    }
    return projects
      .slice(0, REPOS_MAX_PROJECTS)
      .filter((p) => p.path_with_namespace && p.http_url_to_repo)
      .map((p) => ({
        path: p.path_with_namespace as string,
        name: p.name_with_namespace ?? (p.path_with_namespace as string),
        url: (p.http_url_to_repo as string).replace(/\.git$/, ""),
      }))
      .filter((p) => REPO_RE.test(p.url));
  }

  // Cached, coalesced access to the bot-clonable repo set. Throws on failure
  // (with the cached error message during the failure-cache window) so callers
  // can fail closed. Shared by /repos and /suggested-issues.
  async function loadRepos(): Promise<RepoItem[]> {
    if (reposCache) {
      const ttl = reposCache.error ? REPOS_FAILURE_CACHE_MS : REPOS_CACHE_MS;
      if (Date.now() - reposCache.at < ttl) {
        if (reposCache.error) throw new Error(reposCache.error);
        return reposCache.items;
      }
    }
    if (!reposRequest) {
      reposRequest = fetchRepos()
        .then((items) => {
          reposCache = { at: Date.now(), items };
          return items;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "GitLab project listing failed";
          reposCache = { at: Date.now(), items: [], error: message };
          throw err;
        })
        .finally(() => {
          reposRequest = null;
        });
    }
    return reposRequest;
  }

  router.get("/repos", async (_req, res) => {
    if (!cfg.gitlabToken) {
      res.json({ items: [] });
      return;
    }
    try {
      res.json({ items: await loadRepos() });
    } catch (err) {
      logger.warn({ err }, "OpenHands BFF: GitLab project listing failed");
      res.status(502).json({ error: reposCache?.error ?? "GitLab project listing failed" });
    }
  });

  // ── Suggested issues (discover work to pick up) ────────────────────────────
  // Bounded, read-only discovery: given one of the bot-clonable repos, list
  // open + unassigned issues (excluding blocked/won't-do ones) so an allowed
  // user can start a conversation from a real, actionable ticket. The GitLab
  // token stays server-side; the repo identifier is validated and must be in
  // the same membership allowlist the create-form dropdown offers.
  router.get("/suggested-issues", async (req, res) => {
    if (!cfg.gitlabToken) {
      res.json({ items: [] });
      return;
    }
    const repo = typeof req.query.repo === "string" ? req.query.repo.trim() : "";
    if (!repo || !ISSUE_REPO_PATH_RE.test(repo) || repo.includes("..")) {
      res.status(400).json({ error: "repo must be a valid GitLab project path (group/subgroup/name)" });
      return;
    }
    let allowed: RepoItem[];
    try {
      allowed = await loadRepos();
    } catch (err) {
      logger.warn({ err }, "OpenHands BFF: repo allowlist unavailable for suggested issues");
      res.status(502).json({ error: reposCache?.error ?? "GitLab project listing failed" });
      return;
    }
    const match = allowed.find((r) => r.path === repo);
    if (!match) {
      // The cached list keeps only the 500 most-recently-active memberships,
      // so quiet repos fall out of the window and used to 404 here even
      // though the bot is a member. Fall back to a direct probe that (a)
      // keeps the MEMBERSHIP boundary — a resolvable id is not enough, since
      // the bot token can see public/internal projects it is not a member
      // of — and (b) distinguishes a true 404 from transient GitLab errors,
      // which surface as 502 instead of a permanent-looking "not reachable".
      const probe = await probeBotMembership(
        { baseUrl: cfg.gitlabBaseUrl, token: cfg.gitlabToken },
        repo,
      );
      if (probe === "error") {
        res.status(502).json({ error: "GitLab is unavailable; try again shortly" });
        return;
      }
      if (probe !== "member") {
        res.status(404).json({ error: "repository is not one of the OpenHands bot's member projects" });
        return;
      }
    }
    try {
      const issues = await findIssues(
        { baseUrl: cfg.gitlabBaseUrl, token: cfg.gitlabToken },
        repo,
        {
          // GitLab's project issues endpoint defaults to scope=created_by_me,
          // so without this the bot only ever saw issues IT opened (usually
          // none) and the card came back empty. scope=all lists everyone's.
          scope: "all",
          state: "opened",
          assignee_id: "None",
          not_labels: SUGGESTED_ISSUES_EXCLUDED_LABELS.join(","),
          order_by: "updated_at",
          sort: "desc",
          per_page: SUGGESTED_ISSUES_MAX,
        },
        { timeoutMs: UPSTREAM_TIMEOUT_MS },
      );
      const items = issues.slice(0, SUGGESTED_ISSUES_MAX).map((issue) => ({
        iid: issue.iid,
        title: issue.title,
        webUrl: issue.web_url,
        labels: issue.labels,
        updatedAt: issue.updated_at,
        commentCount: issue.user_notes_count,
        upvotes: issue.upvotes,
        reason: suggestionReason(issue),
      }));
      res.json({
        repo,
        repoUrl: match?.url ?? `${cfg.gitlabBaseUrl}/${repo}`,
        items,
      });
    } catch (err) {
      upstreamError(res, err, "list suggested issues");
    }
  });

  // ── Merge request viewer (sidebar) ──────────────────────────────────────────
  // Read + merge routes for MRs/PRs the agent linked in a conversation. The
  // URL comes from the client (detected in the transcript), so it is strictly
  // validated: it must parse as a GitLab MR URL on one of the two hosts the
  // injected bot token is meant for, or as a github.com PR URL. All upstream
  // calls go to the CONFIGURED GitLab base URL / api.github.com with the
  // matching bot token — never to a caller-supplied host — so neither
  // credential can be coaxed toward an arbitrary server; an MR on another
  // host simply resolves as not-found.

  type MrTarget = { kind: "gitlab" | "github"; projectPath: string; iid: number; url: string };

  /** Parse + host-validate the MR/PR url; sends the 4xx response on failure. */
  function parseMrParam(url: unknown, res: Response): MrTarget | null {
    if (typeof url !== "string") {
      res.status(400).json({ error: "url must be a GitLab merge request or GitHub pull request URL" });
      return null;
    }
    const pr = parsePullRequestUrl(url);
    if (pr && pr.host === "github.com") {
      if (!cfg.githubToken) {
        res.status(503).json({ error: "GitHub is not configured on this deployment (set OPENHANDS_GITHUB_TOKEN)" });
        return null;
      }
      return { kind: "github", projectPath: pr.projectPath, iid: pr.iid, url };
    }
    const parsed = parseMergeRequestUrl(url);
    if (!parsed) {
      res.status(400).json({ error: "url must be a GitLab merge request or GitHub pull request URL" });
      return null;
    }
    if (parsed.host !== "gitlab.com") {
      res.status(400).json({ error: "url must point at gitlab.com or github.com" });
      return null;
    }
    if (!cfg.gitlabToken) {
      res.status(503).json({ error: "GitLab is not configured on this deployment" });
      return null;
    }
    return { kind: "gitlab", projectPath: parsed.projectPath, iid: parsed.iid, url };
  }

  const ghAuth = () => ({ token: cfg.githubToken });

  function mrResponse(projectPath: string, mr: MergeRequestResult, pipeline: { status: string; webUrl: string } | null) {
    return {
      iid: mr.iid,
      projectPath,
      title: mr.title,
      state: mr.state,
      mergeStatus: mr.merge_status,
      webUrl: mr.web_url,
      description: mr.description ?? "",
      pipeline,
    };
  }

  router.get("/mr", async (req, res) => {
    const target = parseMrParam(req.query.url, res);
    if (!target) return;
    if (target.kind === "github") {
      const info = await ghGetPullRequestInfo(ghAuth(), target.projectPath, target.iid);
      if (!info) {
        res.status(404).json({ error: "Pull request not found (or GitHub is unreachable)" });
        return;
      }
      res.json(info);
      return;
    }
    const auth = { baseUrl: cfg.gitlabBaseUrl, token: cfg.gitlabToken };
    const [mr, pipelines] = await Promise.all([
      getMergeRequest(auth, target.projectPath, target.iid),
      listMergeRequestPipelines(auth, target.projectPath, target.iid, { timeoutMs: UPSTREAM_TIMEOUT_MS }),
    ]);
    if (!mr) {
      res.status(404).json({ error: "Merge request not found (or GitLab is unreachable)" });
      return;
    }
    const latest = pipelines?.[0];
    res.json(mrResponse(
      target.projectPath,
      mr,
      latest ? { status: latest.status, webUrl: latest.webUrl } : null,
    ));
  });

  // Flat, chronological comment list (system + inline diff notes dropped,
  // capped to the most recent ~50) for the card's Comments section.
  router.get("/mr/comments", async (req, res) => {
    const target = parseMrParam(req.query.url, res);
    if (!target) return;
    if (target.kind === "github") {
      res.json({ items: await ghListPullComments(ghAuth(), target.projectPath, target.iid) });
      return;
    }
    const auth = { baseUrl: cfg.gitlabBaseUrl, token: cfg.gitlabToken };
    const discussions = await fetchMrDiscussions(auth, target.projectPath, target.iid, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    res.json({ items: flattenMrComments(discussions) });
  });

  // Per-stage/per-job breakdown of the MR's latest pipeline for the card's
  // pipeline-progress section. `null` when no pipeline has run yet.
  router.get("/mr/pipeline", async (req, res) => {
    const target = parseMrParam(req.query.url, res);
    if (!target) return;
    if (target.kind === "github") {
      res.json(await ghGetPullChecksProgress(ghAuth(), target.projectPath, target.iid));
      return;
    }
    const auth = { baseUrl: cfg.gitlabBaseUrl, token: cfg.gitlabToken };
    const pipelines = await listMergeRequestPipelines(auth, target.projectPath, target.iid, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    const latest = pipelines?.[0];
    if (!latest) {
      res.json(null);
      return;
    }
    const jobs = await listPipelineJobs(auth, target.projectPath, latest.id, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    res.json({
      pipeline: { id: latest.id, status: latest.status, webUrl: latest.webUrl },
      stages: aggregatePipelineStages(jobs ?? []),
    });
  });

  router.post("/mr/merge", async (req, res) => {
    const target = parseMrParam(req.body?.url, res);
    if (!target) return;
    if (target.kind === "github") {
      const result = await ghMergePullRequest(ghAuth(), target.projectPath, target.iid);
      if (!result.ok) {
        res.status(result.status ?? 502).json({ error: result.message, reason: result.reason });
        return;
      }
      // Refetch so the card flips to "merged" immediately; when the refetch
      // itself fails, fall back to a minimal merged snapshot.
      const info = await ghGetPullRequestInfo(ghAuth(), target.projectPath, target.iid);
      res.json(info ?? {
        iid: target.iid,
        projectPath: target.projectPath,
        title: "",
        state: "merged",
        mergeStatus: "",
        webUrl: target.url,
        description: "",
        pipeline: null,
      });
      return;
    }
    const auth = { baseUrl: cfg.gitlabBaseUrl, token: cfg.gitlabToken };
    const result = await mergeMergeRequest(auth, target.projectPath, target.iid);
    if (!result.ok) {
      res.status(result.status ?? 502).json({ error: result.message, reason: result.reason });
      return;
    }
    // Merging invalidates the pipeline badge anyway — return the updated MR
    // state without a pipeline; the panel's next refresh fills it in.
    res.json(mrResponse(target.projectPath, result.mr, null));
  });

  // ── Workspace git changes (read-only) ──────────────────────────────────────

  /** List the immediate subdirectories of `root` (validated, best-effort). */
  async function listWorkspaceSubdirs(root: string): Promise<string[]> {
    const r = await upstream(`/api/file/search_subdirs?${gitQuery(root, { limit: 100 })}`);
    if (!r.ok) return [];
    const page = (await r.json()) as { items?: Array<{ path?: string }> };
    return (page.items ?? [])
      .map((item) => item.path)
      .filter((path): path is string => validWorkspacePath(path) !== null);
  }

  // Local-folder candidates for the new-task form: immediate subdirectories
  // of the host projects bind mount (LOCAL_ROOT). Returned paths are relative
  // to the projects root — exactly what POST /conversations accepts as
  // `localPath`. Empty when the mount is absent (repo-clone-only setups).
  router.get("/local-folders", async (_req, res) => {
    try {
      const dirs = await listWorkspaceSubdirs(LOCAL_ROOT);
      const items = dirs
        .filter((dir) => dir.startsWith(`${LOCAL_ROOT}/`))
        .map((dir) => dir.slice(LOCAL_ROOT.length + 1))
        .filter((rel) => localWorkingDir(rel) !== null)
        .sort()
        .map((rel) => ({ name: rel, path: rel }));
      res.json({ items });
    } catch (err) {
      upstreamError(res, err, "list local folders");
    }
  });

  // Discover git repositories. Scoped (?conversation=<id>): the conversation
  // root ITSELF (agents frequently `git clone <url> .`, leaving the repo at the
  // root) plus its immediate subdirectories. Unscoped: the legacy top-level
  // scan (so flat clones still appear) AND one level into sessions/* (so new
  // per-conversation clones are discoverable in the global view). Every
  // candidate costs one upstream git/changes probe, so the sessions fan-out is
  // bounded by REPOS_MAX_SESSION_DIRS and the total by REPOS_MAX_CANDIDATES.
  router.get("/git/repos", async (req, res) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    try {
      let candidates: string[];
      if (scope.root) {
        candidates = [scope.root, ...(await listWorkspaceSubdirs(scope.root))];
      } else {
        const topLevel = await listWorkspaceSubdirs(WORKSPACE_ROOT);
        const sessionDirs = (await listWorkspaceSubdirs(SESSIONS_ROOT)).slice(0, REPOS_MAX_SESSION_DIRS);
        const nested: string[] = [];
        for (const dir of sessionDirs) {
          // The session dir itself (clone-at-root) plus its immediate children.
          nested.push(dir, ...(await listWorkspaceSubdirs(dir)));
        }
        candidates = [...topLevel, ...nested];
      }
      // Validate, deduplicate, and cap the total candidate count.
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const path of candidates) {
        if (!validWorkspacePath(path) || seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
        if (paths.length >= REPOS_MAX_CANDIDATES) break;
      }
      const results = await Promise.all(paths.map(async (path) => {
        try {
          const changes = await upstream(`/api/git/changes?${gitQuery(path, {})}`);
          // A non-repository returns an upstream client error; it is simply not
          // shown in the picker rather than making the entire page unusable.
          if (!changes.ok) return null;
          return { name: path.slice(path.lastIndexOf("/") + 1), path };
        } catch {
          return null;
        }
      }));
      res.json({ items: results.filter((item): item is { name: string; path: string } => item !== null) });
    } catch (err) {
      upstreamError(res, err, "list workspace repositories");
    }
  });

  router.get("/git/changes", async (req, res) => {
    const repo = validWorkspacePath(req.query.repo);
    const ref = validRef(req.query.ref);
    if (!repo || ref === null) {
      res.status(400).json({ error: "Invalid repository path or git ref" });
      return;
    }
    try {
      await relay(res, await upstream(`/api/git/changes?${gitQuery(repo, { ref })}`));
    } catch (err) {
      upstreamError(res, err, "list git changes");
    }
  });

  router.get("/git/commits", async (req, res) => {
    const repo = validWorkspacePath(req.query.repo);
    if (!repo) {
      res.status(400).json({ error: "Invalid repository path" });
      return;
    }
    try {
      await relay(res, await upstream(`/api/git/commits?${gitQuery(repo, { limit: GIT_COMMITS_LIMIT })}`));
    } catch (err) {
      upstreamError(res, err, "list git commits");
    }
  });

  router.get("/git/commits/:sha/changes", async (req, res) => {
    const repo = validWorkspacePath(req.query.repo);
    const sha = String(req.params.sha ?? "");
    if (!repo || !COMMIT_SHA_RE.test(sha)) {
      res.status(400).json({ error: "Invalid repository path or commit SHA" });
      return;
    }
    try {
      await relay(res, await upstream(`/api/git/commits/${sha}/changes?${gitQuery(repo, {})}`));
    } catch (err) {
      upstreamError(res, err, "list commit changes");
    }
  });

  router.get("/git/diff", async (req, res) => {
    const path = validWorkspacePath(req.query.path);
    const ref = validRef(req.query.ref);
    const commit = typeof req.query.commit === "string" && COMMIT_SHA_RE.test(req.query.commit) ? req.query.commit : req.query.commit === undefined ? "" : null;
    if (!path || ref === null || commit === null || (ref && commit)) {
      res.status(400).json({ error: "Invalid file path, git ref, or commit SHA" });
      return;
    }
    try {
      const response = await upstream(`/api/git/diff?${gitQuery(path, { ref, commit })}`);
      if (!response.ok) {
        await relay(res, response);
        return;
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).length <= MAX_DIFF_BYTES) {
        res.type("application/json").send(text || "{}");
        return;
      }
      const diff = JSON.parse(text) as { original?: string | null; modified?: string | null };
      res.json(boundedDiff(diff));
    } catch (err) {
      upstreamError(res, err, "read git diff");
    }
  });

  // ── Conversations ──────────────────────────────────────────────────────────
  router.get("/conversations", async (_req, res) => {
    try {
      await relay(res, await upstream("/api/conversations/search?limit=100"));
    } catch (err) {
      upstreamError(res, err, "list conversations");
    }
  });

  router.post("/conversations", async (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const repoUrl = typeof req.body?.repoUrl === "string" ? req.body.repoUrl.trim() : "";
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : cfg.model;
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
      res.status(400).json({ error: `prompt is required (≤ ${MAX_PROMPT_CHARS} chars)` });
      return;
    }
    const images = validateChatImages(req.body?.images);
    if (!images.ok) {
      res.status(400).json({ error: images.error });
      return;
    }
    if (repoUrl && !REPO_RE.test(repoUrl)) {
      res.status(400).json({ error: "repoUrl must be an https URL on an allowed host" });
      return;
    }
    // Local-folder workflow: target an existing directory under the host
    // projects bind mount instead of a fresh sessions/<uuid> dir.
    const localPath = typeof req.body?.localPath === "string" ? req.body.localPath.trim() : "";
    if (localPath && repoUrl) {
      res.status(400).json({ error: "localPath and repoUrl are mutually exclusive" });
      return;
    }
    const localDir = localPath ? localWorkingDir(localPath) : null;
    if (localPath && !localDir) {
      res.status(400).json({ error: "localPath must be a plain relative folder path under the projects root" });
      return;
    }
    if (req.body?.useWorktree !== undefined && typeof req.body.useWorktree !== "boolean") {
      res.status(400).json({ error: "useWorktree must be a boolean" });
      return;
    }
    const useWorktree = req.body?.useWorktree === true;
    if (useWorktree && !localDir) {
      res.status(400).json({ error: "useWorktree requires a localPath" });
      return;
    }
    if (!cfg.models.includes(model)) {
      res.status(400).json({ error: "model is not in the configured OpenHands allowlist" });
      return;
    }
    const mode = parseConversationMode(req.body?.mode);
    if (!mode) {
      res.status(400).json({ error: "mode must be \"build\" or \"plan\"" });
      return;
    }
    // Git credentials come from the pod env (GIT_ASKPASS + bot token), so a
    // plain https clone Just Works. Direct local-folder sessions need no
    // preamble; detached worktree sessions are told to create a task branch.
    const task = repoUrl
      ? `Clone ${repoUrl} into the workspace (plain \`git clone\` — https credentials are preconfigured), cd into it, then:\n\n${prompt}`
      : useWorktree
        ? `You are in a fresh detached git worktree for this session. Create a task branch before committing changes.\n\n${prompt}`
        : prompt;
    // Mint the conversation id up front so the durable workspace directory is
    // known before creation. Agent Canvas honours the supplied conversation_id,
    // letting us isolate each conversation under ${SESSIONS_ROOT}/<uuid>.
    // Minting BEFORE the message is built also lets the MR-traceability
    // guardrail embed the exact session URL for this conversation.
    const conversationId = randomUUID();
    const isolatedDir = sessionWorkingDir(conversationId);
    const workingDir = useWorktree ? isolatedDir : (localDir ?? isolatedDir);
    const sessionUrl = `${cfg.hubPublicUrl}/openhands/native/conversations/${conversationId}`;
    const text = `${taskForMode(mode, task)}\n\n${ATTACHMENT_GUARDRAIL}\n\n${mrSessionLinkGuardrail(sessionUrl)}`;
    try {
      if (useWorktree && localDir) {
        const prepared = await execBash(createWorktreeCommand(localDir, isolatedDir), WORKTREE_SETUP_TIMEOUT_SECONDS);
        if (prepared.exitCode !== 0) {
          const detail = prepared.stderr.trim() || prepared.stdout.trim() || "git worktree add failed";
          res.status(400).json({ error: `Could not create a worktree from ${localPath}: ${detail.slice(0, 1_000)}` });
          return;
        }
      }
      // Build: NeverConfirm (run free). Plan: ConfirmRisky + LLM security
      // analyzer — read-only actions run, writes park the conversation in
      // waiting_for_confirmation until approved (see planMode.ts). The mode
      // lives entirely in the upstream confirmation_policy, so approving a
      // plan later is a policy switch, not a new conversation.
      const securityAnalyzer = securityAnalyzerForMode(mode);
      // The agent-server does not merge the persisted default profile into a
      // conversation created with an `agent_settings` payload, so the global
      // condenser and skill selection have to be forwarded by hand — see
      // conversationAgentSettings(). Best-effort: a settings read that fails
      // degrades to the stock defaults rather than blocking creation.
      let persistedSettings: UpstreamAgentSettings | null = null;
      try {
        const settingsRes = await upstream("/api/settings");
        if (settingsRes.ok) persistedSettings = (await settingsRes.json()) as UpstreamAgentSettings;
        else logger.warn({ status: settingsRes.status }, "OpenHands BFF: settings read for new conversation failed");
      } catch (err) {
        logger.warn({ err }, "OpenHands BFF: settings read for new conversation errored");
      }
      const created = await upstream("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversationId,
          workspace: { kind: "LocalWorkspace", working_dir: workingDir },
          confirmation_policy: confirmationPolicyForMode(mode),
          ...(securityAnalyzer ? { security_analyzer: securityAnalyzer } : {}),
          // stream:true wires the token-streaming callback for this LLM — the
          // SSE bridge below has nothing to forward without it (issue #48).
          agent_settings: conversationAgentSettings(persistedSettings, {
            ...llmSettingsForModel(cfg, model),
            stream: true,
          }),
          initial_message: { role: "user", content: messageContent(text, images.value) },
        }),
      });
      if (!created.ok) {
        if (useWorktree && localDir) {
          try {
            const cleaned = await execBash(removeWorktreeCommand(localDir, isolatedDir));
            if (cleaned.exitCode !== 0) {
              logger.warn({ conversationId, stderr: cleaned.stderr }, "OpenHands BFF: rejected-session worktree cleanup failed");
            }
          } catch (cleanupError) {
            logger.warn({ conversationId, err: cleanupError }, "OpenHands BFF: rejected-session worktree cleanup errored");
          }
        }
        await relay(res, created);
        return;
      }
      const conv = (await created.json()) as { id?: string };
      // The upstream must echo back exactly the id we requested; anything else
      // means the created workspace does not match the directory we derived, so
      // fail closed rather than run against an unknown working tree.
      if (conv.id !== conversationId) {
        logger.warn({ requested: conversationId, returned: conv.id }, "OpenHands BFF: conversation id mismatch");
        res.status(502).json({ error: "OpenHands returned an unexpected conversation id" });
        return;
      }
      // Fire the run; surface the conversation either way (UI shows status).
      const run = await upstream(`/api/conversations/${conversationId}/run`, { method: "POST", body: "{}" });
      res.status(201).json({ id: conversationId, started: run.ok });
    } catch (err) {
      upstreamError(res, err, "create conversation");
    }
  });

  router.get("/conversations/:id", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    try {
      await relay(res, await upstream(`/api/conversations/${id}`));
    } catch (err) {
      upstreamError(res, err, "get conversation");
    }
  });

  router.delete("/conversations/:id", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    try {
      await relay(res, await upstream(`/api/conversations/${id}`, { method: "DELETE" }));
    } catch (err) {
      upstreamError(res, err, "delete conversation");
    }
  });

  // The upstream events/search caps pages at 100, so a larger transcript read
  // walks next_page_id until the requested limit (or the end) is reached.
  //
  // This route is hit by every open conversation tab on a 3s poll, so it is
  // the amplification point when the agent-server wedges (see the
  // EVENTS_READ_TIMEOUT_MS comment): identical concurrent polls coalesce into
  // one upstream walk, each page gets a short timeout, and after a timeout the
  // conversation cools off — requests during the cool-off are answered 503
  // immediately without touching the upstream.
  type EventsWalk = { status: number; body: string };
  const eventsWalks = new Map<string, Promise<EventsWalk>>();
  const eventsCooloffUntil = new Map<string, number>();

  async function walkEvents(
    id: string,
    limit: number,
    firstPageId: string,
    newestFirst: boolean,
  ): Promise<EventsWalk> {
    const items: unknown[] = [];
    let nextPageId: string | null = null;
    let pageId = firstPageId;
    // Newest-first pages walk toward OLDER events, so next_page_id becomes a
    // "load older" cursor for the bottom-anchored transcript.
    const sortParam = newestFirst ? "&sort_order=TIMESTAMP_DESC" : "";
    while (items.length < limit) {
      const pageLimit = Math.min(EVENTS_PAGE_SIZE, limit - items.length);
      const pageParam = pageId ? `&page_id=${encodeURIComponent(pageId)}` : "";
      const r = await upstream(
        `/api/conversations/${id}/events/search?limit=${pageLimit}${sortParam}${pageParam}`,
        {},
        EVENTS_READ_TIMEOUT_MS,
      );
      if (!r.ok) return { status: r.status, body: (await r.text()) || "{}" };
      const page = (await r.json()) as { items?: unknown[]; next_page_id?: string | null };
      items.push(...(page.items ?? []));
      nextPageId = page.next_page_id ?? null;
      if (!nextPageId || (page.items ?? []).length === 0) break;
      pageId = nextPageId;
    }
    return { status: 200, body: JSON.stringify({ items, next_page_id: nextPageId }) };
  }

  router.get("/conversations/:id/events", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const limit = Math.min(Number(req.query.limit) || 200, EVENTS_MAX_LIMIT);
    const pageId = typeof req.query.page_id === "string" && /^[\w-]+$/.test(req.query.page_id)
      ? req.query.page_id
      : "";
    const newestFirst = req.query.order === "desc";
    const coolUntil = eventsCooloffUntil.get(id) ?? 0;
    if (Date.now() < coolUntil) {
      res
        .status(503)
        .set("Retry-After", String(Math.ceil((coolUntil - Date.now()) / 1000)))
        .json({ error: "OpenHands timed out (list events) — cooling off" });
      return;
    }
    const key = `${id}|${limit}|${pageId}|${newestFirst ? "desc" : "asc"}`;
    let walk = eventsWalks.get(key);
    if (!walk) {
      walk = walkEvents(id, limit, pageId, newestFirst).finally(() => eventsWalks.delete(key));
      eventsWalks.set(key, walk);
    }
    const walkStarted = Date.now();
    try {
      const out = await walk;
      // Slow-step attribution (issue #48): a slow transcript walk means the
      // agent-server itself is the bottleneck (worker pool / event store), as
      // opposed to LLM generation time, which never shows up here.
      const walkMs = Date.now() - walkStarted;
      if (walkMs > EVENTS_SLOW_WALK_LOG_MS) {
        logger.info({ id, limit, ms: walkMs }, "OpenHands BFF: slow events walk");
      }
      res.status(out.status).type("application/json").send(out.body);
    } catch (err) {
      if (isUpstreamTimeout(err)) {
        // Bounded map: drop expired entries first, then oldest if still full.
        // Only evict when inserting a genuinely NEW id — a re-timeout of an
        // already-cooling conversation updates its key in place and must not
        // push an unrelated conversation out of its cool-off early.
        const now = Date.now();
        for (const [k, until] of eventsCooloffUntil) if (until <= now) eventsCooloffUntil.delete(k);
        if (!eventsCooloffUntil.has(id) && eventsCooloffUntil.size >= EVENTS_COOLOFF_MAX_ENTRIES) {
          const oldest = eventsCooloffUntil.keys().next().value;
          if (oldest !== undefined) eventsCooloffUntil.delete(oldest);
        }
        eventsCooloffUntil.set(id, now + EVENTS_TIMEOUT_COOLOFF_MS);
      }
      upstreamError(res, err, "list events");
    }
  });

  // ── Live token stream (SSE ⇄ upstream websocket) ───────────────────────────
  // The static poll shows nothing for the whole duration of an LLM step (84s+
  // on long sessions; issue #48). This bridges the agent-server's event
  // websocket to a browser EventSource: StreamingDeltaEvent frames become
  // `delta` SSE events (draft bubble), every durable event becomes a
  // lightweight `event` ping (client polls immediately and drops the draft).
  // Display-only: if the stream dies the client silently degrades to the poll.
  router.get("/conversations/:id/stream", (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const key = resolveUpstreamApiKey();
    if (!key) {
      res.status(502).json({ error: "OpenHands is unreachable (stream: API key not ready)" });
      return;
    }
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defensive: disables buffering in nginx-style proxies if one ever fronts this.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsEventsUrl(cfg.internalUrl, id));
    } catch (err) {
      logger.warn({ err, id }, "OpenHands BFF: event stream websocket dial failed");
      res.write(sseSerialize({ event: "event", data: JSON.stringify({ kind: "end" }) }));
      res.end();
      return;
    }
    // Comment heartbeat keeps intermediaries (vite dev proxy, LBs) from
    // idle-closing the response during long silent stretches.
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    // Idle guard: clients only stream while a run is active, so an upstream
    // socket that has produced no frames at all for this long is wedged —
    // reap it rather than hold a connection slot forever (#58).
    let lastFrameAt = Date.now();
    const idleReaper = setInterval(() => {
      if (Date.now() - lastFrameAt > STREAM_IDLE_MAX_MS) cleanup();
    }, 60_000);
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearInterval(idleReaper);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      res.end();
    };
    ws.addEventListener("open", () => {
      // First-message auth: undici's browser-style WebSocket cannot send
      // custom headers, and query-param auth is deprecated upstream.
      ws.send(wsAuthFrame(key));
    });
    ws.addEventListener("message", (m) => {
      lastFrameAt = Date.now();
      const frame = mapWsFrame(typeof m.data === "string" ? m.data : "");
      if (frame) res.write(sseSerialize(frame));
    });
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", (err) => {
      logger.debug({ err, id }, "OpenHands BFF: event stream websocket error");
      cleanup();
    });
    req.on("close", cleanup);
  });

  // The agent's final summary is a FinishAction near the END of the event log,
  // so any bounded transcript read can miss it. The upstream exposes it
  // directly; relay it so the client can render the answer for conversations
  // of any length without walking every event page.
  router.get("/conversations/:id/agent_final_response", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    try {
      await relay(res, await upstream(`/api/conversations/${id}/agent_final_response`));
    } catch (err) {
      upstreamError(res, err, "agent final response");
    }
  });

  router.post("/conversations/:id/messages", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!text || text.length > MAX_PROMPT_CHARS) {
      res.status(400).json({ error: `text is required (≤ ${MAX_PROMPT_CHARS} chars)` });
      return;
    }
    if (model && !cfg.models.includes(model)) {
      res.status(400).json({ error: "model is not in the configured OpenHands allowlist" });
      return;
    }
    const images = validateChatImages(req.body?.images);
    if (!images.ok) {
      res.status(400).json({ error: images.error });
      return;
    }
    try {
      if (model) {
        // Swap the conversation's LLM BEFORE delivering the message so the
        // reply is produced by the requested model. usage_id keys the
        // agent-server's per-conversation LLM registry (first-write-wins), so
        // the model id itself is the key: switching back to a previously used
        // model reuses its cached LLM instead of minting a duplicate.
        const switched = await upstream(`/api/conversations/${id}/switch_llm`, {
          method: "POST",
          body: JSON.stringify({ llm: { ...llmSettingsForModel(cfg, model), usage_id: model, stream: true } }),
        });
        if (!switched.ok) {
          await relay(res, switched);
          return;
        }
      }
      const sent = await upstream(`/api/conversations/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: messageContent(text, images.value), run: true }),
      });
      // run:true restarts the loop, so a previous deliberate pause is over.
      if (sent.ok) void recordUserPause(id, false);
      await relay(res, sent);
    } catch (err) {
      upstreamError(res, err, "send message");
    }
  });

  // Switch a conversation between Plan and Build mid-run (the Shift+Tab of
  // this app). The mode is the upstream confirmation policy — switching to
  // build lifts the write gate; switching to plan (re)installs it together
  // with the LLM security analyzer that risk-labels actions. `notify: true`
  // on a build switch also delivers the canned "plan approved — implement"
  // message and restarts the loop, which is the one-click approve-plan flow.
  router.post("/conversations/:id/mode", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const mode = req.body?.mode === "build" || req.body?.mode === "plan" ? req.body.mode : null;
    if (!mode) {
      res.status(400).json({ error: "mode must be \"build\" or \"plan\"" });
      return;
    }
    const notify = req.body?.notify === true && mode === "build";
    try {
      const securityAnalyzer = securityAnalyzerForMode(mode);
      if (securityAnalyzer) {
        const analyzerSet = await upstream(`/api/conversations/${id}/security_analyzer`, {
          method: "POST",
          body: JSON.stringify({ security_analyzer: securityAnalyzer }),
        });
        if (!analyzerSet.ok) {
          await relay(res, analyzerSet);
          return;
        }
      }
      const policySet = await upstream(`/api/conversations/${id}/confirmation_policy`, {
        method: "POST",
        body: JSON.stringify({ policy: confirmationPolicyForMode(mode) }),
      });
      if (!policySet.ok) {
        await relay(res, policySet);
        return;
      }
      if (notify) {
        const sent = await upstream(`/api/conversations/${id}/events`, {
          method: "POST",
          body: JSON.stringify({ role: "user", content: messageContent(PLAN_APPROVED_MESSAGE, []), run: true }),
        });
        if (sent.ok) void recordUserPause(id, false);
        if (!sent.ok) {
          await relay(res, sent);
          return;
        }
      }
      res.json({ mode, notified: notify });
    } catch (err) {
      upstreamError(res, err, "switch mode");
    }
  });

  router.post("/conversations/:id/respond_to_confirmation", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const accept = req.body?.accept;
    if (typeof accept !== "boolean") {
      res.status(400).json({ error: "accept must be a boolean" });
      return;
    }
    try {
      await relay(res, await upstream(`/api/conversations/${id}/events/respond_to_confirmation`, {
        method: "POST",
        body: JSON.stringify({ accept }),
      }));
    } catch (err) {
      upstreamError(res, err, "respond to confirmation");
    }
  });

  for (const action of ["run", "pause"] as const) {
    router.post(`/conversations/:id/${action}`, async (req, res) => {
      const id = validId(req, res);
      if (!id) return;
      try {
        const r = await upstream(`/api/conversations/${id}/${action}`, { method: "POST", body: "{}" });
        // Track deliberate pauses (and their reversal) so the auto-resume
        // reconciler never unpauses a conversation the user chose to stop.
        if (r.ok) void recordUserPause(id, action === "pause");
        await relay(res, r);
      } catch (err) {
        upstreamError(res, err, action);
      }
    });
  }

  // ── Shared workspace files (read-only) ──────────────────────────────────────
  // Agent Canvas v1.40 exposes a paginated directory-only API (search_subdirs)
  // and no file-listing endpoint, so files are listed per directory with one
  // FIXED-SHAPE `find -maxdepth 1 -type f` through the authenticated bash API
  // (browser input only ever selects the already-validated directory path).
  // Every returned path passes the same scope-containment + dotfile checks as
  // the directories; the listing is bounded (head -200) and best-effort — a
  // failed find degrades to an empty files array, never a failed response.
  router.get("/files/tree", async (req, res) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    // Scoped: default to (and confine within) the conversation root. Unscoped:
    // default to the workspace root and confine within it as before.
    const defaultRoot = scope.root ?? WORKSPACE_ROOT;
    const path = workspacePath(req.query.path, defaultRoot, scope.root ?? undefined);
    if (!path) {
      res.status(400).json({ error: `path must be inside ${scope.root ?? WORKSPACE_ROOT}` });
      return;
    }
    const rawPageId = req.query.page_id;
    if (rawPageId !== undefined && (typeof rawPageId !== "string" || !/^[\w.-]{1,256}$/.test(rawPageId))) {
      res.status(400).json({ error: "Invalid page_id" });
      return;
    }
    const pageId = rawPageId;
    try {
      const params = new URLSearchParams({ path, limit: "100" });
      if (pageId) params.set("page_id", pageId);
      const r = await upstream(`/api/file/search_subdirs?${params}`);
      if (!r.ok) {
        await relay(res, r);
        return;
      }
      const page = (await r.json()) as {
        items?: { name?: string; path?: string }[];
        next_page_id?: string | null;
      };
      const dirs = (page.items ?? [])
        .filter((item) => typeof item.name === "string" && workspacePath(item.path, undefined, scope.root ?? undefined))
        .map((item) => ({ name: item.name as string, path: item.path as string }));
      // Files only on the FIRST page: pagination applies to the (potentially
      // huge) directory list; the bounded file listing would only duplicate
      // itself on later pages.
      let files: { name: string; path: string }[] = [];
      if (!pageId) {
        try {
          const out = await execBash(
            `find ${shellQuote(path)} -maxdepth 1 -type f -not -path '*/.git/*' | head -200`,
          );
          if (out.exitCode === 0) {
            files = out.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              // Same containment + dotfile rejection as the directories, plus
              // "directly under the listed directory" (defense in depth over
              // find's -maxdepth) — anything else is dropped silently.
              .map((raw) => workspacePath(raw, undefined, scope.root ?? undefined))
              .filter((p): p is string => p !== null && p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
              .map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p }))
              .sort((a, b) => a.name.localeCompare(b.name));
          }
        } catch {
          /* directory listing is still useful without files */
        }
      }
      res.json({ path, dirs, files, nextPageId: page.next_page_id ?? null });
    } catch (err) {
      upstreamError(res, err, "list workspace directories");
    }
  });

  router.get("/files/content", async (req, res) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const path = workspacePath(req.query.path, undefined, scope.root ?? undefined);
    // A directory (the workspace root or the scope root) is never a readable file.
    if (!path || path === WORKSPACE_ROOT || path === scope.root) {
      res.status(400).json({ error: `path must be a file inside ${scope.root ?? WORKSPACE_ROOT}` });
      return;
    }
    try {
      const r = await upstream(`/api/file/download?${new URLSearchParams({ path })}`);
      if (!r.ok) {
        await relay(res, r);
        return;
      }

      const declaredSize = Number(r.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredSize) && declaredSize > FILE_CONTENT_MAX_BYTES) {
        await r.body?.cancel();
        res.status(413).json({ error: "File is too large to display (maximum 256 KB)" });
        return;
      }
      const reader = r.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (size + value.byteLength > FILE_CONTENT_MAX_BYTES) {
            await reader.cancel();
            res.status(413).json({ error: "File is too large to display (maximum 256 KB)" });
            return;
          }
          chunks.push(value);
          size += value.byteLength;
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (bytes.includes(0)) {
        res.status(415).json({ error: "Binary files cannot be displayed" });
        return;
      }
      res.json({ path, content: new TextDecoder().decode(bytes) });
    } catch (err) {
      upstreamError(res, err, "read workspace file");
    }
  });

  // ── Workspace files (read-only) ─────────────────────────────────────────────
  router.get("/conversations/:id/files", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (path.includes("..") || path.startsWith("/")) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }
    const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
    try {
      await relay(res, await upstream(`/api/conversations/${id}/workspace${suffix}`));
    } catch (err) {
      upstreamError(res, err, "workspace files");
    }
  });

  // ── Shared workspace disk usage (read-only) ────────────────────────────────
  // One fixed `df` probe of the shared workspace volume (see the
  // DISK_USAGE_COMMAND comment for why this is not an exec endpoint). Cached
  // with in-flight dedupe so concurrent pollers share a single upstream call.
  let diskCache: { at: number; body: DiskUsage } | null = null;
  let diskInFlight: Promise<DiskUsage> | null = null;

  async function probeDiskUsage(): Promise<DiskUsage> {
    const r = await upstream("/api/bash/execute_bash_command", {
      method: "POST",
      body: JSON.stringify({
        command: DISK_USAGE_COMMAND,
        cwd: WORKSPACE_ROOT,
        timeout: DISK_USAGE_TIMEOUT_SECONDS,
      }),
    });
    if (!r.ok) throw new Error(`disk probe returned HTTP ${r.status}`);
    const output = (await r.json()) as { exit_code?: number | null; stdout?: string | null };
    if (output.exit_code !== 0) throw new Error(`df exited with ${output.exit_code ?? "no exit code"}`);
    const parsed = parseDfOutput(output.stdout ?? "");
    if (!parsed) throw new Error("df output was not parseable");
    const body: DiskUsage = { workspaceRoot: WORKSPACE_ROOT, ...parsed, checkedAt: new Date().toISOString() };
    diskCache = { at: Date.now(), body };
    return body;
  }

  router.get("/disk", async (_req, res) => {
    if (diskCache && Date.now() - diskCache.at < DISK_USAGE_CACHE_MS) {
      res.json(diskCache.body);
      return;
    }
    diskInFlight ??= probeDiskUsage().finally(() => {
      diskInFlight = null;
    });
    try {
      res.json(await diskInFlight);
    } catch (err) {
      upstreamError(res, err, "disk usage");
    }
  });

  // ── Shared terminal history (read-only) ────────────────────────────────────
  router.get("/terminal/commands", async (req, res) => {
    const query = terminalQuery(req, res);
    if (!query) return;
    const pageParam = query.pageId ? `&page_id=${encodeURIComponent(query.pageId)}` : "";
    try {
      const commandsResponse = await upstream(`/api/bash/bash_events/search?kind__eq=BashCommand&sort_order=TIMESTAMP_DESC&limit=${query.limit}${pageParam}`);
      if (!commandsResponse.ok) {
        await relay(res, commandsResponse);
        return;
      }
      const commands = (await commandsResponse.json()) as {
        items?: { id?: string; command?: string; cwd?: string | null; timestamp?: string }[];
        next_page_id?: string | null;
      };
      res.json({
        items: (commands.items ?? []).map((command) => ({
          id: command.id,
          command: stripAnsi(command.command ?? ""),
          cwd: command.cwd ?? null,
          timestamp: command.timestamp,
          // Exit status belongs to BashOutput, so load it lazily with the
          // command output. This works for every paginated history page.
          exit_code: null,
        })),
        next_page_id: commands.next_page_id ?? null,
      });
    } catch (err) {
      upstreamError(res, err, "list terminal commands");
    }
  });

  router.get("/terminal/commands/:commandId/output", async (req, res) => {
    const commandId = String(req.params.commandId ?? "");
    if (!BASH_COMMAND_ID_RE.test(commandId)) {
      res.status(400).json({ error: "Invalid command id" });
      return;
    }
    const query = terminalQuery(req, res);
    if (!query) return;
    const pageParam = query.pageId ? `&page_id=${encodeURIComponent(query.pageId)}` : "";
    const orderParam = query.orderGt === null ? "" : `&order__gt=${query.orderGt}`;
    try {
      const r = await upstream(`/api/bash/bash_events/search?kind__eq=BashOutput&command_id__eq=${commandId}&sort_order=TIMESTAMP&limit=${query.limit}${pageParam}${orderParam}`);
      if (!r.ok) {
        await relay(res, r);
        return;
      }
      const page = (await r.json()) as { items?: BashOutputEvent[]; next_page_id?: string | null };
      res.json({ ...sanitizeBashOutputs(page.items ?? []), next_page_id: page.next_page_id ?? null });
    } catch (err) {
      upstreamError(res, err, "read terminal output");
    }
  });

  // ── Live frontend preview ──────────────────────────────────────────────────
  // Advisory config: whether the preview is wired, the default port, and the
  // repo → run-command hints. Reachable by any allowlisted user (it exposes no
  // upstream data, just static hints).
  router.get("/preview/config", (_req, res) => {
    res.json({
      enabled: Boolean(previewTargetOrigin(cfg)),
      defaultPort: PREVIEW_DEFAULT_PORT,
      portRange: { min: PREVIEW_PORT_MIN, max: PREVIEW_PORT_MAX },
      repos: PREVIEW_REPOS,
    });
  });

  // ── Preview lifecycle (start/stop/status/logs) ─────────────────────────────
  // All control commands are FIXED server-side scripts (allowlisted
  // PREVIEW_REPOS run command + validated-UUID-derived /tmp paths) executed via
  // the same authenticated upstream bash API the disk probe uses — browser
  // input never reaches the shell. Everything sits behind the fail-closed
  // email-allowlist gate above.

  // Bounded in-memory conversation → registered-port cache. The pod-side
  // portfile (written by start / PUT target) is the persistent source of
  // truth, so registrations survive BFF restarts; this map just avoids a bash
  // round-trip per proxied asset request.
  const previewPorts = new Map<string, number>();
  function rememberPreviewPort(id: string, port: number): void {
    if (!previewPorts.has(id) && previewPorts.size >= PREVIEW_PORTS_MAX) {
      const oldest = previewPorts.keys().next().value;
      if (oldest !== undefined) previewPorts.delete(oldest);
    }
    previewPorts.set(id, port);
  }

  async function execBash(
    command: string,
    timeout = PREVIEW_CONTROL_TIMEOUT_SECONDS,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const r = await upstream("/api/bash/execute_bash_command", {
      method: "POST",
      body: JSON.stringify({ command, cwd: WORKSPACE_ROOT, timeout }),
    });
    if (!r.ok) throw new Error(`bash control command returned HTTP ${r.status}`);
    const out = (await r.json()) as { exit_code?: number | null; stdout?: string | null; stderr?: string | null };
    return { exitCode: out.exit_code ?? null, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  }

  /** HEAD-probe a preview port; ANY http response (even 404) means reachable. */
  async function probePreview(port: number, base: string): Promise<boolean> {
    const target = previewTargetUrl(cfg, port, `${base}/`);
    if (!target) return false;
    try {
      await fetch(target, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(PREVIEW_PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }

  // Tiny TTL cache over the pod-state probe (pidfile / portfile / workspace
  // dir) so multi-tab 5s pollers add bounded bash-event noise, mirroring the
  // /disk probe's rationale.
  const previewStateCache = new Map<string, { at: number; state: ReturnType<typeof parsePreviewStateProbe> }>();

  async function probePreviewState(id: string, root: string | null): Promise<ReturnType<typeof parsePreviewStateProbe>> {
    const cached = previewStateCache.get(id);
    if (cached && Date.now() - cached.at < PREVIEW_STATE_CACHE_MS) return cached.state;
    const { pidFile, portFile } = previewRuntimePaths(id);
    const script = [
      `[ -f ${shellQuote(pidFile)} ] && echo pid=1 || echo pid=0`,
      // Liveness of the recorded process GROUP (kill -0 -pgid): distinguishes
      // "still starting" from "crashed and left a stale pidfile" (failed npm
      // install, --strictPort conflict, OOM). Non-numeric pidfile = not alive.
      `if [ -f ${shellQuote(pidFile)} ]; then pg=$(head -1 ${shellQuote(pidFile)}); case "$pg" in ''|*[!0-9]*) echo alive=0;; *) kill -0 -"$pg" 2>/dev/null && echo alive=1 || echo alive=0;; esac; fi`,
      `[ -f ${shellQuote(portFile)} ] && echo port=$(head -1 ${shellQuote(portFile)})`,
      root ? `[ -d ${shellQuote(root)} ] && echo ws=1 || echo ws=0` : "echo ws=0",
    ].join("\n");
    const out = await execBash(script);
    const state = parsePreviewStateProbe(out.stdout);
    if (previewStateCache.size >= PREVIEW_PORTS_MAX) {
      const oldest = previewStateCache.keys().next().value;
      if (oldest !== undefined) previewStateCache.delete(oldest);
    }
    previewStateCache.set(id, { at: Date.now(), state });
    return state;
  }

  /** Resolve a conversation's registered port: memory first, then portfile. */
  async function registeredPreviewPort(id: string): Promise<number | null> {
    const cached = previewPorts.get(id);
    if (cached !== undefined) return cached;
    const { portFile } = previewRuntimePaths(id);
    const out = await execBash(`head -1 ${shellQuote(portFile)} 2>/dev/null || true`);
    const port = parsePreviewPort(out.stdout.trim());
    if (port !== null) rememberPreviewPort(id, port);
    return port;
  }

  // One-click start: run the ALLOWLISTED repo command (never browser input)
  // detached in the session workspace, recording pidfile + portfile in /tmp.
  // `setsid` makes the detached sh a process-group leader so stop can kill the
  // whole tree (npm → vite → esbuild) with one negative-pid signal.
  router.post("/conversations/:id/preview/start", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    if (!previewTargetOrigin(cfg)) {
      res.status(503).json({ error: "Live preview is not configured on this deployment" });
      return;
    }
    const repo = resolvePreviewRepo(req.body?.repoMatch);
    if (!repo) {
      res.status(400).json({ error: "repoMatch does not match any preview-enabled repo" });
      return;
    }
    let root: string | null;
    try {
      root = await conversationRoot(id);
    } catch {
      root = null;
    }
    if (!root) {
      res.status(400).json({ error: "Unable to resolve the conversation workspace" });
      return;
    }
    const port = derivePreviewPort(id);
    const base = previewAppBase(id);
    const command = fillRunCommand(repo.runCommand, base, port);
    const { pidFile, logFile, portFile } = previewRuntimePaths(id);
    // Auto-clone: when the workspace has no checkout yet but the conversation
    // is associated with a repo (probe B — the create-flow's "Clone <url>"
    // message — or the workspace remote), the detached start clones it first.
    // Best-effort and validated (https on an allowed host only).
    let cloneUrl: string | null = null;
    try {
      cloneUrl = await inferConversationRepo(upstream, id);
    } catch {
      cloneUrl = null;
    }
    // The clone usually lives in <root>/<repo-dir>; when it doesn't, discover
    // it: the session root itself if it holds a package.json (flat checkout),
    // else the first immediate child directory that does (clones named after
    // the project path, renamed dirs, …). `exit 90` marks a missing workspace
    // so the panel can explain the janitor's 2h TTL; `exit 91` marks "no
    // package.json anywhere" so Start fails loudly instead of detaching an
    // npm install that dies on ENOENT in the wrong directory.
    const repoDir = `${root}/${repo.match}`;
    const discoverLine = `if [ -d ${shellQuote(repoDir)} ]; then d=${shellQuote(repoDir)}; elif [ ! -f "$d/package.json" ]; then for cand in "$d"/*/package.json; do if [ -f "$cand" ]; then d=\${cand%/package.json}; break; fi; done; fi`;
    // Detached clone-then-run: `git clone` can far exceed the bounded control
    // timeout, so it runs inside the setsid'd process with its output in the
    // preview log — a failed clone dies there and surfaces as the existing
    // "exited" classification with the log tail telling the story.
    const cloneAndRun = [
      `cd ${shellQuote(root)}`,
      `git clone ${shellQuote(cloneUrl ?? "")}`,
      `d=${shellQuote(root)}`,
      `${discoverLine}`,
      `cd "$d"`,
      `[ -f package.json ] || exit 91`,
      command,
    ].join(" && ");
    const script = [
      // Idempotent restart: tear down a previous instance of THIS conversation
      // first, so Start after a config change never leaks an orphan listener.
      `if [ -f ${shellQuote(pidFile)} ]; then pg=$(head -1 ${shellQuote(pidFile)}); case "$pg" in ''|*[!0-9]*) ;; *) kill -TERM -"$pg" 2>/dev/null || true;; esac; rm -f ${shellQuote(pidFile)}; fi`,
      `[ -d ${shellQuote(root)} ] || exit 90`,
      `d=${shellQuote(root)}`,
      discoverLine,
      ...(cloneUrl
        ? [
            // No checkout found but the conversation names a repo: clone it in
            // the detached process (env-quoted URL, never browser input),
            // re-run the discovery chain, then start the dev server.
            `if [ ! -f "$d/package.json" ] && [ "$d" = ${shellQuote(root)} ]; then rm -f ${shellQuote(logFile)}; setsid nohup sh -c ${shellQuote(cloneAndRun)} > ${shellQuote(logFile)} 2>&1 & echo $! > ${shellQuote(pidFile)}; echo ${port} > ${shellQuote(portFile)}; echo cloning; exit 0; fi`,
          ]
        : []),
      `cd "$d" || exit 90`,
      `[ -f package.json ] || exit 91`,
      `rm -f ${shellQuote(logFile)}`,
      `setsid nohup sh -c ${shellQuote(command)} > ${shellQuote(logFile)} 2>&1 & echo $! > ${shellQuote(pidFile)}`,
      `echo ${port} > ${shellQuote(portFile)}`,
    ].join("\n");
    try {
      const out = await execBash(script);
      previewStateCache.delete(id);
      if (out.exitCode === 90) {
        res.status(409).json({ error: "The session workspace no longer exists (agent workspaces are pruned after 2h of inactivity) — resume the conversation to recreate it, then start the preview again", status: "workspace-missing" });
        return;
      }
      if (out.exitCode === 91) {
        // Differentiated: with an inferable repo the auto-clone path above
        // would have handled it, so landing here means no repository is
        // associated with this conversation at all.
        res.status(409).json({
          error: cloneUrl
            ? `No package.json found in the session workspace — the ${repo.label} checkout isn't there yet. Ask the agent to clone the repo (or clone it in the terminal), then press Start again.`
            : "No package.json found and no repository is associated with this conversation — ask the agent to clone one first, then press Start again.",
        });
        return;
      }
      if (out.exitCode !== 0) {
        res.status(502).json({ error: `Preview start command failed (exit ${out.exitCode ?? "unknown"})` });
        return;
      }
      rememberPreviewPort(id, port);
      res.json({ status: "starting", port, previewBase: base, repo: repo.label, command });
    } catch (err) {
      upstreamError(res, err, "start preview");
    }
  });

  // Stop: kill the recorded process GROUP (TERM, then KILL for stragglers) and
  // remove the pidfile. The pgid is re-validated as numeric in-shell so a
  // corrupted pidfile can never turn into a stray kill expression.
  router.post("/conversations/:id/preview/stop", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const { pidFile } = previewRuntimePaths(id);
    const script = [
      `[ -f ${shellQuote(pidFile)} ] || { echo no-pidfile; exit 0; }`,
      `pg=$(head -1 ${shellQuote(pidFile)})`,
      `rm -f ${shellQuote(pidFile)}`,
      `case "$pg" in ''|*[!0-9]*) echo bad-pidfile; exit 0;; esac`,
      `kill -TERM -"$pg" 2>/dev/null || true`,
      `sleep 1`,
      `kill -0 -"$pg" 2>/dev/null && kill -KILL -"$pg" 2>/dev/null || true`,
      `echo stopped`,
    ].join("\n");
    try {
      const out = await execBash(script);
      previewStateCache.delete(id);
      if (out.exitCode !== 0) {
        res.status(502).json({ error: `Preview stop command failed (exit ${out.exitCode ?? "unknown"})` });
        return;
      }
      res.json({ stopped: true, hadPidFile: !out.stdout.includes("no-pidfile") });
    } catch (err) {
      upstreamError(res, err, "stop preview");
    }
  });

  // Status: reachability probe first (an answering target IS running — no bash
  // noise on the happy path), then one cached pod-state probe to distinguish
  // starting / stopped / workspace-missing.
  router.get("/conversations/:id/preview/status", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    if (!previewTargetOrigin(cfg)) {
      res.status(503).json({ error: "Live preview is not configured on this deployment" });
      return;
    }
    const base = previewAppBase(id);
    try {
      let root: string | null;
      try {
        root = await conversationRoot(id);
      } catch {
        root = null;
      }
      const cachedPort = previewPorts.get(id) ?? null;
      if (cachedPort !== null && (await probePreview(cachedPort, base))) {
        res.json({ status: "running", port: cachedPort, previewBase: base, registered: true });
        return;
      }
      const state = await probePreviewState(id, root);
      const port = state.registeredPort ?? cachedPort ?? derivePreviewPort(id);
      if (state.registeredPort !== null) rememberPreviewPort(id, state.registeredPort);
      const reachable = await probePreview(port, base);
      const status = classifyPreviewStatus({ reachable, pidFileExists: state.pidFileExists, processAlive: state.processAlive, workspaceExists: state.workspaceExists });
      res.json({ status, port, previewBase: base, registered: state.registeredPort !== null || cachedPort !== null });
    } catch (err) {
      upstreamError(res, err, "preview status");
    }
  });

  // Logs: bounded tail of the detached process's log file, for debugging
  // failed starts (npm install errors, port conflicts, …).
  router.get("/conversations/:id/preview/logs", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const { logFile } = previewRuntimePaths(id);
    try {
      const out = await execBash(`tail -n ${PREVIEW_LOG_TAIL_LINES} ${shellQuote(logFile)} 2>/dev/null || true`);
      res.json({ log: stripAnsi(out.stdout), logFile });
    } catch (err) {
      upstreamError(res, err, "preview logs");
    }
  });

  // Explicit registration for a manually-started server: persists the
  // conversation → port mapping (portfile) that the stable /preview/app route
  // resolves. The port is validated exactly like the :port proxy segment.
  router.put("/conversations/:id/preview/target", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const port = parsePreviewPort(String(req.body?.port ?? ""));
    if (port === null) {
      res.status(400).json({ error: `port must be an integer in ${PREVIEW_PORT_MIN}–${PREVIEW_PORT_MAX} (and not the agent-server port)` });
      return;
    }
    const { portFile } = previewRuntimePaths(id);
    try {
      const out = await execBash(`echo ${port} > ${shellQuote(portFile)}`);
      if (out.exitCode !== 0) {
        res.status(502).json({ error: "Failed to persist the preview target" });
        return;
      }
      rememberPreviewPort(id, port);
      previewStateCache.delete(id);
      res.json({ port, previewBase: previewAppBase(id) });
    } catch (err) {
      upstreamError(res, err, "register preview target");
    }
  });

  /**
   * Shared reverse-proxy body for both preview routes. Forwards a minimal,
   * safe request — never the hub session cookie or the agent-server key; the
   * preview port needs no auth (reaching it already required passing the hub
   * gate). PATH-PRESERVING: the app sees the full hub path, so it must be
   * served under `mount` (`{previewBase}` in the run-command hints) — its
   * base-prefixed asset URLs then route back through this proxy, while its
   * root-absolute /api calls intentionally escape to the hub origin and hit
   * the real backend with the viewer's session (see the Phase 2 design doc).
   */
  async function proxyPreview(req: Request, res: Response, port: number, mount: string): Promise<void> {
    const target = previewTargetUrl(cfg, port, req.originalUrl);
    if (!target) {
      res.status(503).json({ error: "Live preview is not configured on this deployment" });
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of PREVIEW_FORWARD_REQUEST_HEADERS) {
      const value = req.get(name);
      if (value) headers[name] = value;
    }
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    try {
      const upstreamRes = await fetch(target, {
        method,
        headers,
        body: hasBody ? (req as unknown as ReadableStream) : undefined,
        // Node fetch needs this when streaming a request body.
        ...(hasBody ? { duplex: "half" } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      } as RequestInit);
      // Pass through status and a safe subset of response headers. A same-host
      // relative redirect is rewritten under the proxy mount so navigation stays
      // inside the panel; anything else is surfaced as-is (no auto-follow).
      res.status(upstreamRes.status);
      for (const name of PREVIEW_FORWARD_RESPONSE_HEADERS) {
        const value = upstreamRes.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      // A base-aware app redirects inside its base (already mount-prefixed —
      // pass through); a root-absolute redirect from a non-base app is pulled
      // under the mount so navigation stays inside the panel.
      const location = upstreamRes.headers.get("location");
      if (location && location.startsWith("/")) {
        res.setHeader("location", location.startsWith(`${mount}/`) || location === mount ? location : `${mount}${location}`);
      }
      const buffer = upstreamRes.body ? await readCapped(upstreamRes, PREVIEW_MAX_RESPONSE_BYTES) : null;
      if (buffer === "too-large") {
        res.status(502).json({ error: "Preview response exceeded the size limit" });
        return;
      }
      res.end(buffer ? Buffer.from(buffer) : undefined);
    } catch (err) {
      logger.warn({ err, port }, "OpenHands BFF preview proxy failed");
      res.status(502).json({ error: "Preview target is not reachable — is the dev server running and bound to 0.0.0.0?" });
    }
  }

  // Stable path-based preview route (Phase 2): `app` is a fixed literal (never
  // a valid numeric port, so it cannot collide with the :port route below —
  // and this route is registered first anyway). The port comes from the
  // persisted conversation → port registration written by preview/start or
  // PUT preview/target; unregistered conversations get a clear 404 instead of
  // a confusing proxy error. Same fixed-host / validated-port security posture
  // as the :port route.
  router.all("/conversations/:id/preview/app{/*rest}", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    let port: number | null;
    try {
      port = await registeredPreviewPort(id);
    } catch (err) {
      upstreamError(res, err, "resolve preview target");
      return;
    }
    if (port === null) {
      res.status(404).json({ error: "No preview target is registered for this conversation — press Start in the preview panel (or register a port) first" });
      return;
    }
    await proxyPreview(req, res, port, previewAppBase(id));
  });

  // Reverse-proxy an explicit port (backward-compatible advanced fallback).
  // Registered AFTER the fail-closed gate above, so it inherits the same email
  // allowlist as every other route — there is no unauthenticated tunnel. The
  // target host is fixed by config; only the (validated) port and the path
  // come from the browser, so this cannot be aimed at an arbitrary internal
  // address.
  router.all("/conversations/:id/preview/:port{/*rest}", async (req, res) => {
    const id = validId(req, res);
    if (!id) return;
    const port = parsePreviewPort(req.params.port);
    if (port === null) {
      res.status(400).json({ error: `port must be an integer in ${PREVIEW_PORT_MIN}–${PREVIEW_PORT_MAX} (and not the agent-server port)` });
      return;
    }
    await proxyPreview(req, res, port, `/api/openhands/conversations/${id}/preview/${port}`);
  });

  return router;
}

/**
 * Read an upstream response body with a hard byte cap. Returns the bytes, or
 * the sentinel "too-large" when the cap is exceeded (callers fail closed).
 */
async function readCapped(r: globalThis.Response, maxBytes: number): Promise<Uint8Array | "too-large" | null> {
  const reader = r.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function setup(deps: ServerAppDeps): Promise<ServerAppResult> {
  const cfg = readConfigFromEnv();
  const runtime = { managerEnabled: false };
  const router = await createOpenHandsRouter(cfg, runtime);
  const configured = Boolean(cfg.internalUrl && (cfg.apiKey || cfg.apiKeyFile));
  // A dev deployment hard-kills in-flight agent loops; the watcher resumes
  // the interrupted conversations once the new agent-server is up (#244).
  let autoResumer: AutoResumer | null = null;
  if (configured && cfg.autoResume) {
    autoResumer = createAutoResumer({ upstream: createUpstream(cfg) });
    autoResumer.start();
  }

  // ntfy push notifications. The watcher always runs when the agent-server is
  // configured — whether messages are actually sent is decided per cycle from
  // env + runtime settings (the Notifications page can set the topic later
  // without a restart).
  let notifier: Notifier | null = null;
  if (configured) {
    notifier = createNtfyNotifier({
      upstream: createUpstream(cfg),
      env: {
        url: cfg.ntfyUrl,
        topic: cfg.ntfyTopic,
        token: cfg.ntfyToken,
        notifyIdle: cfg.notifyIdle,
        hubPublicUrl: cfg.hubPublicUrl,
      },
    });
    notifier.start();
  }

  // Manager/worker parallel runs — needs the app database. Mounted BEFORE the
  // BFF path so /api/openhands/manager/* matches its own router (with its own
  // fail-closed gate) instead of falling through the BFF's middleware.
  const routes: ServerAppResult["routes"] = [];
  let managerShutdown: (() => void) | undefined;
  if (deps.db) {
    try {
      const { setupManagerFeature } = await import("./manager/routes.js");
      const manager = await setupManagerFeature({ cfg, db: deps.db });
      routes.push({ path: "/api/openhands/manager", router: manager.router });
      runtime.managerEnabled = true;
      managerShutdown = manager.shutdown;
      logger.info("OpenHands manager runs mounted");
    } catch (err) {
      logger.error({ err }, "OpenHands manager runs failed to mount");
    }
  } else {
    logger.warn("OpenHands manager runs disabled: no app database available");
  }
  routes.push({ path: "/api/openhands", router });

  logger.info(
    {
      configured,
      keySource: cfg.apiKey ? "env" : cfg.apiKeyFile ? "file" : "none",
      allowlisted: cfg.allowedEmails.length,
      autoResume: Boolean(autoResumer),
    },
    "OpenHands BFF mounted",
  );
  return {
    routes,
    shutdown: () => {
      autoResumer?.stop();
      notifier?.stop();
      managerShutdown?.();
    },
  };
}
