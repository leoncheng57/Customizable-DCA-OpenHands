// Bottom status bar data (issue #43, opencode's status line): current folder,
// how full the model's context window is, and what the session has cost.
//
// The numbers come from the agent-server's per-conversation `stats`, NOT from
// the `metrics` field — upstream leaves `metrics` null on both the detail and
// the search payload, so anything reading it renders nothing. `stats` carries
// one `usage_to_metrics` entry per LLM the conversation has used ("default",
// "condenser", plus a named entry per model it was switched to), which is why
// cost sums across entries while the context gauge follows the entry that
// billed most recently — that is the LLM whose context the next turn fills.

export interface TokenUsageSnapshot {
  prompt_tokens?: number;
  completion_tokens?: number;
  context_window?: number;
  /** Tokens of a single turn (prompt + completion), not a running total. */
  per_turn_token?: number;
}

export interface UsageMetrics {
  model_name?: string;
  accumulated_cost?: number;
  accumulated_token_usage?: TokenUsageSnapshot | null;
  token_usages?: TokenUsageSnapshot[] | null;
  costs?: Array<{ cost?: number; timestamp?: number }> | null;
}

export interface ConversationStats {
  usage_to_metrics?: Record<string, UsageMetrics> | null;
}

/** The subset of a conversation the status bar reads. */
export interface StatusBarSource {
  workspace?: { working_dir?: string | null } | null;
  metrics?: { accumulated_cost?: number } | null;
  stats?: ConversationStats | null;
}

export interface StatusBarInfo {
  /**
   * Full working dir. Deliberately not the basename: sibling worktrees and
   * per-session checkouts share one, so it cannot identify the tree the agent
   * is editing.
   */
  workingDir: string | null;
  cost: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** Percentage of the context window the last turn occupied (0–100+). */
  contextPct: number | null;
  /** Model the context gauge describes. */
  contextModel: string | null;
}

const CONDENSER_KEY = "condenser";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lastUsage(entry: UsageMetrics): TokenUsageSnapshot | null {
  const usages = entry.token_usages ?? [];
  return usages.length > 0 ? usages[usages.length - 1] : (entry.accumulated_token_usage ?? null);
}

function turnTokens(entry: UsageMetrics): number | null {
  const usage = lastUsage(entry);
  if (!usage) return null;
  const perTurn = finite(usage.per_turn_token);
  if (perTurn !== null && perTurn > 0) return perTurn;
  const prompt = finite(usage.prompt_tokens) ?? 0;
  const completion = finite(usage.completion_tokens) ?? 0;
  const sum = prompt + completion;
  return sum > 0 ? sum : null;
}

function contextWindow(entry: UsageMetrics): number | null {
  const fromLast = finite(lastUsage(entry)?.context_window);
  if (fromLast !== null && fromLast > 0) return fromLast;
  const fromAccumulated = finite(entry.accumulated_token_usage?.context_window);
  return fromAccumulated !== null && fromAccumulated > 0 ? fromAccumulated : null;
}

function lastBilledAt(entry: UsageMetrics): number {
  let latest = 0;
  for (const c of entry.costs ?? []) {
    const ts = finite(c?.timestamp);
    if (ts !== null && ts > latest) latest = ts;
  }
  return latest;
}

/** Total spend of the conversation across every LLM it has used. */
export function conversationCost(source: StatusBarSource | null | undefined): number | null {
  const entries = Object.values(source?.stats?.usage_to_metrics ?? {});
  let total: number | null = null;
  for (const entry of entries) {
    const cost = finite(entry?.accumulated_cost);
    if (cost === null) continue;
    total = (total ?? 0) + cost;
  }
  return total ?? finite(source?.metrics?.accumulated_cost);
}

/**
 * The usage entry whose context the next turn fills: the most recently billed
 * non-condenser LLM (the condenser runs on side context of its own).
 */
function primaryUsage(stats: ConversationStats | null | undefined): { key: string; entry: UsageMetrics } | null {
  let best: { key: string; entry: UsageMetrics; billedAt: number } | null = null;
  for (const [key, entry] of Object.entries(stats?.usage_to_metrics ?? {})) {
    if (!entry || key === CONDENSER_KEY) continue;
    if (turnTokens(entry) === null) continue;
    const billedAt = lastBilledAt(entry);
    if (!best || billedAt > best.billedAt) best = { key, entry, billedAt };
  }
  return best ? { key: best.key, entry: best.entry } : null;
}

export function deriveStatusBar(source: StatusBarSource | null | undefined): StatusBarInfo {
  const workingDir = source?.workspace?.working_dir ?? null;
  const primary = primaryUsage(source?.stats);
  const contextTokens = primary ? turnTokens(primary.entry) : null;
  const window = primary ? contextWindow(primary.entry) : null;
  return {
    workingDir,
    cost: conversationCost(source),
    contextTokens,
    contextWindow: window,
    contextPct: contextTokens !== null && window ? (contextTokens / window) * 100 : null,
    contextModel: primary ? (primary.entry.model_name ?? null) : null,
  };
}

export function formatCost(cost: number | null): string | null {
  if (cost === null) return null;
  if (cost <= 0) return "$0.00";
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}K`;
  }
  return String(Math.round(tokens));
}

export function formatPercent(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct > 0 && pct < 1) return "<1%";
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export type ContextTone = "normal" | "warn" | "danger";

/** Context pressure: the agent starts losing history once the window fills. */
export function contextTone(pct: number | null): ContextTone {
  if (pct === null) return "normal";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "normal";
}
