#!/usr/bin/env node
// Smoke test: boot the built server and verify /api/openhands/status returns 200.
//
// Used by the CI `check` job to guard against failures where `npm run build`
// exits 0 but the server crashloops on startup because the entrypoint moved
// or a startup import fails. The status route responds 200 with
// `configured:false` when no agent-server env is present, so the probe needs
// no containers and no secrets.
//
// Self-contained (no curl/wget dependency) — node's global fetch only.
//
// Usage: node scripts/smoke-test.mjs
// Env:
//   PORT (default: 3000) — port the server binds to
//   SMOKE_TIMEOUT_SECONDS (default: 30) — how long to wait for the probe
//   SMOKE_ENTRYPOINT (default: dist/server/index.js) — server entrypoint

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT || "3000";
const TIMEOUT_S = Number(process.env.SMOKE_TIMEOUT_SECONDS || "30");
const ENTRYPOINT = process.env.SMOKE_ENTRYPOINT || "dist/server/index.js";
const PROBE_URL = `http://127.0.0.1:${PORT}/api/openhands/status`;

/** @param {string} msg */
const log = (msg) => console.log(`[smoke-test] ${msg}`);

/** @param {import("node:child_process").ChildProcess} child */
const killChild = (child) => {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
};

async function probeStatus() {
  try {
    const res = await fetch(PROBE_URL);
    if (res.status !== 200) return { ok: false, status: res.status };
    const body = await res.json();
    return { ok: true, status: 200, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  log(`booting server: node ${ENTRYPOINT}`);
  const server = spawn("node", [ENTRYPOINT], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PORT },
  });

  let serverExited = false;
  server.on("exit", (code, signal) => {
    serverExited = true;
    log(`server process exited: code=${code} signal=${signal}`);
  });

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (serverExited) {
      log(`server died before the status probe passed (attempt ${attempt})`);
      process.exit(1);
    }
    const result = await probeStatus();
    if (result.ok) {
      log(`OK on attempt ${attempt}: ${JSON.stringify(result.body)}`);
      killChild(server);
      process.exit(0);
    }
    await sleep(1000);
  }

  log(`FAILED: ${PROBE_URL} did not return 200 within ${TIMEOUT_S}s`);
  killChild(server);
  process.exit(1);
}

main().catch((err) => {
  console.error("[smoke-test] unexpected error:", err);
  process.exit(1);
});
