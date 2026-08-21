# Folder structure

Annotated tree — every directory, what belongs in it, and where new code goes.

```text
.
├── CONTRIBUTING.md          ← contributor entry point (rendered in-app too)
├── AGENTS.md                ← terse agent-facing memory (repo skill); long-form: docs/agent-sessions.md
├── README.md                ← user-facing quickstart
├── docs/                    ← ALL long-form docs (markdown = single source of truth,
│                              rendered in-app at /openhands/contributing/<slug>)
│
├── server/                  ── Express BFF ──────────────────────────────────
│   ├── index.ts             ← entry point: middleware order, pg wiring, mounting, SPA fallback
│   ├── auth.ts              ← oauth2-proxy-header auth, dev@local default   🔴 security
│   ├── app-types.ts         ← ServerAppDeps/Result mount contract
│   ├── db.ts                ← pg pool wrapper (search_path)
│   ├── logger.ts            ← pino (pretty in dev)
│   ├── github.ts / gitlab.ts← thin REST clients (plain fetch + tokens)
│   └── openhands/           ── the app proper ──
│       ├── setup.ts         ← ~2800-line main router: conversations, SSE, files, diffs,
│       │                      terminal audit, preview proxy, config. Most changes land here.
│       ├── upstream.ts      ← authenticated fetch to agent-server           🔴 security
│       ├── autoResume.ts    ← re-attach conversations after BFF restart
│       ├── terminal.ts      ← bash-event sanitizing for the read-only terminal
│       ├── mr.ts            ← GitLab MR panel shaping
│       ├── repo-infer.ts    ← repo inference from prompts/URLs
│       ├── notifier.ts      ← ntfy push channel
│       ├── images.ts        ← image validation (shared client+server — magic bytes, limits)
│       └── manager/         ← parallel-worker orchestration (Postgres-backed)
│           ├── routes.ts    ← /api/openhands/manager router (own allowlist gate)
│           ├── store.ts     ← runs/workers/activity tables, idempotent DDL
│           ├── monitor.ts   ← polling state machine                         🟠 cost
│           ├── executor.ts  ← starts/steers worker conversations            🟠 cost
│           ├── agent-client.ts / contracts.ts / types.ts
│
├── client/                  ── React SPA (Vite root) ───────────────────────
│   ├── main.tsx             ← shell: router, nav, theme, lazy page imports.
│   │                          New page? Add lazy import + NAV entry + <Route> here.
│   ├── index.html / styles.css / theme/  ← Tailwind v4 + local design tokens
│   ├── pages/               ← one file per routed page
│   ├── components/          ← shared conversation-UI pieces (panels, sidebars, strips)
│   ├── ds/                  ← vendored design system (button, card, badge, table,
│   │                          alert, markdown, loading, command-palette)
│   │                          — see docs/design-system.md
│   └── lib/                 ← api clients, SSE/event helpers, notify, time, diff,
│                              command-palette model + matcher (palette.ts)
│
├── tests/
│   ├── *.test.ts            ← vitest unit tests (run: npm test)
│   └── e2e/                 ← Playwright smoke suite, no LLM (run: npm run test:e2e)
│
├── scripts/
│   ├── dev.sh               ← one-command dev: compose up + agent CLIs + tsx watch + vite
│   ├── openhands-askpass.sh ← git credential helper inside the container    🔴 security
│   ├── sync-mcp.sh          ← push mcp-servers.json into agent settings
│   ├── sync-agent-settings.sh  ← dev.sh wrapper around the settings seed
│   └── seed-agent-settings.mjs ← agent profile defaults (condenser, llm.stream,
│                              slack-mcp off) — shared with the packaged entrypoint
│
├── deploy/                  ── the single-click package (docs/packaging.md) ──
│   ├── compose.yaml         ← packaged stack: app + agent (+ postgres profile)
│   ├── env.example          ← template for the user's ~/openhands-app/.env
│   ├── install.sh           ← the single click; also the updater             🔴 security
│   └── app-entrypoint.sh    ← seeds agent settings, then execs the server
├── Dockerfile / .dockerignore  ← app image built + pushed by release.yml
│
├── docker-compose.yml       ← agent-canvas (pinned 1.12.0) + postgres profile
├── .env / .env.example      ← all configuration (12-factor style, no config files)
├── .state/                  ← gitignored bind mount of the container's ~/.openhands
│                              (agent API key lives here)                    🔴 secret
├── mcp-servers.json         ← gitignored MCP config (see example file)
│
├── vite.config.ts           ← base-path override for in-session dev, /api proxy + preview bypass
├── tsconfig.json            ← client typecheck; tsconfig.server.json ← server build
├── vitest.config.ts / playwright.config.ts
└── .github/
    ├── risk-map.yml         ← machine-readable risk dimensions (docs/risk-map.md)
    └── workflows/           ← CI (see docs/cicd.md)
```

## Where does my change go?

| I want to… | Touch |
|---|---|
| Add a UI page | `client/pages/Foo.tsx` + 3 lines in `client/main.tsx` (lazy import, NAV, Route) |
| Add a BFF endpoint | `server/openhands/setup.ts` (or a new module it imports) |
| Add a doc | `docs/foo.md` + registry entry in `client/lib/docs.ts` |
| Add a shared UI primitive | `client/ds/` (keep it dependency-free) |
| Change agent container setup | `docker-compose.yml` + `scripts/dev.sh` |
| Change how the app installs/releases | `deploy/` + `Dockerfile` + `.github/workflows/release.yml` — see [packaging.md](packaging.md) |
| Add config | `.env.example` (documented!) + read it in `setup.ts`'s `readConfigFromEnv()` |
| Give the agent a new tool | see [adding-tools.md](adding-tools.md) |

## Conventions

- **Flat until it hurts**: `server/openhands/` gained `manager/` only when it was 7 files.
  Don't pre-create directories for single files.
- **`.js` extensions in imports** (ESM, `"type": "module"`): `import … from "./utils.js"`
  even though the file is `.ts`.
- **Shared client+server code** must live under `server/openhands/` (e.g. `images.ts`) —
  `vite.config.ts` allowlists that directory for the dev server (`server.fs.allow`).
