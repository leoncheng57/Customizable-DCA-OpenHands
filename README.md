# Customizable DCA

A customizable, standalone, local-first web IDE for driving
[OpenHands](https://github.com/OpenHands/OpenHands) coding-agent conversations — a self-contained
runner extracted (with written approval) from an internal developer platform.

MIT-licensed. See [Trademarks](#trademarks).

## What it is

```
┌─────────────────────┐      ┌──────────────────────────┐      ┌────────────┐
│  Web app (this repo)│      │ agent-canvas container   │      │ Postgres   │
│  Express BFF + React│─────▶│ (OpenHands agent-server) │      │ (manager   │
│  localhost:5173/3000│ HTTP │ headless, port 8000      │      │  runs only)│
└─────────────────────┘      └──────────────────────────┘      └────────────┘
         │                             │
         │  /preview/<port> proxy      │  workspaces:
         └────────────────────────────▶│    /home/openhands/workspace/sessions/<uuid>  (git-clone flow)
                                       │    /home/openhands/workspace/local/<dir>      (host bind mount)
```

- **Server**: Express BFF (`server/`) — conversation lifecycle, transcript events, files/diffs/git,
  read-only terminal audit, live preview reverse proxy, manager runs (parallel worker orchestration),
  GitLab MR viewer/merge.
- **Client**: React + Vite + Tailwind v4 (`client/`) — the full "native" conversation UI.
- **Agent**: `ghcr.io/openhands/agent-canvas` run headless via docker compose; the app talks to its
  HTTP API with an auto-generated `X-Session-API-Key`.

## Features

- Chat conversations with transcript, tool chips, lifecycle controls, follow-ups with image paste
- **Plan mode** (like Claude Code's): the agent researches read-only and proposes a plan; write
  actions are held for approval until you approve the plan, which switches the session to Build
- File browser, git changes/diffs, command audit (read-only terminal), disk usage
- Live preview proxy for dev servers the agent starts (`/preview/<port>`)
- **Local folder workspaces**: point a conversation at a directory on your machine
- **GitLab workflow**: clone-by-URL conversations, suggested issues, MR panel with pipelines + merge
- Manager runs: a manager conversation orchestrating parallel worker conversations (Postgres-backed)

## Quickstart (single-click package) — beta

> **Beta.** The package installs and runs, but it is not at parity with the development stack:
> project folder picking and conversation recovery across a restart are known to be broken. Use
> it to try the app out; use the [development quickstart](#quickstart-development) for real work.
> Details: [docs/packaging.md](docs/packaging.md#known-limitations-beta).

Requirements: Docker only. Installs the latest [GitHub Release](../../releases) — the whole
stack (app + agent) runs in docker compose under `~/openhands-app`:

```bash
curl -fsSL https://github.com/leoncheng57/Customizable-DCA-OpenHands/releases/latest/download/install.sh | bash
open http://localhost:3000
```

The installer prompts for your `ANTHROPIC_API_KEY` and projects directory, writes
`~/openhands-app/.env`, and starts everything. Re-run it to update; manage the stack with
`docker compose …` from `~/openhands-app`. Loopback-only by default (`OPENHANDS_BIND` to
change); optional integrations (OpenAI, GitLab/GitHub tokens, ntfy, manager runs) are
commented in the generated `.env`. Full guide — operating the stack, updating,
troubleshooting, cutting a release: [docs/packaging.md](docs/packaging.md).

## Quickstart (development)

Requirements: Node ≥ 22, Docker.

```bash
npm install
cp .env.example .env   # set ANTHROPIC_API_KEY and OPENHANDS_PROJECTS_DIR
bash scripts/dev.sh    # compose up agent-canvas (+ postgres when PGHOST set),
                       # then tsx watch (API :3000) + vite (UI :5173)
open http://localhost:5173
```

- **Local folder task (default)**: the homepage shows a folder grid of everything under
  `OPENHANDS_PROJECTS_DIR` — click a project, type a prompt, Start agent.
- **Repo task**: switch workspace mode to "Clone repo" → pick/paste an https repo URL (allowlist env-overridable via
  `OPENHANDS_REPO_URL_PATTERN`; set `GITLAB_TOKEN` for the MR panel / suggested issues and
  `OPENHANDS_GIT_TOKEN` for clone/push credentials).
- **Manager runs**: uncomment the `PG*` block in `.env` — dev.sh then also starts the postgres
  compose profile.
- `:3000` taken? Set `PORT` in `.env`; the vite proxy follows it.
- Production-ish: `npm run build && node dist/server/index.js` serves UI+API from one process
  on `PORT`.

### Phone access over Tailscale

```bash
bash scripts/dev.sh --tailscale   # auto-detects your MagicDNS name + checks the macOS firewall
# phone: http://your-machine.your-tailnet.ts.net:5173
```

Manual equivalent: set `VITE_ALLOWED_HOSTS=your-machine.your-tailnet.ts.net` (or `all`)
in `.env` — Vite rejects unknown Host headers otherwise. The UI is responsive below `lg`
(stacked Changes panels, overlay sidebar, touch-sized controls) and installable to the
phone home screen (PWA manifest). Full guide incl. the release-package path:
[docs/mobile.md](docs/mobile.md).

**macOS gotcha**: the Application Firewall silently drops incoming connections for
node binaries that were ever denied (connections hang or reset while localhost still
works). Allow your node once:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(command -v node)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(command -v node)"
```

Optional HTTPS (needed for browser notifications on the phone; tailnet-only, not public —
requires enabling HTTPS certificates for the tailnet in the Tailscale admin console):

```bash
tailscale serve --bg --https=443 http://localhost:5173
# → https://your-machine.your-tailnet.ts.net  (tailscale serve reset to undo)
```

### State & cleanup

Conversations and their `sessions/<uuid>` workspaces persist in the `openhands-home` docker
volume; the agent API key lives in `./.state` (gitignored). There is **no janitor** locally —
watch the disk-usage bar in the UI and delete old conversations (or
`docker volume rm <project>_openhands-home` for a full reset).

### LLM keys

- `ANTHROPIC_API_KEY` — primary; default models are `anthropic/*`.
- `OPENAI_API_KEY` — optional. **Note:** if your key is EU-data-residency pinned, set
  `OPENAI_BASE_URL=https://eu.api.openai.com/v1`; such keys 401 against the default endpoint.

## Docs

Contributor docs are markdown-canonical and also rendered in-app under **Contributing**
(`/openhands/contributing`). Start at [CONTRIBUTING.md](CONTRIBUTING.md); highlights:

- [docs/architecture.md](docs/architecture.md) — topology, conversation lifecycle, BFF ↔ agent-server
- [docs/extending.md](docs/extending.md) — fork this and build your own coding-agent IDE
- [docs/risk-map.md](docs/risk-map.md) — dimensional risk levels per code area
- [docs/decisions.md](docs/decisions.md) — decisions log

## Provenance

Extracted, with written approval, from an internal developer-platform codebase; thin platform
couplings (auth middleware, logger, GitLab client, DB pool, client shell/design-system) were
replaced by local equivalents. Slack notifications were intentionally left behind.

## Trademarks

"OpenHands" is a trademark of its respective owner. This project is an independent,
community-built UI for driving OpenHands agents; it is not affiliated with, endorsed by, or
sponsored by the OpenHands project or All Hands AI. All other trademarks are the property of
their respective owners.

## License

[MIT](LICENSE).
