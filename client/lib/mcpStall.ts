// client/lib/mcpStall.ts
//
// Naming the likely culprit behind a silent stall.
//
// The running indicator can say "Thinking… no new events for 22s" but never
// *why*: MCP setup emits no events at all, so an unreachable MCP server (the
// `slack-mcp` case in issue #41 — a 20s tool-listing timeout on every run)
// is indistinguishable from the LLM generating a long reply. Until the
// agent-server emits MCP lifecycle events (issue #67), the closest available
// signal is the tool-health probe the Tools page already runs: if a server
// fails its connect+tools/list test, it is also what stalls a run.
//
// The hint is therefore a *correlation*, not a measurement, and is worded as
// one. It loads lazily — only once a stall is long enough to be worth
// explaining — so the healthy path costs nothing.
import { useEffect, useState } from "react";
import { openHandsApi, type ToolsHealth } from "./api.js";

/**
 * How long the transcript must be silent before the hint is worth fetching.
 * Comfortably above a normal LLM turn, comfortably below the 20s MCP
 * tool-listing timeout, so the hint lands while the stall is still on screen.
 */
export const MCP_STALL_HINT_AFTER_MS = 12_000;

/** Names of MCP servers that failed their health probe. */
export function unhealthyMcpNames(tools: ToolsHealth | null): string[] {
  return (tools?.mcp ?? []).filter((m) => m.health === "error").map((m) => m.name);
}

/**
 * One-line explanation for a stall, or null when nothing is known to be
 * broken (in which case the plain "Thinking…" readout stands on its own).
 */
export function mcpStallHint(names: string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
  const subject = names.length === 1 ? "server" : "servers";
  return `MCP ${subject} ${list} failed a health check — an unreachable server can stall every run for ~20s while its tools are listed.`;
}

/**
 * Fetches tool health at most once per mount, and only after `stalled` turns
 * true. The BFF caches and coalesces the probe, so several open tabs hitting
 * this during the same stall collapse into one upstream round of MCP tests.
 */
export function useMcpStallHint(stalled: boolean): string | null {
  const [tools, setTools] = useState<ToolsHealth | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!stalled || asked) return;
    setAsked(true);
    let cancelled = false;
    openHandsApi
      .tools()
      .then((t) => {
        if (!cancelled) setTools(t);
      })
      .catch(() => {
        /* best-effort: a failed probe just means no hint */
      });
    return () => {
      cancelled = true;
    };
  }, [stalled, asked]);
  return mcpStallHint(unhealthyMcpNames(tools));
}
