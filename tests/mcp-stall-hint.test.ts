// Cause hint shown under a long "Thinking…" silence (issue #41): which MCP
// servers failed their health probe, and how that reads in the UI.
import { describe, expect, it } from "vitest";
import { mcpStallHint, unhealthyMcpNames } from "../client/lib/mcpStall.js";
import type { ToolsHealth } from "../client/lib/api.js";

function health(mcp: ToolsHealth["mcp"]): ToolsHealth {
  return {
    server: { health: "ok", version: "1.0.0", uptime: 1, latencyMs: 5 },
    tools: [],
    skills: [],
    mcp,
    integrations: [],
    probedAt: "2026-08-20T10:00:00Z",
  };
}

describe("unhealthyMcpNames", () => {
  it("returns nothing when health was never fetched", () => {
    expect(unhealthyMcpNames(null)).toEqual([]);
  });

  it("ignores healthy and disabled/unknown servers", () => {
    const tools = health([
      { name: "fetch", health: "ok", detail: "connected · 3 tools" },
      { name: "slack-mcp", health: "unknown", detail: "configured, disabled" },
    ]);
    expect(unhealthyMcpNames(tools)).toEqual([]);
  });

  it("returns only servers that failed their probe", () => {
    const tools = health([
      { name: "fetch", health: "ok", detail: "connected · 3 tools" },
      { name: "slack-mcp", health: "error", detail: "probe failed (timeout)" },
    ]);
    expect(unhealthyMcpNames(tools)).toEqual(["slack-mcp"]);
  });
});

describe("mcpStallHint", () => {
  it("stays silent when nothing is known to be broken", () => {
    expect(mcpStallHint([])).toBeNull();
  });

  it("names a single failing server in the singular", () => {
    expect(mcpStallHint(["slack-mcp"])).toBe(
      "MCP server slack-mcp failed a health check — an unreachable server can stall every run for ~20s while its tools are listed.",
    );
  });

  it("joins two failing servers", () => {
    expect(mcpStallHint(["slack-mcp", "jira"])).toContain("MCP servers slack-mcp and jira failed");
  });

  it("summarizes more than two so the line stays short", () => {
    expect(mcpStallHint(["a", "b", "c", "d"])).toContain("a, b +2 more");
  });
});
