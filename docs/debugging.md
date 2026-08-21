# Logs & debugging

Every layer logs somewhere different. This page is the map, then a symptom-indexed playbook.

## Where the logs are

```text
┌ Browser ─────────────┐  devtools console + network tab (SSE frames under EventStream)
│ React SPA            │
└──────────┬───────────┘
           │
┌ BFF ─────▼───────────┐  stdout of `tsx watch` (scripts/dev.sh terminal)
│ pino, pretty in dev  │  structured: logger.info({...}, "msg") — server/logger.ts
└──────────┬───────────┘  prod: JSON lines from `node dist/server/index.js`
           │
┌ Agent ───▼───────────┐  docker compose logs -f openhands
│ agent-server         │  conversation state, agent loop, tool execution
└──────────┬───────────┘
           │
┌ Postgres ▼───────────┐  docker compose logs postgres   (manager profile only)
└──────────────────────┘
```

Quick commands:

```bash
docker compose logs -f openhands          # agent-server, follow
docker compose logs --since 10m openhands # recent only
docker compose ps                         # is everything actually up?
docker compose exec openhands sh          # shell inside the agent container
```

In-app surfaces (often faster than logs):

- **Terminal page** (`/openhands/terminal`) — read-only audit of every command any agent ran.
- **Tools page** (`/openhands/tools`) — agent-server health, CLI availability, MCP status.
- **Conversation → Changes/Files** — what actually happened to the workspace.
- **Disk usage bar** — the `openhands-home` volume filling up is a real failure mode
  (there is no janitor; delete old conversations).

## BFF logging conventions

`server/logger.ts` is pino: pretty-printed in dev, JSON in prod. Convention:
`logger.warn({ err, id }, "OpenHands BFF: <what failed>")` — structured fields first,
human message second. Upstream (agent-server) call failures funnel through a single
warn in `setup.ts`, so grep for `"upstream"` when the UI shows stale data.

## Playbook — symptom → likely cause → where to look

| Symptom | Likely cause | Look at |
|---|---|---|
| UI loads, every API call 401/403 | auth allowlist — `OPENHANDS_ALLOWED_EMAILS` doesn't match (default `dev@local`) | BFF log; `server/auth.ts` |
| "API key file not readable yet" errors | agent-canvas hasn't written `.state/agent-canvas/api-key.txt` yet (first boot race) or `.state` mount broken | `docker compose logs openhands`; `ls .state/agent-canvas/` |
| Conversation create 400 "model is not in the configured allowlist" | model id missing from `OPENHANDS_MODELS` | [llms.md](llms.md) |
| LLM errors mid-run with OpenAI models | EU-pinned key against default endpoint | set `OPENAI_BASE_URL=https://eu.api.openai.com/v1` (decision #8) |
| Transcript freezes, then catches up after reload | SSE dropped (BFF restarted — normal in dev hot-reload) | it reconnects; if not, browser network tab → the events request |
| Transcript never streams at all | vite proxy not reaching the BFF — `PORT` mismatch | `.env` `PORT` vs `vite.config.ts` proxy target; `npx vite` output |
| Preview panel shows the app's own UI instead of the dev server | the `/api/`-prefixed preview base hit the generic proxy rule — bypass rule broken | `vite.config.ts` proxy block; [architecture.md](architecture.md) |
| Local-folder conversation can't create files | workspace ownership — docker created the mount dir as root | `scripts/dev.sh` runs the chown fix; re-run it |
| Clone-by-URL fails instantly | URL rejected by `OPENHANDS_REPO_URL_PATTERN`, or askpass has no token (`OPENHANDS_GIT_TOKEN`/`GITLAB_TOKEN`) | BFF log; `scripts/openhands-askpass.sh` |
| Manager runs page says feature disabled | `PGHOST` unset (feature gate) or Postgres connect failed at boot | BFF startup log: "database connected" vs "connection failed" |
| Agent can't push / `gh` unauthenticated | `OPENHANDS_GITHUB_TOKEN` not set when the container started | `docker compose exec openhands env \| grep -i token` |
| Runs start ~20s late, indicator sits on "Thinking…" | an unreachable MCP server times out during setup (MCP init emits no events, so it's invisible in the transcript) | the stall hint under the indicator names failing servers; Tools page; `scripts/sync-agent-settings.sh` disables `slack-mcp` |
| Disk mysteriously full | orphaned `sessions/<uuid>` workspaces (no janitor) | disk-usage bar; `docker system df`; delete conversations or reset the volume |
| Everything broken after a compose change | stale container state | `docker compose down && bash scripts/dev.sh`; nuclear: `docker volume rm <project>_openhands-home` (destroys conversations) |

## Debugging the BFF interactively

- Hit endpoints directly: `curl -s localhost:$PORT/api/openhands/status | jq` (auth passes by
  default single-user config).
- A second, disposable BFF against the same agent-server (different `PORT`) is the safest way
  to poke at server changes while a real conversation is running — recipe in
  [agent-sessions.md](agent-sessions.md).
- SSE by hand: `curl -N localhost:$PORT/api/openhands/conversations/<id>/events`.

## When you fix something non-obvious

Add the symptom to the playbook table above, and if it changed behavior, a decisions.md row.
The table is the app's institutional memory of pain.
