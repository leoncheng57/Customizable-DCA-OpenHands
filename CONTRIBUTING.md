# Contributing

This repo is a standalone, local-first web app for driving [OpenHands](https://docs.openhands.dev)
coding-agent conversations — and it is deliberately built to be **forked and reshaped**: take it,
strip what you don't need, and grow your own local IDE / desktop coding agent around it
(see [docs/extending.md](docs/extending.md)).

This file is the entry point for anyone (human or agent) changing the code. Detailed guides live
in [`docs/`](docs/) and are also rendered in-app under **Contributing** (`/openhands/contributing`).

## The system in one picture

```text
┌─────────────────────┐      ┌──────────────────────────┐      ┌────────────┐
│  Web app (this repo)│      │ agent-canvas container   │      │ Postgres   │
│  Express BFF + React│─────▶│ (OpenHands agent-server) │      │ (manager   │
│  localhost:5173/3000│ HTTP │ headless, port 8000/8010 │      │  runs only)│
└─────────────────────┘      └──────────────────────────┘      └────────────┘
         │                             │
         │  /preview/<port> proxy      │  workspaces:
         └────────────────────────────▶│   /home/openhands/workspace/local/<dir>     (host bind mount)
                                       │   /home/openhands/workspace/sessions/<uuid> (clone-by-URL)
```

Deeper: [docs/architecture.md](docs/architecture.md).

## Setup

Requirements: Node ≥ 22, Docker.

```bash
npm install
cp .env.example .env       # set ANTHROPIC_API_KEY and OPENHANDS_PROJECTS_DIR
bash scripts/dev.sh        # compose up agent (+ postgres when PGHOST set),
                           # tsx watch (API :3000) + vite (UI :5173)
```

## Checks — run these before every PR

| Command | What | Cost |
|---|---|---|
| `npm run typecheck` | client + server tsconfigs, `--noEmit` | seconds |
| `npm test` | vitest unit suite | seconds |
| `npm run build` | vite build + server tsc — catches prod-only breakage | ~30 s |
| `npm run test:e2e` | Playwright smoke (no LLM; needs the compose stack up) | minutes |
| `npm run screenshots` | UI-evidence shots for the PR (same stack; CI also runs it) — [testing.md](docs/testing.md) | ~1 min |

More detail (including the manual real-LLM recipe): [docs/testing.md](docs/testing.md).

## Before you touch a file: know its blast radius

Every area of the codebase carries a risk profile across four dimensions —
**security**, **stability**, **blast radius**, and **cost** (can a bug burn LLM spend).
The machine-readable source is [`.github/risk-map.yml`](.github/risk-map.yml); the rationale
lives in [docs/risk-map.md](docs/risk-map.md). Rule of thumb:

- 🔴 `server/auth.ts`, `server/openhands/upstream.ts`, the preview proxy — read the risk map first.
- 🟠 `server/openhands/setup.ts` route order, SSE handling, `server/openhands/manager/`.
- 🟢 `client/ds/`, docs, individual pages.

## Conventions

- **Conversational commits/PRs**: conventional-commit-style titles (`feat:`, `fix:`, `docs:`,
  `ci:`) — the history and open PRs all follow it.
- **Decision log**: durable choices go into [docs/decisions.md](docs/decisions.md) as a new
  numbered row — never rewrite old rows.
- **Comments**: only for the non-obvious (invariants, ordering constraints, trade-offs). This
  codebase leans on long-form header comments per module; keep that style.
- **No new runtime deps casually**: the app stays local-first and auditable. Heavy client libs
  must be lazy-loaded (`React.lazy` per page — see `client/main.tsx`).
- **Lockfile hygiene**: `npm install` under a different npm version churns `package-lock.json`
  (`libc` fields); revert no-op drift instead of committing it.
- **Agents contributing to this repo**: `AGENTS.md` is the terse agent-facing memory;
  [docs/agent-sessions.md](docs/agent-sessions.md) is the long-form guide (worktrees, parallel
  test BFF, in-container quirks).

## Guides

| Doc | What's inside |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System topology, conversation lifecycle, BFF ↔ agent-server contract |
| [docs/folder-structure.md](docs/folder-structure.md) | Annotated tree — where things live, where new code goes |
| [docs/reading-paths.md](docs/reading-paths.md) | What an agent or new contributor actually opens, in what order, per task type |
| [docs/risk-map.md](docs/risk-map.md) | Dimensional risk matrix for every area |
| [docs/testing.md](docs/testing.md) | All test tiers, from typecheck to a paid real-LLM run |
| [docs/extending.md](docs/extending.md) | **Fork this and build your own coding-agent IDE** — every seam |
| [docs/design-system.md](docs/design-system.md) | Vendored DS components, theme tokens, Tailwind v4 conventions |
| [docs/cicd.md](docs/cicd.md) | CI/CD pipeline, risk labels per PR |
| [docs/packaging.md](docs/packaging.md) | **Beta** — the single-click package: install, operate, cut and verify a release, and what's still broken |
| [docs/agent-sessions.md](docs/agent-sessions.md) | Self-development: the agent improving this app from inside it |
| [docs/llms.md](docs/llms.md) | Models, keys, allowlist, per-message model switching, spend control |
| [docs/debugging.md](docs/debugging.md) | Logs at every layer + a symptom-indexed debugging playbook |
| [docs/adding-tools.md](docs/adding-tools.md) | Giving the agent new tools: CLIs, MCP servers, credentials |
| [docs/mobile.md](docs/mobile.md) | Phone access over Tailscale: dev/release paths, macOS firewall, HTTPS, PWA |
| [docs/decisions.md](docs/decisions.md) | Append-only decision log |
