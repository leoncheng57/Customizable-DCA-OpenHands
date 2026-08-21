// Contract tests for the demo backend's workspace group (client/mock/workspace.ts).
//
// The demo has no server, so nothing else can tell us that the Files, Changes
// and Terminal pages will actually render something. These tests stand in for
// that: they drive the handlers through the REAL registry (so a mistyped route
// key fails the build rather than showing up as an empty page), walk every
// paginated endpoint to exhaustion, and push a diff fixture through the REAL
// `buildDiff` the Changes page uses.
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { buildDiff } from "../client/lib/diff.js";
import { dispatch, matchRoute, registerGroup, resetRegistry } from "../client/mock/registry.js";
import { handlers as workspace } from "../client/mock/workspace.js";
import { REPO_FIXTURES } from "../client/mock/fixtures/git-history.js";
import {
  WORKSPACE_FILES,
  WORKSPACE_ROOT,
  listDirectory,
} from "../client/mock/fixtures/workspace-project.js";
import { TERMINAL_COMMANDS } from "../client/mock/fixtures/workspace-terminal.js";
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
} from "../client/lib/api.js";

const ORIGIN = "https://example.test";
const CONVERSATION = "3f9b1c40-27ad-4e15-9c82-6b0d5a7e1348";

interface Called {
  status: number;
  body: unknown;
}

/** Drive one request through the registry exactly as the fetch patch does. */
async function call(method: string, pathAndQuery: string): Promise<Called> {
  const url = new URL(`/api/openhands${pathAndQuery}`, ORIGIN);
  const result = await dispatch({
    method,
    path: url.pathname.replace("/api/openhands", ""),
    params: {},
    query: url.searchParams,
    body: undefined,
    headers: new Headers(),
    url,
  });
  expect(result.unhandled, `${method} ${pathAndQuery} was not claimed by any group`).toBe(false);
  return { status: result.status, body: JSON.parse(result.text) as unknown };
}

/** `call`, asserting a 2xx and narrowing the body. */
async function ok<T>(method: string, pathAndQuery: string): Promise<T> {
  const result = await call(method, pathAndQuery);
  expect(result.status, `${method} ${pathAndQuery} → ${JSON.stringify(result.body)}`).toBe(200);
  return result.body as T;
}

beforeAll(() => {
  resetRegistry();
  registerGroup(workspace);
});

afterAll(() => resetRegistry());

// ─────────────────────────────────────────────────────────────────────────────

describe("route coverage", () => {
  // Every endpoint listed in the group's header comment. A gap here is a page
  // that renders an error in the published demo, so the list is spelled out
  // rather than derived from the implementation.
  const OWNED: Array<[string, string]> = [
    ["GET", "/files/tree"],
    ["GET", "/files/content"],
    ["GET", "/git/repos"],
    ["GET", "/git/changes"],
    ["GET", "/git/commits"],
    ["GET", "/git/commits/deadbee/changes"],
    ["GET", "/git/diff"],
    ["GET", "/terminal/commands"],
    ["GET", "/terminal/commands/abc123/output"],
    ["GET", "/disk"],
    ["GET", "/preview/config"],
    ["GET", `/conversations/${CONVERSATION}/preview/status`],
    ["POST", `/conversations/${CONVERSATION}/preview/start`],
    ["POST", `/conversations/${CONVERSATION}/preview/stop`],
    ["GET", `/conversations/${CONVERSATION}/preview/logs`],
    ["PUT", `/conversations/${CONVERSATION}/preview/target`],
  ];

  it.each(OWNED)("%s %s resolves to the workspace group", (method, path) => {
    const match = matchRoute(method, path);
    expect(match, `no handler claims ${method} ${path}`).not.toBeNull();
    expect(match?.group).toBe("workspace");
  });

  it("claims no conversation route other than the preview surface", () => {
    // The conversations group owns everything else under /conversations/*;
    // grabbing one of its keys here would be a registry collision at install
    // time, which is much harder to debug than this assertion.
    const strays = Object.keys(workspace.routes).filter(
      (key) => key.includes("/conversations/") && !key.includes("/preview/"),
    );
    expect(strays).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /files/tree", () => {
  it("defaults to the shared workspace root", async () => {
    const tree = await ok<WorkspaceTree>("GET", "/files/tree");
    expect(tree.path).toBe(WORKSPACE_ROOT);
    expect(tree.dirs.map((d) => d.name)).toEqual(["local", "sessions"]);
    expect(tree.nextPageId).toBeNull();
  });

  it("scopes to the conversation's checkout when asked", async () => {
    const tree = await ok<WorkspaceTree>(
      "GET",
      `/files/tree?conversation=${encodeURIComponent(CONVERSATION)}`,
    );
    // Files.tsx learns the scope root from this response, so it must be the
    // repo itself and not the shared volume.
    expect(tree.path.startsWith(`${WORKSPACE_ROOT}/`)).toBe(true);
    expect(tree.path).not.toBe(WORKSPACE_ROOT);
    expect(tree.dirs.length).toBeGreaterThan(0);
  });

  it("lists a deep directory with its files", async () => {
    const path = `${WORKSPACE_ROOT}/local/parcel-router/src/routing/strategies`;
    const tree = await ok<WorkspaceTree>("GET", `/files/tree?path=${encodeURIComponent(path)}`);
    expect(tree.dirs).toEqual([]);
    expect(tree.files.map((f) => f.name)).toEqual([
      "nearest-depot.ts",
      "round-robin.ts",
      "weighted-depot.ts",
    ]);
  });

  it("pages directories into disjoint, ordered pages that terminate", async () => {
    const path = `${WORKSPACE_ROOT}/local/parcel-router/src`;
    const expected = listDirectory(path)?.dirs.map((dir) => dir) ?? [];
    expect(expected.length, "src/ needs enough subdirectories to paginate").toBeGreaterThan(4);

    const seen: string[] = [];
    let pageId: string | null = null;
    let pages = 0;
    do {
      const query = pageId === null ? "" : `&page_id=${encodeURIComponent(pageId)}`;
      const page: WorkspaceTree = await ok<WorkspaceTree>(
        "GET",
        `/files/tree?path=${encodeURIComponent(path)}${query}`,
      );
      // Files.tsx appends only `dirs` on "Load more", and only the first page
      // carries files — otherwise the file list would be duplicated.
      if (pageId !== null) expect(page.files).toEqual([]);
      for (const dir of page.dirs) {
        expect(seen, "pages must be disjoint").not.toContain(dir.path);
        seen.push(dir.path);
      }
      pageId = page.nextPageId;
      pages += 1;
      expect(pages, "pagination must terminate").toBeLessThan(20);
    } while (pageId !== null);

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(expected);
  });

  it("rejects a path outside the scope", async () => {
    const escaped = await call("GET", "/files/tree?path=%2Fetc");
    expect(escaped.status).toBe(400);
    const traversal = await call(
      "GET",
      `/files/tree?path=${encodeURIComponent(`${WORKSPACE_ROOT}/../etc`)}`,
    );
    expect(traversal.status).toBe(400);
  });
});

describe("GET /files/content", () => {
  it("serves every file the tree advertises", async () => {
    // Walk the whole derived tree and open each file: this is the assertion
    // that the tree can never point at something unreadable.
    const queue = [WORKSPACE_ROOT];
    let files = 0;
    while (queue.length > 0) {
      const dir = queue.pop() as string;
      const listing = listDirectory(dir);
      expect(listing, `${dir} should be a directory`).not.toBeNull();
      queue.push(...(listing?.dirs ?? []));
      for (const path of listing?.files ?? []) {
        const body = await ok<WorkspaceFileContent>(
          "GET",
          `/files/content?path=${encodeURIComponent(path)}`,
        );
        expect(body.path).toBe(path);
        expect(body.content.length).toBeGreaterThan(0);
        files += 1;
      }
    }
    expect(files).toBe(Object.keys(WORKSPACE_FILES).length);
  });

  it("has one large-ish file to exercise the viewer", () => {
    const longest = Math.max(...Object.values(WORKSPACE_FILES).map((c) => c.split("\n").length));
    expect(longest).toBeGreaterThan(120);
  });

  it("404s on a missing file and 400s on a directory", async () => {
    const missing = await call(
      "GET",
      `/files/content?path=${encodeURIComponent(`${WORKSPACE_ROOT}/local/nope.ts`)}`,
    );
    expect(missing.status).toBe(404);
    const directory = await call(
      "GET",
      `/files/content?path=${encodeURIComponent(`${WORKSPACE_ROOT}/local`)}`,
    );
    expect(directory.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("git", () => {
  it("lists two to three workspace repos", async () => {
    const { items } = await ok<{ items: WorkspaceRepo[] }>("GET", "/git/repos");
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.length).toBeLessThanOrEqual(3);
    for (const repo of items) expect(repo.path.startsWith(`${WORKSPACE_ROOT}/`)).toBe(true);
  });

  it("scopes the repo list to one checkout for a conversation", async () => {
    const { items } = await ok<{ items: WorkspaceRepo[] }>(
      "GET",
      `/git/repos?conversation=${encodeURIComponent(CONVERSATION)}`,
    );
    expect(items).toHaveLength(1);
  });

  it("reports a changed-file list with an addition and a deletion", async () => {
    const repo = REPO_FIXTURES[0];
    const changes = await ok<GitChange[]>(
      "GET",
      `/git/changes?repo=${encodeURIComponent(repo.path)}`,
    );
    expect(changes.length).toBeGreaterThanOrEqual(4);
    const statuses = new Set(changes.map((change) => change.status));
    expect(statuses.has("ADDED")).toBe(true);
    expect(statuses.has("DELETED")).toBe(true);
    expect(statuses.has("UPDATED")).toBe(true);
    // Changes.tsx joins `${repo}/${change.path}` before asking for the diff,
    // so a leading slash here would produce a double slash and a 404.
    for (const change of changes) expect(change.path.startsWith("/")).toBe(false);
  });

  it("404s on an unknown repo and 400s without one", async () => {
    expect((await call("GET", "/git/changes?repo=%2Fnope")).status).toBe(404);
    expect((await call("GET", "/git/changes")).status).toBe(400);
  });

  it("pages commits into disjoint, newest-first pages that terminate", async () => {
    const repo = REPO_FIXTURES[0];
    expect(repo.commits.length, "the main repo needs more than one page").toBeGreaterThan(10);

    const seen: string[] = [];
    let pageId: string | null = null;
    let pages = 0;
    let lastPageHadMore = true;
    do {
      const query = pageId === null ? "" : `&page_id=${encodeURIComponent(pageId)}`;
      const page = await ok<{ commits: GitCommit[]; has_more: boolean }>(
        "GET",
        `/git/commits?repo=${encodeURIComponent(repo.path)}${query}`,
      );
      for (const commit of page.commits) {
        expect(seen, "pages must be disjoint").not.toContain(commit.sha);
        expect(commit.short_sha).toBe(commit.sha.slice(0, 7));
        seen.push(commit.sha);
      }
      lastPageHadMore = page.has_more;
      pageId = page.has_more ? `c${seen.length}` : null;
      pages += 1;
      expect(pages, "pagination must terminate").toBeLessThan(20);
    } while (pageId !== null);

    expect(pages).toBeGreaterThan(1);
    expect(lastPageHadMore).toBe(false);
    expect(seen).toEqual(repo.commits.map((commit) => commit.sha));
  });

  it("orders every repo's commits newest first", async () => {
    for (const repo of REPO_FIXTURES) {
      const { commits } = await ok<{ commits: GitCommit[]; has_more: boolean }>(
        "GET",
        `/git/commits?repo=${encodeURIComponent(repo.path)}`,
      );
      const times = commits.map((commit) => Date.parse(commit.timestamp));
      expect(times.every((value) => Number.isFinite(value))).toBe(true);
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      // Relative timestamps only: nothing may be stamped in the future.
      expect(Math.max(...times)).toBeLessThanOrEqual(Date.now());
    }
  });

  it("returns the changed files of a commit", async () => {
    const repo = REPO_FIXTURES[0];
    const commit = repo.commits[0];
    const changes = await ok<GitChange[]>(
      "GET",
      `/git/commits/${commit.sha}/changes?repo=${encodeURIComponent(repo.path)}`,
    );
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].path).toBe(commit.changes[0].path.slice(repo.path.length + 1));
  });

  it("404s on an unknown commit", async () => {
    const repo = REPO_FIXTURES[0];
    const result = await call(
      "GET",
      `/git/commits/0000000/changes?repo=${encodeURIComponent(repo.path)}`,
    );
    expect(result.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** Summarize a rendered diff the way the Changes page groups its lines. */
function summarize(diff: GitDiff) {
  const lines = buildDiff(diff.original, diff.modified);
  return {
    lines,
    hunks: lines.filter((line) => line.kind === "hunk").length,
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    context: lines.filter((line) => line.kind === "context").length,
  };
}

describe("GET /git/diff through the real buildDiff", () => {
  it("renders the headline working-tree change as a compact hunk", async () => {
    const repo = REPO_FIXTURES[0];
    const change = repo.changes[0];
    const diff = await ok<GitDiff>("GET", `/git/diff?path=${encodeURIComponent(change.path)}`);
    expect(diff.original).not.toBeNull();
    expect(diff.modified).not.toBeNull();

    const { lines, hunks, added, removed, context } = summarize(diff);
    expect(hunks).toBe(1);
    expect(lines[0].kind).toBe("hunk");
    expect(lines[0].text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    // Three lines of context each side is what makes it read like a review;
    // zero context means the change swallowed the whole file.
    expect(context).toBeGreaterThanOrEqual(4);
    // A change that spans the file would render as "remove everything, add
    // everything" — the single-hunk renderer cannot show two regions.
    const total = (diff.modified ?? "").split("\n").length;
    expect(added + removed).toBeLessThan(total);

    // Line numbers must be monotonic per side, or the gutter is nonsense.
    const olds = lines.map((line) => line.oldLine).filter((n): n is number => n !== undefined);
    const news = lines.map((line) => line.newLine).filter((n): n is number => n !== undefined);
    expect([...olds].sort((a, b) => a - b)).toEqual(olds);
    expect([...news].sort((a, b) => a - b)).toEqual(news);
  });

  it("produces a non-empty, mostly-context diff for every modified file", async () => {
    for (const repo of REPO_FIXTURES) {
      for (const change of repo.changes) {
        if (change.status !== "UPDATED") continue;
        const diff = await ok<GitDiff>("GET", `/git/diff?path=${encodeURIComponent(change.path)}`);
        const { hunks, added, removed, context } = summarize(diff);
        expect(hunks, `${change.path} should render one hunk`).toBe(1);
        expect(added + removed, `${change.path} must actually differ`).toBeGreaterThan(0);
        expect(context, `${change.path} needs surrounding context`).toBeGreaterThan(0);
      }
    }
  });

  it("returns a one-sided diff for added, untracked and deleted files", async () => {
    const repo = REPO_FIXTURES[0];
    const added = repo.changes.find((change) => change.status === "ADDED");
    const deleted = repo.changes.find((change) => change.status === "DELETED");
    const untracked = repo.changes.find((change) => change.status === "UNTRACKED");
    expect(added && deleted && untracked).toBeTruthy();

    for (const change of [added, untracked]) {
      const diff = await ok<GitDiff>("GET", `/git/diff?path=${encodeURIComponent(change!.path)}`);
      expect(diff.original).toBeNull();
      expect(summarize(diff).added).toBeGreaterThan(0);
      expect(summarize(diff).removed).toBe(0);
    }

    const gone = await ok<GitDiff>("GET", `/git/diff?path=${encodeURIComponent(deleted!.path)}`);
    expect(gone.modified).toBeNull();
    expect(summarize(gone).removed).toBeGreaterThan(0);
  });

  it("renders every commit's diff, so clicking any commit shows something", async () => {
    for (const repo of REPO_FIXTURES) {
      for (const commit of repo.commits) {
        expect(commit.changes.length, `${commit.sha} has no changes`).toBeGreaterThan(0);
        for (const change of commit.changes) {
          const diff = await ok<GitDiff>(
            "GET",
            `/git/diff?path=${encodeURIComponent(change.path)}&commit=${commit.sha}`,
          );
          const { hunks, added, removed } = summarize(diff);
          expect(hunks, `${commit.sha} ${change.path}`).toBe(1);
          expect(added + removed, `${commit.sha} ${change.path} must differ`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("gives a clean file an empty diff instead of an error", async () => {
    const clean = `${WORKSPACE_ROOT}/local/parcel-router/src/telemetry/logger.ts`;
    const diff = await ok<GitDiff>("GET", `/git/diff?path=${encodeURIComponent(clean)}`);
    expect(diff.original).toBe(diff.modified);
    expect(buildDiff(diff.original, diff.modified)).toEqual([]);
  });

  it("400s without a path and 404s outside every repo", async () => {
    expect((await call("GET", "/git/diff")).status).toBe(400);
    expect((await call("GET", "/git/diff?path=%2Fnowhere%2Ffile.ts")).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("terminal", () => {
  it("pages the history into disjoint, newest-first pages that terminate", async () => {
    const seen: string[] = [];
    let pageId: string | null = null;
    let pages = 0;
    do {
      const query = pageId === null ? "" : `&page_id=${encodeURIComponent(pageId)}`;
      const page = await ok<{ items: TerminalCommand[]; next_page_id: string | null }>(
        "GET",
        `/terminal/commands?limit=50${query}`,
      );
      for (const command of page.items) {
        expect(seen, "pages must be disjoint").not.toContain(command.id);
        seen.push(command.id);
      }
      pageId = page.next_page_id;
      pages += 1;
      expect(pages, "pagination must terminate").toBeLessThan(20);
    } while (pageId !== null);

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(TERMINAL_COMMANDS.map((command) => command.id));
  });

  it("describes commands the way the page renders them", async () => {
    const { items } = await ok<{ items: TerminalCommand[] }>("GET", "/terminal/commands?limit=50");
    for (const command of items) {
      expect(command.command.length).toBeGreaterThan(0);
      expect(command.cwd?.startsWith(WORKSPACE_ROOT)).toBe(true);
      expect(Number.isFinite(Date.parse(command.timestamp ?? ""))).toBe(true);
    }
    const times = items.map((command) => Date.parse(command.timestamp ?? ""));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("includes at least one non-zero exit across the history", () => {
    const failures = TERMINAL_COMMANDS.filter((command) => command.exitCode !== 0);
    expect(failures.length).toBeGreaterThan(0);
    // The failing runs must carry their exit code on the last output chunk
    // too — that is what drives the "Exit code: N" line under the transcript.
    for (const command of failures) {
      const last = command.chunks[command.chunks.length - 1];
      expect(last.exitCode).toBe(command.exitCode);
    }
  });

  it("returns output for every command, in order", async () => {
    for (const command of TERMINAL_COMMANDS) {
      const page = await ok<{ items: TerminalOutput[]; next_page_id: string | null; truncated: boolean }>(
        "GET",
        `/terminal/commands/${command.id}/output?limit=100`,
      );
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.truncated).toBe(false);
      expect(page.items.map((item) => item.order)).toEqual(
        page.items.map((_item, index) => index),
      );
      for (const item of page.items) expect(item.command_id).toBe(command.id);
    }
  });

  it("supports the incremental order_gt paging the expanded row polls with", async () => {
    // Pick a command with several chunks: `OutputBlock` re-polls with the
    // highest order it has already rendered and appends only what is newer.
    const chunky = TERMINAL_COMMANDS.find((command) => command.chunks.length > 1);
    expect(chunky, "at least one command should emit multiple chunks").toBeTruthy();

    const first = await ok<{ items: TerminalOutput[] }>(
      "GET",
      `/terminal/commands/${chunky!.id}/output?limit=100`,
    );
    const highest = Math.max(...first.items.map((item) => item.order ?? -1));

    const tail = await ok<{ items: TerminalOutput[] }>(
      "GET",
      `/terminal/commands/${chunky!.id}/output?limit=100&order_gt=${highest}`,
    );
    expect(tail.items).toEqual([]);

    const partial = await ok<{ items: TerminalOutput[] }>(
      "GET",
      `/terminal/commands/${chunky!.id}/output?limit=100&order_gt=0`,
    );
    expect(partial.items.length).toBe(first.items.length - 1);
    expect(partial.items.every((item) => (item.order ?? -1) > 0)).toBe(true);
  });

  it("404s on an unknown command", async () => {
    expect((await call("GET", "/terminal/commands/ffffffff/output")).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /disk", () => {
  it("renders the bar at a non-alarming level", async () => {
    const usage = await ok<DiskUsage>("GET", "/disk");
    expect(usage.workspaceRoot).toBe(WORKSPACE_ROOT);
    expect(usage.usedPercent).toBeGreaterThan(0);
    // DiskUsageBar warns at 75 and goes critical at 90; the demo should sit
    // in the green so the sidebar is not permanently shouting.
    expect(usage.usedPercent).toBeLessThan(75);
    expect(usage.usedBytes).toBeLessThan(usage.totalBytes);
    expect(usage.usedBytes + usage.availableBytes).toBeLessThanOrEqual(usage.totalBytes);
    const checked = Date.parse(usage.checkedAt);
    expect(Number.isFinite(checked)).toBe(true);
    expect(checked).toBeLessThanOrEqual(Date.now());
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("preview", () => {
  it("advertises a repo → run-command hint", async () => {
    const config = await ok<PreviewConfig>("GET", "/preview/config");
    expect(config.repos.length).toBeGreaterThan(0);
    expect(config.portRange.min).toBeLessThan(config.portRange.max);
    const hint = config.repos[0];
    expect(hint.runCommand).toContain("{previewBase}");
    expect(hint.runCommand).toContain("{previewPort}");
  });

  it("reports a non-running status so the iframe never mounts", async () => {
    const status = await ok<PreviewStatus>(
      "GET",
      `/conversations/${CONVERSATION}/preview/status`,
    );
    // PreviewPanel only sets the iframe src on the transition to "running".
    expect(status.status).not.toBe("running");
    expect(status.status).not.toBe("starting");
    // "stopped" is the branch whose empty state explains the feature; the two
    // other non-running kinds render red copy about a failure that never
    // happened.
    expect(status.status).toBe("stopped");
    expect(status.registered).toBe(false);
    expect(status.previewBase).toBe(
      `/api/openhands/conversations/${CONVERSATION}/preview/app`,
    );
    expect(status.port).toBeGreaterThanOrEqual(1024);
    expect(status.port).toBeLessThanOrEqual(65_535);
  });

  it("derives a stable port per conversation", async () => {
    const a = await ok<PreviewStatus>("GET", `/conversations/${CONVERSATION}/preview/status`);
    const b = await ok<PreviewStatus>("GET", `/conversations/${CONVERSATION}/preview/status`);
    const other = await ok<PreviewStatus>("GET", "/conversations/other-demo-id/preview/status");
    expect(a.port).toBe(b.port);
    expect(other.port).not.toBe(a.port);
  });

  it("fails start honestly instead of returning a URL", async () => {
    const result = await call("POST", `/conversations/${CONVERSATION}/preview/start`);
    expect(result.status).toBeGreaterThanOrEqual(400);
    const body = result.body as { error?: string; previewBase?: string; port?: number };
    // json<T>() in lib/api.ts turns `error` into the message the panel shows.
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/simulation/i);
    expect(body.previewBase).toBeUndefined();
    expect(body.port).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//);
  });

  it("refuses to register a manual preview target", async () => {
    const result = await call("PUT", `/conversations/${CONVERSATION}/preview/target`);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((result.body as { error?: string }).error).toMatch(/simulation/i);
  });

  it("accepts stop as a no-op and explains itself in the logs", async () => {
    const stopped = await ok<{ stopped: boolean }>(
      "POST",
      `/conversations/${CONVERSATION}/preview/stop`,
    );
    expect(stopped.stopped).toBe(true);

    const logs = await ok<PreviewLogs>("GET", `/conversations/${CONVERSATION}/preview/logs`);
    expect(logs.log.length).toBeGreaterThan(0);
    expect(logs.logFile).toContain(CONVERSATION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("internal consistency", () => {
  it("keeps every git path inside its repo, and every repo inside the volume", () => {
    for (const repo of REPO_FIXTURES) {
      expect(repo.path.startsWith(`${WORKSPACE_ROOT}/`)).toBe(true);
      const paths = [
        ...repo.changes.map((change) => change.path),
        ...repo.commits.flatMap((commit) => commit.changes.map((change) => change.path)),
      ];
      for (const path of paths) expect(path.startsWith(`${repo.path}/`)).toBe(true);
    }
  });

  it("uses invented 40-hex shas and 32-hex command ids", () => {
    for (const repo of REPO_FIXTURES) {
      for (const commit of repo.commits) expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    for (const command of TERMINAL_COMMANDS) expect(command.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps the working tree and the file map in step", () => {
    for (const repo of REPO_FIXTURES) {
      for (const change of repo.changes) {
        const onDisk = WORKSPACE_FILES[change.path];
        if (change.status === "DELETED") {
          // A deleted file must NOT still be served by /files/content.
          expect(onDisk).toBeUndefined();
          expect(change.modified).toBeNull();
          continue;
        }
        // Everything else must diff against exactly what the Files page shows.
        expect(onDisk, `${change.path} is missing from WORKSPACE_FILES`).toBe(change.modified);
      }
    }
  });

  it("runs every bash command inside a directory the workspace actually has", () => {
    for (const command of TERMINAL_COMMANDS) {
      expect(listDirectory(command.cwd), `${command.cwd} is not a real directory`).not.toBeNull();
    }
  });
});
