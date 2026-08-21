// client/mock/fixtures/tools-health.ts
//
// The Tools & health probe result. The real endpoint (server/openhands/setup.ts,
// `probeToolsHealth`) makes a dozen live requests — `/server_info`,
// `/api/tools/`, a bash exec, a file-API call, `/api/mcp/test` per configured
// server, GitHub/GitLab token checks and a CLI-auth script inside the
// container — and folds them into one `ToolsHealth`. There is nothing to probe
// in a browser, so this composes the same shape from fixed facts.
//
// Two rules kept it honest:
//  · every `detail` string below is the one the real code emits for that
//    outcome, copied verbatim. Inventing friendlier wording would make the
//    demo advertise a page that does not exist.
//  · the health mix is deliberately imperfect. A board that is green
//    everywhere never shows the states the page was built for, so one MCP
//    server is unreachable (which also feeds the MCP stall hint in
//    client/lib/mcpStall.ts), one is masked, one is disabled, and two sandbox
//    CLIs are unauthenticated.
//
// MCP server names are generic placeholders. They name no product and match
// no real configuration.
import type { ToolHealthState, ToolsHealth } from "../../lib/api.js";
import { HOUR, elapsedMs, isoNow, SECOND } from "../clock.js";

/** Agent-canvas version the demo claims to be talking to. */
const SERVER_VERSION = "1.12.0";
/** Uptime at page load; grows while the visitor stays, like a real server's. */
const SERVER_UPTIME_AT_START = 4 * HOUR + 12 * 60 * SECOND;

/**
 * Tool ids and descriptions exactly as `TOOL_DESCRIPTIONS` lists them, in the
 * order the real route produces (it sorts the agent-server's tool list).
 */
const TOOLS: Array<{ id: string; description: string; health: ToolHealthState; detail?: string; latencyMs?: number }> = [
  { id: "browser_tool_set", description: "Headless browser automation", health: "unknown", detail: "no cheap probe; verified on first agent use" },
  { id: "edit", description: "Targeted string replacement", health: "ok", latencyMs: 34 },
  { id: "file_editor", description: "Create & edit files", health: "ok", latencyMs: 34 },
  { id: "glob", description: "Find files by pattern", health: "ok", latencyMs: 34 },
  { id: "grep", description: "Search file contents", health: "ok", latencyMs: 34 },
  { id: "list_directory", description: "List directory entries", health: "ok", latencyMs: 34 },
  { id: "planning_file_editor", description: "Plan-mode file editing", health: "ok", latencyMs: 34 },
  { id: "read_file", description: "Read file contents", health: "ok", latencyMs: 34 },
  { id: "task_tracker", description: "Track multi-step work", health: "ok", detail: "in-process" },
  { id: "terminal", description: "Run shell commands in the workspace", health: "ok", latencyMs: 96 },
  { id: "workflow_tool_set", description: "Workflow tool set", health: "ok", detail: "in-process" },
  { id: "write_file", description: "Write files", health: "ok", latencyMs: 34 },
];

/**
 * Configured MCP servers. `analytics-warehouse` fails its connect +
 * tools/list probe, which is the case the Tools page paints red and the one
 * `unhealthyMcpNames` reads when a run stalls with no events.
 */
const MCP: Array<{ name: string; health: ToolHealthState; detail: string; latencyMs?: number }> = [
  { name: "docs-search", health: "ok", detail: "connected · 6 tools", latencyMs: 210 },
  { name: "issue-tracker", health: "ok", detail: "connected · 14 tools", latencyMs: 348 },
  { name: "design-assets", health: "unknown", detail: "configured (secrets masked — verified on agent start)" },
  { name: "release-calendar", health: "unknown", detail: "configured, disabled" },
  { name: "analytics-warehouse", health: "error", detail: "probe failed (connect ETIMEDOUT — no response within 20s)" },
];

/** Sandbox CLI rows, with the real `CLI_ROWS` labels and failure hints. */
const CLI_ROWS: Array<{ id: string; label: string; ok: boolean; hint: string }> = [
  { id: "gh-cli", label: "gh CLI (sandbox)", ok: true, hint: "set OPENHANDS_GITHUB_TOKEN and recreate the container" },
  { id: "glab-cli", label: "glab CLI (sandbox)", ok: true, hint: "run scripts/dev.sh (installs glab) and set GITLAB_TOKEN" },
  { id: "acli", label: "acli CLI (sandbox)", ok: false, hint: "set ATLASSIAN_SITE/EMAIL/API_TOKEN and run scripts/dev.sh" },
  { id: "ntn-cli", label: "ntn CLI (sandbox · Notion)", ok: false, hint: "set NOTION_API_TOKEN and run scripts/dev.sh (installs ntn)" },
];

const CLI_PROBE_MS = 1_284;

/** Invented service accounts, so the "authed as …" details read plausibly. */
const GITHUB_LOGIN = "meridian-agent-bot";
const GITLAB_LOGIN = "meridian-agent-bot";

export interface ToolsHealthInput {
  /** Installed skills, so the skills roll-up agrees with the Skills card. */
  skills: Array<{ name: string; installEnabled: boolean }>;
  /** Effective ntfy target, or null when no topic is configured. */
  ntfy: { url: string; topic: string } | null;
}

/**
 * Build the probe result. `probedAt` is stamped at call time, so the header's
 * "probed HH:MM:SS" actually moves when the Re-check button is used.
 */
export function toolsHealth(input: ToolsHealthInput): ToolsHealth {
  const integrations: ToolsHealth["integrations"] = [
    { id: "github", label: "GitHub (gh)", health: "ok", detail: `token valid · authed as ${GITHUB_LOGIN}`, latencyMs: 268 },
    { id: "gitlab", label: "GitLab", health: "ok", detail: `token valid · authed as ${GITLAB_LOGIN}`, latencyMs: 194 },
    input.ntfy
      ? {
          id: "ntfy",
          label: "ntfy",
          health: "ok" as const,
          detail: `enabled · ${input.ntfy.url.replace(/^https?:\/\//, "")}/${input.ntfy.topic}`,
        }
      : { id: "ntfy", label: "ntfy", health: "unknown" as const, detail: "no topic configured — see the Notifications page" },
    { id: "manager-db", label: "Manager runs DB", health: "ok", detail: "postgres connected · schema openhands" },
    ...CLI_ROWS.map((row) =>
      row.ok
        ? {
            id: row.id,
            label: row.label,
            health: "ok" as const,
            detail: "authenticated inside the agent container",
            latencyMs: CLI_PROBE_MS,
          }
        : { id: row.id, label: row.label, health: "error" as const, detail: `not working — ${row.hint}` },
    ),
  ];

  return {
    server: {
      health: "ok",
      version: SERVER_VERSION,
      uptime: Math.floor((SERVER_UPTIME_AT_START + elapsedMs()) / SECOND),
      latencyMs: 12,
    },
    tools: TOOLS.map((t) => ({ ...t })),
    // Same roll-up the real route derives from GET /api/skills/installed:
    // install-level off reads as "unknown", not as an error.
    skills: input.skills.map((s) => ({
      name: s.name,
      health: (s.installEnabled ? "ok" : "unknown") as ToolHealthState,
      detail: s.installEnabled ? "installed" : "installed, disabled",
    })),
    mcp: MCP.map((m) => ({ ...m })),
    integrations,
    probedAt: isoNow(),
  };
}
