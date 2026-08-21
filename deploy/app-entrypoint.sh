#!/bin/sh
# Entry point for the app container. The agent container boots in parallel
# and only mints its API key on first start, so the profile seeding
# (scripts/seed-agent-settings.mjs — condenser threshold, llm.stream,
# slack-mcp off) runs in the background and polls until the agent is
# reachable, replicating what scripts/dev.sh does on the host.
set -eu

SEED_WAIT_SECONDS="${SEED_WAIT_SECONDS:-600}" node /app/scripts/seed-agent-settings.mjs &

exec node /app/dist/server/index.js
