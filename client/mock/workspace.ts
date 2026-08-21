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
//   POST /conversations/:id/preview/start        → PreviewStartResult   (body: { repoMatch? })
//   POST /conversations/:id/preview/stop         → { stopped: boolean }
//   GET /conversations/:id/preview/logs          → PreviewLogs
//   PUT /conversations/:id/preview/target        → { port, previewBase } (body: { port })
//   GET /conversations/:id/preview/app/*         → the proxied app itself (see below)
//
// Notes for whoever fills this in:
//  · `/conversations/:id/preview/app/*` is a reverse proxy to a real dev
//    server in production. There is nothing to proxy in a demo, so the honest
//    answer is `PreviewStatus.status: "stopped"` (or "workspace-missing") from
//    the status route, which makes PreviewPanel render its empty state and
//    never mount the iframe. Only claim the `app/*` route if you actually want
//    to serve placeholder HTML — you would need `mockResponse(html, { headers:
//    { "content-type": "text/html" } })`.
//  · `GET /files/tree` is paginated: `nextPageId` null means "that's all".
//    The tree is lazily expanded per directory, keyed by `path`.
//  · `GET /git/diff` returns `{ original, modified }` — either may be null
//    (added / deleted file); the Monaco-less diff view handles both.
//  · Every path in a fixture must be an invented workspace path. See
//    tests/mock-fixtures.test.ts for what the guard rejects.
//  · Timestamps come from ./clock.ts; mutable state goes in ./state.ts under a
//    `workspace:` key prefix.
//
// TODO(agent): implement the routes above.
import type { HandlerGroup } from "./types.js";

export const handlers: HandlerGroup = {
  name: "workspace",
  routes: {},
};
