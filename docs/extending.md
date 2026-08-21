# Extending — fork this and build your own coding-agent IDE

This repo is not a product; it is a **template with opinions**. It was itself extracted from a
larger platform and rebuilt as a self-contained runner, which means every platform coupling has
already been cut once and replaced with a small, swappable local part. That is exactly what
makes it forkable: copy the repo, keep the core loop, and grow *your* local IDE / desktop
coding agent around it — with only the features you actually want.

## The core loop you're keeping

Everything else is optional. The irreducible core is four pieces:

```text
        ┌────────────────────────────── the core loop ─────────────────────────────┐
        │                                                                          │
        │   client/pages/Conversation.tsx        server/openhands/setup.ts         │
        │   (transcript, steer, follow-ups) ◀──▶ (conversations, SSE, files)       │
        │                                              │                           │
        │                                              ▼                           │
        │                              server/openhands/upstream.ts                │
        │                              (authed fetch, key server-side)             │
        │                                              │                           │
        │                                              ▼                           │
        │                              agent-canvas container (compose)            │
        │                              + a workspace mount                         │
        └──────────────────────────────────────────────────────────────────────────┘

   Strippable, independently:                Swappable, independently:
   · manager runs (manager/, Postgres)       · UI shell & theme (main.tsx, theme/)
   · GitLab MR panel (mr.ts, MrPanel)        · notification channels (notifier.ts, notify.ts)
   · notifications (notifier, watcher)       · git host clients (github.ts / gitlab.ts)
   · terminal audit page                     · auth (auth.ts — header-shape, proxy-ready)
   · live preview proxy                      · models & provider keys (env only)
   · suggested issues / repo-infer           · design system (client/ds/ — 7 small files)
```

A useful mental model: **the BFF is your product, the agent-server is a dependency.** The
OpenHands agent-server API (conversations, events, files) is stable and documented at
[docs.openhands.dev](https://docs.openhands.dev); everything in this repo is UI + policy on
top of it.

## Fork recipes

### 1. Minimal personal runner
Delete `server/openhands/manager/`, `mr.ts`, `repo-infer.ts`, `notifier.ts`, drop the
`manager` compose profile and `pg` dependency, remove the corresponding pages/NAV entries in
`client/main.tsx`. You keep chat, files, diffs, terminal audit, preview — in ~half the code.

### 2. Your own UI identity
Everything visual funnels through three places: `client/theme/` (design tokens),
`client/styles.css` (Tailwind v4 + typography), `client/ds/` (7 primitives). Restyle those
and every page follows. See [design-system.md](design-system.md).

### 3. Different git host / forge
`server/gitlab.ts` and `server/github.ts` are thin fetch wrappers (~10 functions each) — copy
the shape for Gitea/Bitbucket/anything. The clone flow only needs an https URL your
`OPENHANDS_REPO_URL_PATTERN` allows plus a token the askpass helper
(`scripts/openhands-askpass.sh`) can answer with.

### 4. New workspace mode
The two modes (local bind mount, clone-by-URL) are branches in the conversation-create path in
`setup.ts`. A third mode (e.g. "scratch dir", "remote SSH mount") is: a compose mount, a
branch in create, and a UI toggle in the Hub page.

### 5. New agent capabilities
Give the agent CLIs, MCP servers, credentials — without touching app code. That's
[adding-tools.md](adding-tools.md).

### 6. Different models / providers
Env-only: `OPENHANDS_MODELS` allowlist + provider keys. See [llms.md](llms.md).

### 7. Multi-user / hosted
The auth middleware already speaks oauth2-proxy header shapes (`x-forwarded-email`);
front it with a real proxy and set `OPENHANDS_ALLOWED_EMAILS`. Know what you're signing up
for though: the container and git identity are still shared — true multi-tenancy means
per-user containers, which is an architecture change, not a config change.

## Extension seams, precisely

### Add a page

1. `client/pages/Foo.tsx` — export `FooPage`.
2. In `client/main.tsx`: lazy import, `NAV` entry (optional), `<Route path="/openhands/foo" …>`.
3. Doc-style pages: follow `ManagerGuide.tsx`; data pages: follow `Tools.tsx`
   (fetch from `client/lib/api.ts`).

### Add a BFF endpoint

1. In `setup.ts`, add `router.get("/my-endpoint", …)` — you're behind auth automatically.
2. Non-trivial logic goes in a new `server/openhands/my-feature.ts` module (header comment
   explaining *why*, like its neighbors).
3. Client accessor in `client/lib/api.ts`.
4. Check the [risk map](risk-map.md) — new proxy/exec surfaces need a matching entry.

### Add a notification channel

Server-side: follow `notifier.ts` (ntfy) — it subscribes to the same conversation-transition
events. Client-side: `client/lib/notify.ts` + `useNotifyWatcher.ts` (chime, desktop) — prefer
client-side for anything OS-adjacent (decision #10 explains why).

### Add config

Read it in `readConfigFromEnv()` in `setup.ts`, document it in `.env.example` (that file is
the de-facto config reference), never add a config file format.

## Ground rules that keep a fork healthy

- **Local-first stays local-first**: no telemetry, no remote config, credentials only in `.env`
  and `.state/`.
- **The browser never holds a secret** — everything token-shaped stays behind the BFF.
- **Heavy client deps are lazy-loaded per page** (`React.lazy` in `main.tsx`) — the core
  conversation UI must stay light.
- **Write down your decisions** — fork or not, an append-only [decisions.md](decisions.md)
  is the cheapest piece of architecture you'll ever maintain.
- **Update the [risk map](risk-map.md)** when you add surfaces; delete its rows when you strip
  features. An honest map is what lets future-you (or your agent) move fast.
