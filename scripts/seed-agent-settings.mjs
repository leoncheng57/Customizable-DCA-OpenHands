// One-time performance defaults for the agent-server profile (issue #48):
//
//   1. Condenser token threshold: the stock profile only condenses at 240
//      events with the token trigger off, letting long sessions grow past
//      200k tokens per turn (4x+ slower steps, silent rate-limit backoff).
//      Seed max_tokens=80000 — but ONLY while the profile still has the stock
//      null, so a value the user saved on the Agent-settings page is never
//      clobbered.
//   2. LLM token streaming: required for the live-draft SSE bridge — without
//      stream=true on the LLM the agent-server never emits
//      StreamingDeltaEvent. Profile-level default; the BFF also sets it
//      per-conversation on create.
//   3. Disable the dead `slack-mcp` MCP server if present: it is an
//      internal endpoint unreachable from this standalone setup, and
//      its tool-listing timeout adds a fixed 20s stall to every run.
//
// Idempotent. Shared by scripts/sync-agent-settings.sh (dev.sh) and the app
// container entrypoint (deploy/app-entrypoint.sh). With SEED_WAIT_SECONDS
// set, polls for the agent API key / server instead of skipping — the
// container starts in parallel with the agent, whose key file only appears
// after first boot.
//
// Env: OPENHANDS_INTERNAL_URL (default http://localhost:8010),
//      OPENHANDS_API_KEY or OPENHANDS_API_KEY_FILE
//      (default ./.state/agent-canvas/api-key.txt),
//      SEED_WAIT_SECONDS (default 0 — single attempt, exit 0 on not-ready).

import { readFileSync, existsSync } from "node:fs";

const baseUrl = process.env.OPENHANDS_INTERNAL_URL || "http://localhost:8010";
const keyFile = process.env.OPENHANDS_API_KEY_FILE || "./.state/agent-canvas/api-key.txt";
const waitSeconds = Number(process.env.SEED_WAIT_SECONDS || "0");
const deadline = Date.now() + waitSeconds * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readKey() {
  if (process.env.OPENHANDS_API_KEY) return process.env.OPENHANDS_API_KEY;
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, "utf-8").trim();
    if (key) return key;
  }
  return null;
}

async function fetchSettings(key) {
  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { "X-Session-API-Key": key },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return await res.json();
    console.error(`seed-agent-settings: GET /api/settings → ${res.status}`);
  } catch (err) {
    console.error(`seed-agent-settings: agent-server not reachable (${err?.message ?? err})`);
  }
  return null;
}

let key = null;
let settings = null;
for (;;) {
  key = readKey();
  if (key) settings = await fetchSettings(key);
  if (settings) break;
  if (Date.now() >= deadline) {
    console.error(
      key
        ? "seed-agent-settings: agent-server not ready — skipping"
        : "seed-agent-settings: no agent API key available yet — skipping",
    );
    process.exit(0);
  }
  await sleep(3000);
}

const headers = { "X-Session-API-Key": key, "Content-Type": "application/json" };
const agent = settings.agent_settings ?? {};

// 1. Condenser token threshold — seed only over the stock null.
const condenser = agent.condenser ?? {};
if (condenser.max_tokens == null) {
  const patch = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ agent_settings_diff: { condenser: { max_tokens: 80000 } } }),
  });
  console.log(`seed-agent-settings: condenser.max_tokens null → 80000 (PATCH ${patch.status})`);
} else {
  console.log(`seed-agent-settings: condenser.max_tokens already ${condenser.max_tokens} — leaving as-is`);
}

// 2. LLM token streaming — required for the live-draft SSE bridge.
const llm = agent.llm ?? {};
if (llm.stream !== true) {
  const patch = await fetch(`${baseUrl}/api/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ agent_settings_diff: { llm: { stream: true } } }),
  });
  console.log(`seed-agent-settings: llm.stream → true (PATCH ${patch.status})`);
} else {
  console.log("seed-agent-settings: llm.stream already true");
}

// 3. Disable the unreachable slack-mcp server (20s stall per run, issue #41).
const slack = agent.mcp_config?.["slack-mcp"];
if (slack && slack.enabled !== false) {
  const patch = await fetch(`${baseUrl}/api/settings/mcp/slack-mcp`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ ...slack, enabled: false }),
  });
  console.log(`seed-agent-settings: slack-mcp enabled → false (PATCH ${patch.status})`);
} else if (slack) {
  console.log("seed-agent-settings: slack-mcp already disabled");
}
