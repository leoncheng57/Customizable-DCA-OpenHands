#!/usr/bin/env bash
# Sync MCP servers from mcp-servers.json into agent-canvas settings, so
# agents get the servers as tools. Idempotent: POST /api/settings/mcp/<name>
# upserts each entry. The file is gitignored (it may carry secrets) — copy
# mcp-servers.example.json to mcp-servers.json and fill in your servers.
#
# Server spec shape (agent-canvas MCPServer): stdio servers use
# {"transport":"stdio","command":"npx","args":[...],"env":{...}}; remote ones
# {"transport":"streamable-http","url":"https://...","auth":{"strategy":"oauth2"}}
# (OAuth flows are completed from the Tools page / upstream Canvas UI).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f mcp-servers.json ] || exit 0

BASE_URL="${OPENHANDS_INTERNAL_URL:-http://localhost:8010}"
KEY_FILE="${OPENHANDS_API_KEY_FILE:-./.state/agent-canvas/api-key.txt}"
KEY="${OPENHANDS_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$KEY_FILE" ]; then
  KEY="$(cat "$KEY_FILE")"
fi
if [ -z "$KEY" ]; then
  echo "sync-mcp: no agent API key available yet — skipping" >&2
  exit 0
fi

node --input-type=module - "$BASE_URL" "$KEY" <<'EOF'
import { readFileSync } from "node:fs";
const [baseUrl, key] = process.argv.slice(2);
const servers = JSON.parse(readFileSync("mcp-servers.json", "utf-8"));
for (const [name, spec] of Object.entries(servers)) {
  const res = await fetch(`${baseUrl}/api/settings/mcp/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "X-Session-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  // 409/400 on an existing identical entry is fine; PATCH updates it.
  if (res.status === 409 || res.status === 400) {
    const patch = await fetch(`${baseUrl}/api/settings/mcp/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "X-Session-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    console.log(`sync-mcp: ${name} → PATCH ${patch.status}`);
  } else {
    console.log(`sync-mcp: ${name} → POST ${res.status}`);
  }
}
EOF
