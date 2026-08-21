# E2E tests

## Step A — smoke suite (no LLM)

`npm run test:e2e` — 18 tests (API + browser tier). Never starts an agent run;
safe to run repeatedly at zero LLM cost.

Prereqs:

1. `.env` present (see `.env.example`; `PORT=3210` recommended).
2. Stack up: `docker compose --profile agent --profile manager up -d`.
3. Seeded local project in `OPENHANDS_PROJECTS_DIR`:
   ```bash
   mkdir -p <projects>/demo-project && cd <projects>/demo-project
   git init && echo "# demo" > README.md && git add . && git commit -m init
   ```

Playwright starts (or reuses) the app server itself. Artifacts: traces on
failure, screenshots on failure, HTML report (`npx playwright show-report`).

CI parity: `.github/workflows/ci.yml` runs this same suite on every PR (the
`smoke` job replicates the prereqs above — agent profile up, seeded
`demo-project` fixture — with no LLM key). Failure artifacts are uploaded to
the workflow run; the fast `check` job additionally boots the built server and
probes `/api/openhands/status` via `scripts/smoke-test.mjs`.

## Step B — real e2e (one paid LLM run)

Manual recipe, not part of `test:e2e` (slow, costs money, nondeterministic).
Covered checks: transcript streaming, file created on the host, diff in the
changes panel, terminal audit, and the repo-clone + MR panel path.

1. Stack up as above, UI at `http://localhost:5173` (or the built server).
2. New task → mode "Local folder" → `demo-project` → model
   `anthropic/claude-haiku-4-5-20251001` → prompt:
   > Create hello.txt containing exactly "hi" and commit it with message "add hello".
3. Watch the transcript; when finished assert:
   - `<projects>/demo-project/hello.txt` exists on the host with `hi`
   - Changes panel shows the commit / clean tree
   - Terminal page lists the agent's commands
4. Repo path: mode "Clone repo" → paste an https URL your token reaches →
   trivial prompt; confirm the clone lands under `sessions/<uuid>` and the MR
   panel loads if an MR exists.

Record evidence with `npx playwright codegen` or a screen recording when
needed; keep artifacts out of git (`test-results/` is ignored).
