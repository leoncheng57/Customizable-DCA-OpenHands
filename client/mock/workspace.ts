// client/mock/workspace.ts
//
// OWNER: the workspace group — files, git, terminal, disk, live preview.
// Read ./types.ts first: it is the contract.
//
// Endpoints this group owns:
//
//   GET /files/tree                       → WorkspaceTree            (query: path?, page_id?, conversation?)
//   GET /files/content                    → WorkspaceFileContent     (query: path, conversation?)
//   GET /git/repos                        → { items: WorkspaceRepo[] }   (query: conversation?)
//   GET /git/changes                      → GitChange[]              (query: repo, ref?)
//   GET /git/commits                      → { commits: GitCommit[]; has_more: boolean }  (query: repo)
//   GET /git/commits/:sha/changes         → GitChange[]              (query: repo)
//   GET /git/diff                         → GitDiff                  (query: path, ref?, commit?)
//   GET /terminal/commands                → { items: TerminalCommand[]; next_page_id: string | null }
//   GET /terminal/commands/:id/output     → { items: TerminalOutput[]; next_page_id: string | null; truncated: boolean }
//   GET /disk                             → DiskUsage
//
// …and the ENTIRE preview surface, including the routes that sit under a
// conversation path. ./conversations.ts deliberately does not claim these:
//
//   GET /preview/config                          → PreviewConfig
//   GET /conversations/:id/preview/status        → PreviewStatus
//   POST /conversations/:id/preview/start        → 503 (see below)
//   POST /conversations/:id/preview/stop         → { stopped: boolean }
//   GET /conversations/:id/preview/logs          → PreviewLogs
//   PUT /conversations/:id/preview/target        → 503 (see below)
//
// ─── The data ────────────────────────────────────────────────────────────────
//
// One invented project, one work session, three fixtures that agree with each
// other. See ./fixtures/workspace-project.ts for the whole story; in short,
// `parcel-router` is mid-change ("stop over-assigning parcels to depots that
// are already at capacity") and the file tree, the working-tree diff, the
// commit log and the bash history all describe that same change.
//
// The tree is DERIVED from the file map, and the working-tree diffs reuse the
// exact strings `GET /files/content` serves, so the three pages cannot drift
// apart: there is only one copy of each file.
//
// ─── Pagination ──────────────────────────────────────────────────────────────
//
// Three endpoints paginate, and all three are paged the way the real BFF pages
// them (opaque `page_id`, `nextPageId`/`next_page_id` null at the end):
//
//   /files/tree            directories only, first page also carries the files
//                          (`Files.tsx` appends only `dirs` on "Load more")
//   /git/commits           `has_more` on the first page, `page_id` for the rest
//   /terminal/commands     honours `limit`, capped like the real server
//
// ─── Why the preview is stopped ──────────────────────────────────────────────
//
// The real preview is an Express reverse proxy into a workspace pod running a
// dev server. On static hosting there is no pod, no proxy and no dev server,
// and there is no honest way to fake one — so `status` reports "stopped" (the
// one PreviewStatusKind whose PreviewPanel branch is an explanation rather
// than an error: "exited" and "workspace-missing" both render red failure
// copy about a crash that never happened) and `start` fails with a message
// that says why. Nothing here ever hands back a URL, so the iframe stays
// unmounted and the panel keeps showing its informative empty state.
import { isoAgo } from "./clock.js";
import {
  REPO_FIXTURES,
  PRIMARY_REPO,
  commitSummary,
  findRepo,
  type CommitFixture,
  type FileRevision,
  type RepoFixture,
} from "./fixtures/git-history.js";
import {
  TERMINAL_COMMANDS,
  chunkTimestamp,
  commandTimestamp,
  findCommand,
  type CommandFixture,
} from "./fixtures/workspace-terminal.js";
import {
  WORKSPACE_ROOT,
  basename,
  isDirectory,
  listDirectory,
  readFile,
} from "./fixtures/workspace-project.js";
import { MockHttpError, type HandlerGroup, type MockRequest } from "./types.js";
import type {
  DiskUsage,
  GitChange,
  GitCommit,
  GitDiff,
  PreviewConfig,
  PreviewLogs,
  PreviewStatus,
  TerminalCommand,
  TerminalOutput,
  WorkspaceFileContent,
  WorkspaceRepo,
  WorkspaceTree,
} from "../lib/api.js";

// ─── Paging helpers ──────────────────────────────────────────────────────────

/** Directories per `/files/tree` page. Small on purpose: `src/` has six. */
const TREE_PAGE_SIZE = 4;
/** Commits per `/git/commits` page — the real BFF asks upstream for 20. */
const COMMITS_PAGE_SIZE = 10;
/** Server-side cap on `/terminal/commands`, mirroring TERMINAL_MAX_LIMIT. */
const TERMINAL_MAX_LIMIT = 12;
const TERMINAL_DEFAULT_LIMIT = 12;
/** Output chunks per `/terminal/commands/:id/output` page. */
const OUTPUT_MAX_LIMIT = 100;

/**
 * Page ids are opaque to the client, so an offset is enough — but it still has
 * to survive the real endpoints' `^[\w.-]{1,256}$` / `^[\w-]+$` validation, so
 * it is a prefixed integer rather than a cursor object.
 */
function pageId(prefix: string, offset: number): string {
  return `${prefix}${offset}`;
}

function parsePageId(prefix: string, raw: string | null): number {
  if (raw === null || raw === "") return 0;
  if (!raw.startsWith(prefix)) throw new MockHttpError(400, "Invalid page_id");
  const offset = Number(raw.slice(prefix.length));
  if (!Number.isInteger(offset) || offset < 0) throw new MockHttpError(400, "Invalid page_id");
  return offset;
}

function positiveInt(raw: string | null, fallback: number, label: string): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new MockHttpError(400, `${label} must be a positive integer`);
  }
  return Number(raw);
}

/** One page of a list, plus the id of the next one (null when exhausted). */
function paginate<T>(items: readonly T[], offset: number, size: number, prefix: string) {
  const slice = items.slice(offset, offset + size);
  const next = offset + size < items.length ? pageId(prefix, offset + size) : null;
  return { slice, next };
}

// ─── Scope resolution ────────────────────────────────────────────────────────

/**
 * The root a request browses under. Unscoped requests get the whole shared
 * volume; a conversation-scoped one gets the checkout the demo's work session
 * happens in, whichever conversation id the sidebar passes — the conversation
 * fixtures are owned by another group, so there is no id map to consult and
 * pointing every scoped panel at the interesting repo beats an empty tree.
 */
function scopeRoot(req: MockRequest): string {
  return req.query.get("conversation") ? PRIMARY_REPO.path : WORKSPACE_ROOT;
}

/** Reject anything outside the scope, exactly as the real path guard does. */
function resolvePath(raw: string | null, root: string): string {
  if (raw === null || raw === "") return root;
  const path = raw.endsWith("/") && raw.length > 1 ? raw.slice(0, -1) : raw;
  if (path.includes("..") || (path !== root && !path.startsWith(`${root}/`))) {
    throw new MockHttpError(400, `path must be inside ${root}`);
  }
  return path;
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function requireRepo(req: MockRequest): RepoFixture {
  const raw = req.query.get("repo");
  if (raw === null || raw === "") throw new MockHttpError(400, "repo is required");
  const repo = findRepo(raw);
  if (repo === undefined) throw new MockHttpError(404, `No git repository at ${raw}`);
  return repo;
}

/** `GitChange` is repo-relative; the fixtures store absolute paths. */
function toChange(repo: RepoFixture, revision: FileRevision): GitChange {
  return { status: revision.status, path: revision.path.slice(repo.path.length + 1) };
}

function findCommit(repo: RepoFixture, sha: string): CommitFixture {
  const commit = repo.commits.find((item) => item.sha === sha || item.sha.startsWith(sha));
  if (commit === undefined) throw new MockHttpError(404, `Commit ${sha} not found`);
  return commit;
}

/**
 * `Changes.tsx` asks for `<repoPath>/<relative>`, so the diff lookup is by
 * absolute path across every repo — there is no `repo` query parameter here.
 */
function findRevision(path: string, commitSha: string | null): FileRevision {
  for (const repo of REPO_FIXTURES) {
    if (path !== repo.path && !path.startsWith(`${repo.path}/`)) continue;
    if (commitSha === null) {
      const change = repo.changes.find((item) => item.path === path);
      if (change !== undefined) return change;
      // A clean file has no diff — the same "No textual changes." the real
      // endpoint produces when HEAD and the working tree agree.
      const content = readFile(path);
      if (content !== null) return { status: "UPDATED", path, original: content, modified: content };
      throw new MockHttpError(404, `${path} is not in the working tree`);
    }
    const commit = repo.commits.find((item) => item.sha === commitSha || item.sha.startsWith(commitSha));
    if (commit === undefined) continue;
    const change = commit.changes.find((item) => item.path === path);
    if (change !== undefined) return change;
    throw new MockHttpError(404, `${basename(path)} was not touched by ${commitSha.slice(0, 7)}`);
  }
  throw new MockHttpError(404, `No git repository contains ${path}`);
}

// ─── Terminal helpers ────────────────────────────────────────────────────────

function toTerminalCommand(command: CommandFixture): TerminalCommand {
  return {
    id: command.id,
    command: command.command,
    cwd: command.cwd,
    timestamp: commandTimestamp(command),
    exit_code: command.exitCode,
  };
}

function toTerminalOutputs(command: CommandFixture): TerminalOutput[] {
  return command.chunks.map((chunk, order) => ({
    id: `${command.id}-${order}`,
    command_id: command.id,
    order,
    timestamp: chunkTimestamp(command, order),
    exit_code: chunk.exitCode ?? null,
    stdout: chunk.stdout ?? null,
    stderr: chunk.stderr ?? null,
  }));
}

// ─── Preview helpers ─────────────────────────────────────────────────────────

const PREVIEW_DEFAULT_PORT = 5173;
const PREVIEW_PORT_RANGE = { min: 1024, max: 65_535 };
const PREVIEW_DERIVED_PORT_BASE = 20_000;
const PREVIEW_DERIVED_PORT_SPAN = 10_000;

/** Same FNV-1a derivation the BFF uses, so the displayed port looks stable. */
function derivePreviewPort(id: string): number {
  let hash = 0x811c9dc5;
  const key = id.toLowerCase();
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PREVIEW_DERIVED_PORT_BASE + (hash % PREVIEW_DERIVED_PORT_SPAN);
}

function previewAppBase(id: string): string {
  return `/api/openhands/conversations/${id}/preview/app`;
}

/**
 * The one message every preview mutation fails with. 503 is what the real BFF
 * answers when no preview origin is configured, so it is the faithful status —
 * at the cost of one `console.error` from the registry, which logs every 5xx
 * on the assumption that it means a broken handler. Here it means the opposite:
 * the handler is refusing on purpose, and the logged line says so.
 */
const PREVIEW_UNAVAILABLE =
  "Live preview is unavailable in this simulation: there is no workspace pod to run a dev server in, and no proxy to reach it through. On a real deployment, Start launches the repo's dev server in the session workspace and the preview loads as soon as it answers.";

// ─── Disk ────────────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
// Matches the `df -h` output in the terminal fixture: 64G total, 19G used.
const DISK_TOTAL_BYTES = 64 * GIB;
const DISK_USED_BYTES = 19 * GIB;
const DISK_AVAILABLE_BYTES = 43 * GIB;

export const handlers: HandlerGroup = {
  name: "workspace",
  routes: {
    // ── Files ───────────────────────────────────────────────────────────────
    "GET /files/tree": (req): WorkspaceTree => {
      const root = scopeRoot(req);
      const path = resolvePath(req.query.get("path"), root);
      const listing = listDirectory(path);
      if (listing === null) throw new MockHttpError(404, `${path} is not a directory`);
      const offset = parsePageId("d", req.query.get("page_id"));
      const { slice, next } = paginate(listing.dirs, offset, TREE_PAGE_SIZE, "d");
      return {
        path,
        dirs: slice.map((dir) => ({ name: basename(dir), path: dir })),
        // Files only on the first page: pagination walks the directory list,
        // and repeating the bounded file listing on every page would just
        // duplicate it (this is what the real /files/tree does too).
        files: offset === 0 ? listing.files.map((f) => ({ name: basename(f), path: f })) : [],
        nextPageId: next,
      };
    },

    "GET /files/content": (req): WorkspaceFileContent => {
      const root = scopeRoot(req);
      const raw = req.query.get("path");
      if (raw === null || raw === "") throw new MockHttpError(400, "path is required");
      const path = resolvePath(raw, root);
      if (isDirectory(path)) throw new MockHttpError(400, `path must be a file inside ${root}`);
      const content = readFile(path);
      if (content === null) throw new MockHttpError(404, `${path} does not exist in the workspace`);
      return { path, content };
    },

    // ── Git ─────────────────────────────────────────────────────────────────
    "GET /git/repos": (req): { items: WorkspaceRepo[] } => {
      // A conversation works in one checkout; the unscoped page sees them all.
      const repos = req.query.get("conversation") ? [PRIMARY_REPO] : REPO_FIXTURES;
      return { items: repos.map(({ name, path }) => ({ name, path })) };
    },

    "GET /git/changes": (req): GitChange[] => {
      const repo = requireRepo(req);
      return repo.changes.map((change) => toChange(repo, change));
    },

    "GET /git/commits": (req): { commits: GitCommit[]; has_more: boolean } => {
      const repo = requireRepo(req);
      const offset = parsePageId("c", req.query.get("page_id"));
      const { slice, next } = paginate(repo.commits, offset, COMMITS_PAGE_SIZE, "c");
      return { commits: slice.map(commitSummary), has_more: next !== null };
    },

    "GET /git/commits/:sha/changes": (req): GitChange[] => {
      const repo = requireRepo(req);
      const commit = findCommit(repo, req.params.sha ?? "");
      return commit.changes.map((change) => toChange(repo, change));
    },

    "GET /git/diff": (req): GitDiff => {
      const path = req.query.get("path");
      if (path === null || path === "") throw new MockHttpError(400, "path is required");
      const revision = findRevision(path, req.query.get("commit"));
      return { original: revision.original, modified: revision.modified, truncated: false };
    },

    // ── Terminal ────────────────────────────────────────────────────────────
    "GET /terminal/commands": (req): { items: TerminalCommand[]; next_page_id: string | null } => {
      const limit = Math.min(
        positiveInt(req.query.get("limit"), TERMINAL_DEFAULT_LIMIT, "limit"),
        TERMINAL_MAX_LIMIT,
      );
      const offset = parsePageId("t", req.query.get("page_id"));
      const { slice, next } = paginate(TERMINAL_COMMANDS, offset, limit, "t");
      return { items: slice.map(toTerminalCommand), next_page_id: next };
    },

    "GET /terminal/commands/:id/output": (
      req,
    ): { items: TerminalOutput[]; next_page_id: string | null; truncated: boolean } => {
      const command = findCommand(req.params.id ?? "");
      if (command === undefined) throw new MockHttpError(404, "Command not found");
      const limit = Math.min(positiveInt(req.query.get("limit"), OUTPUT_MAX_LIMIT, "limit"), OUTPUT_MAX_LIMIT);
      const rawOrder = req.query.get("order_gt");
      if (rawOrder !== null && !/^\d+$/.test(rawOrder)) {
        throw new MockHttpError(400, "order_gt must be a non-negative integer");
      }
      // The expanded row re-polls with `order_gt` set to the highest order it
      // has already rendered, so this must return the TAIL, not a fresh page.
      const orderGt = rawOrder === null ? null : Number(rawOrder);
      const all = toTerminalOutputs(command);
      const fresh = orderGt === null ? all : all.filter((item) => (item.order ?? -1) > orderGt);
      const offset = parsePageId("o", req.query.get("page_id"));
      const { slice, next } = paginate(fresh, offset, limit, "o");
      // Every fixture output is a few hundred bytes; nothing ever hits the
      // 256 KB budget, so claiming otherwise would put a false "Output was
      // truncated" note under the transcript.
      return { items: slice, next_page_id: next, truncated: false };
    },

    // ── Disk ────────────────────────────────────────────────────────────────
    "GET /disk": (): DiskUsage => ({
      workspaceRoot: WORKSPACE_ROOT,
      totalBytes: DISK_TOTAL_BYTES,
      usedBytes: DISK_USED_BYTES,
      availableBytes: DISK_AVAILABLE_BYTES,
      usedPercent: Math.round((DISK_USED_BYTES / (DISK_USED_BYTES + DISK_AVAILABLE_BYTES)) * 100),
      // The real probe is cached for a minute; keep the reading recent so the
      // bar never looks like a stale snapshot.
      checkedAt: isoAgo(24_000),
    }),

    // ── Preview ─────────────────────────────────────────────────────────────
    "GET /preview/config": (): PreviewConfig => ({
      // The panel gates Start/Stop/Reload on this flag, and a disabled panel
      // can only offer copy about an environment variable that cannot be set
      // on static hosting. Leaving the controls live means the honest
      // explanation is one click away — see PREVIEW_UNAVAILABLE below.
      enabled: true,
      defaultPort: PREVIEW_DEFAULT_PORT,
      portRange: PREVIEW_PORT_RANGE,
      repos: [
        {
          match: "depot-console",
          label: "Depot console (vite dev server)",
          port: PREVIEW_DEFAULT_PORT,
          runCommand:
            "npm install && VITE_BASE_PATH={previewBase} VITE_ALLOWED_HOSTS=all npm run dev -- --port {previewPort} --strictPort",
        },
      ],
    }),

    "GET /conversations/:id/preview/status": (req): PreviewStatus => {
      const id = req.params.id ?? "";
      return {
        status: "stopped",
        port: derivePreviewPort(id),
        previewBase: previewAppBase(id),
        registered: false,
      };
    },

    "POST /conversations/:id/preview/start": () => {
      throw new MockHttpError(503, PREVIEW_UNAVAILABLE);
    },

    // Stopping something that was never started is a no-op the real endpoint
    // also reports as success, and it leaves the panel exactly where it was.
    "POST /conversations/:id/preview/stop": (): { stopped: boolean } => ({ stopped: true }),

    "GET /conversations/:id/preview/logs": (req): PreviewLogs => {
      const id = req.params.id ?? "";
      return {
        log: [
          "No dev server has been started for this conversation.",
          "",
          "This is the demo build: the live preview is a reverse proxy into the",
          "workspace pod that runs the app, and there is no pod behind a static",
          "site. On a real deployment this file is the tail of the detached dev",
          "server's output — npm install progress, the vite ready line, port",
          "conflicts — which is what makes it the first place to look when a",
          "preview refuses to come up.",
        ].join("\n"),
        logFile: `/tmp/preview-${id.toLowerCase()}.log`,
      };
    },

    "PUT /conversations/:id/preview/target": () => {
      throw new MockHttpError(503, PREVIEW_UNAVAILABLE);
    },
  },
};
