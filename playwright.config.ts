import { defineConfig } from "@playwright/test";

// Smoke suite (no LLM) — see docs/plan.md §Verification Step A.
// Prereqs: `docker compose --profile agent [--profile manager] up -d` and a
// seeded git project inside OPENHANDS_PROJECTS_DIR (tests/e2e/README.md).
// The web server is built + started automatically unless one is already
// listening on PORT.
const PORT = Number(process.env.PORT || 3210);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build >/dev/null 2>&1 && node dist/server/index.js",
    port: PORT,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
