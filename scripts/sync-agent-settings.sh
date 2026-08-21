#!/usr/bin/env bash
# Thin wrapper around scripts/seed-agent-settings.mjs (shared with the
# packaged app container's entrypoint — see deploy/app-entrypoint.sh).
# Single attempt: skips silently when the agent-server or its API key is not
# up yet (same contract as sync-mcp.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/seed-agent-settings.mjs
