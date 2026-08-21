# Repo memory for agents

Standalone OpenHands runner: Express BFF (`server/`) + React/Vite UI (`client/`) driving a
headless `ghcr.io/openhands/agent-canvas` container (agent-server API on :8010 in dev,
authenticated via `X-Session-API-Key`; see `server/openhands/upstream.ts`).

## Key facts

- `server/openhands/setup.ts` (~3.1k lines) holds nearly all BFF routes; helpers are pulled
  out into sibling modules (`planMode.ts`, `agentSettings.ts`, `images.ts`, …) so vitest can
  unit-test them without an upstream.
- Tests: `npm test` (vitest, `tests/*.test.ts`, import server/client modules directly with
  `.js` suffixes), `npm run typecheck` (two tsconfigs). Playwright e2e exists but needs the
  stack running.
- The pinned agent-canvas image (1.12.0) speaks SDK/agent-server 1.40.x. A live agent-server
  is often reachable at `http://localhost:8010` (`/server_info`) — useful for verifying API
  contracts; otherwise check `github.com/OpenHands/software-agent-sdk` at the matching tag.
- Client UI conventions worth knowing before adding one: `client/ds/` primitives are
  forwardRef + `cn()` + semantic `var(--color-*)` only (never raw hex); every interactive
  element carries `data-testid="openhands-…"`; no new runtime deps.

## Ports & parallel worktrees

`docker compose` binds **fixed** ports (8010 agent-server, 3210 BFF) and bind-mounts
`./.state`, so only ONE worktree may run the stack. Check `docker ps` / `lsof -i :8010 -i
:3210` before starting anything. Tiers 1–3 (typecheck/test/build) need no stack.

To exercise *your* branch when the stack is already up, don't start a second one — run a
second BFF on a free port against the running agent-server: copy the main checkout's `.env`
(gitignored), set `PORT=<free>` and make `OPENHANDS_API_KEY_FILE` an **absolute** path into the
main checkout's `.state/` (the default is relative and your worktree has no `.state`), then
`npm run build && node dist/server/index.js`. Then VERIFY the port is yours — `lsof -nP
-iTCP:<port> -sTCP:LISTEN` must show your PID; other projects on this machine run the same
binary and "server listening" in your log does not prove you won the bind. Playwright reuses
it via `PORT=<port> npx playwright test`. Delete the `.env` and kill that PID afterwards (the
captured PID, not a broad `pkill -f` pattern). Full guide: `docs/testing.md`.

## Screenshots on PRs

Default: add a `@shots` entry to `tests/e2e/shots.ts` (`npm run screenshots`;
`test:e2e` grep-inverts the tag) — CI's smoke job uploads the `pr-screenshots` artifact and
maintains a sticky comment, all `continue-on-error` (decision #18). ALL data in shots is a
fixture, never live — every list-shaped endpoint the page can render must be stubbed via
`page.route()` (conversations, local-folders, repos, manager runs), because local captures
otherwise leak real project and conversation names in pixels. Full recipe: `docs/testing.md`.

## Command palette (Cmd/Ctrl+K)

- Logic in `client/lib/palette.ts` (pure, React-free, unit-tested); DOM/ARIA in
  `client/ds/command-palette.tsx`. Keep that split — vitest is `environment: "node"`, so
  anything that moves into the component stops being testable.
- `rankCommands` generalises `filterRepos` (`components/RepoSelect.tsx`): title-prefix >
  word-prefix > substring, then kind, then `localeCompare`. Blank query = natural order.
- It is the app's only portal/modal and only ARIA listbox. Stacking ladder: navbar `z-40`,
  sidebar drag shield `z-50`, palette `z-[60]`.
- Sources are `NAV`, `DOCS` and `openHandsApi.list()`, fetched **on open** — do not add a
  poller; Hub and `useNotifyWatcher` already poll that endpoint.

## Global agent settings reach conversations only because the BFF forwards them

- The agent-server does NOT merge the persisted default profile into a conversation created
  with an `agent_settings` payload (SDK 1.40.1: `_populate_agent_from_settings` validates
  only what you send; `conversation_service.start_conversation` reads the settings store
  solely on the `agent_profile_id` path). Omitted fields become SDK defaults.
- So `conversationAgentSettings()` in `server/openhands/agentSettings.ts` forwards the
  persisted `condenser` + skill-selection `agent_context` on both create paths
  (`setup.ts` POST /conversations and `manager/agent-client.ts`). Anything new you add to
  the global settings page is INERT until you add it there too (decision #18).
- It is an allow-list on purpose: `GET /api/settings` masks secrets as `**********`, so
  `mcp_config` and `agent_context.secrets` must not be copied through. `agent_context.skills`
  is excluded as well — send the flags, never the materialized list.

## Transcript event contract

- Rich `ActionEvent` fields live at the **top level**, not on `action`: `summary`,
  `reasoning_content`, `thinking_blocks`, `responses_reasoning_item`, `security_risk`,
  `llm_response_id`, `tool_call`.
- `summary` is always populated — when the tool defines no description the SDK falls back to
  `"<tool_name>: <full args JSON>"`, which inlines `old_str`/`new_str`/`file_text`. Never
  render it raw; `cleanSummary()` rejects that form and callers fall back to `toolDetails()`.
- Reasoning is often encrypted-only (`responses_reasoning_item.encrypted_content`,
  `redacted_thinking.data`) on OpenAI/Anthropic runs — those payloads and Anthropic
  `signature` must never reach the DOM, and an empty "Thought" row per action is noise, so
  only readable reasoning gets a row.

## Plan mode (feat/plan-mode)

- Plan/Build mode is the upstream `confirmation_policy`: Build = `NeverConfirm`; Plan =
  `ConfirmRisky{threshold: MEDIUM, confirm_unknown: true}` + `security_analyzer:
  LLMSecurityAnalyzer`. LOW-risk (read-only) actions run; writes park the conversation in
  `waiting_for_confirmation` (Approve/Reject UI pre-existed).
- Mid-run switch: BFF `POST /conversations/:id/mode` → upstream
  `/{id}/security_analyzer` + `/{id}/confirmation_policy`; `notify:true` on build also sends
  the canned approve message and restarts the run.
- Never store mode client-side — derive it from `confirmation_policy.kind`
  (`client/lib/planMode.ts` / `server/openhands/planMode.ts` must stay in agreement; the
  plan-mode test cross-checks them).

## Skill toggles (feat/toggleable-skills)

- Skills are GLOBAL-only (decision #17): BFF `GET|PATCH /skills` patch the default profile.
  Upstream has no way to mutate a running conversation's `agent_context`.
- Effective enabled = install-level `enabled` (`/api/skills/installed`) AND not in
  `agent_context.disabled_skills`. The deny-list is the authority (it also covers
  auto-loaded skills); the install flag is mirrored where the skill exists.
- `GET /skills` is a THREE-way read: `/api/skills/installed` + `/api/settings` +
  `POST /api/skills` (merged effective set). The third one is why auto-loaded skills get a
  row at all — no row means no way to deny them. Skipped when every source is off,
  best-effort otherwise (public loads git-pull upstream); `loadedUnavailable` marks failure.
- `agent_settings_diff` deep-merges objects but REPLACES LISTS — `disabled_skills` is
  read-modify-write, never partial.
- `load_user_skills` / `load_public_skills` / `load_project_skills` all default to `false`;
  with them off, toggles persist but load nothing. Surface that state explicitly.
- Same duplicate-classifier pattern as plan mode: `client/lib/skills.ts` mirrors
  `server/openhands/skills.ts`; `tests/skills.test.ts` cross-checks one case table.
- Every `agent_context` write must also send `skills: []`. Upstream materializes resolved
  `load_user`/`load_public` skills into `agent_context.skills` and persists them; without the
  reset, switching a source back off leaves them behind as explicit skills (one-way toggle).
