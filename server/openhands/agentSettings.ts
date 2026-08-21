// Agent-settings helpers: the condenser controls how aggressively the
// agent-server summarizes a conversation's history back down. With the stock
// profile (max_size 240 events, token trigger off) long sessions grow to
// 100-200k tokens per turn, which makes every LLM step slower and pricier and
// trips silent rate-limit backoff (issue #48). These helpers shape and
// validate the BFF's /agent-settings routes; the actual persistence is the
// agent-server's own settings.json via `PATCH /api/settings
// { agent_settings_diff: { condenser: … } }` (deep-merge diff semantics, so we
// only ever send the fields the user changed and never touch condenser_kind).

/** Client-facing condenser preference shape (camelCase). */
export interface CondenserSettings {
  enabled: boolean;
  /** Condense once the visible history exceeds this many events. */
  maxSize: number;
  /** Condense once the visible history exceeds this many tokens; null = off. */
  maxTokens: number | null;
  /** Never condense away the first N events (system prompt + task). */
  keepFirst: number;
}

export interface AgentSettingsPayload {
  condenser: CondenserSettings;
}

/** Subset of the upstream GET /api/settings body we read. */
export interface UpstreamAgentSettings {
  agent_settings?: {
    condenser?: {
      enabled?: boolean;
      max_size?: number;
      max_tokens?: number | null;
      keep_first?: number;
    } | null;
    agent_context?: Record<string, unknown> | null;
    [key: string]: unknown;
  } | null;
}

/** Snake_case diff for `agent_settings_diff.condenser` in PATCH /api/settings. */
export interface CondenserDiff {
  enabled?: boolean;
  max_size?: number;
  max_tokens?: number | null;
  keep_first?: number;
}

/** Agent-canvas 1.12 stock profile values (what a fresh install ships with). */
export const CONDENSER_STOCK = { enabled: true, maxSize: 240, maxTokens: null as number | null, keepFirst: 2 };

/** Token threshold we recommend/seed: condense before the slow zone (issue #48). */
export const RECOMMENDED_MAX_TOKENS = 80_000;

export const MAX_TOKENS_MIN = 10_000;
export const MAX_TOKENS_MAX = 500_000;
export const MAX_SIZE_MIN = 20;
export const MAX_SIZE_MAX = 1_000;

/** Shape the upstream settings body into the client payload, filling stock defaults. */
export function condenserResponse(settings: UpstreamAgentSettings): AgentSettingsPayload {
  const c = settings.agent_settings?.condenser ?? {};
  return {
    condenser: {
      enabled: c.enabled !== false,
      maxSize: typeof c.max_size === "number" ? c.max_size : CONDENSER_STOCK.maxSize,
      maxTokens: typeof c.max_tokens === "number" ? c.max_tokens : null,
      keepFirst: typeof c.keep_first === "number" ? c.keep_first : CONDENSER_STOCK.keepFirst,
    },
  };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validate a client PATCH body (partial camelCase CondenserSettings) and build
 * the upstream snake_case diff. Cross-field bounds are checked against the
 * would-be resulting state (`current` merged with the patch) so a partial
 * update cannot create an invalid combination like keepFirst >= maxSize/2.
 */
export function validateCondenserPatch(
  body: unknown,
  current: CondenserSettings,
): { error: string } | { diff: CondenserDiff; next: CondenserSettings } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const diff: CondenserDiff = {};
  const next: CondenserSettings = { ...current };

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { error: "enabled must be a boolean" };
    diff.enabled = b.enabled;
    next.enabled = b.enabled;
  }
  if (b.maxTokens !== undefined) {
    if (b.maxTokens !== null && (!isInt(b.maxTokens) || b.maxTokens < MAX_TOKENS_MIN || b.maxTokens > MAX_TOKENS_MAX)) {
      return { error: `maxTokens must be null or an integer between ${MAX_TOKENS_MIN} and ${MAX_TOKENS_MAX}` };
    }
    diff.max_tokens = b.maxTokens as number | null;
    next.maxTokens = b.maxTokens as number | null;
  }
  if (b.maxSize !== undefined) {
    if (!isInt(b.maxSize) || b.maxSize < MAX_SIZE_MIN || b.maxSize > MAX_SIZE_MAX) {
      return { error: `maxSize must be an integer between ${MAX_SIZE_MIN} and ${MAX_SIZE_MAX}` };
    }
    diff.max_size = b.maxSize;
    next.maxSize = b.maxSize;
  }
  if (b.keepFirst !== undefined) {
    if (!isInt(b.keepFirst) || b.keepFirst < 1) return { error: "keepFirst must be an integer >= 1" };
    diff.keep_first = b.keepFirst;
    next.keepFirst = b.keepFirst;
  }
  if (Object.keys(diff).length === 0) return { error: "no recognized fields in patch (enabled, maxTokens, maxSize, keepFirst)" };
  // keep_first must leave the condenser room to work with; upstream enforces a
  // similar invariant, and violating it would break every future run.
  if (next.keepFirst >= next.maxSize / 2) {
    return { error: `keepFirst (${next.keepFirst}) must be less than half of maxSize (${next.maxSize})` };
  }
  return { diff, next };
}

// ── Carrying the global defaults into a new conversation ────────────────────
//
// The agent-server does NOT merge the persisted default profile into a
// conversation you create with an `agent_settings` payload. Verified in the
// pinned image (SDK 1.40.1):
//
//   * `StartConversationRequest._populate_agent_from_settings`
//     (sdk/conversation/request.py:316) builds the agent with
//     `validate_agent_settings(payload["agent_settings"]).create_agent()` —
//     it validates ONLY the payload it was handed, never the settings store.
//   * `conversation_service.start_conversation:1330` reads
//     `get_settings_store().load()` exclusively inside
//     `if request.agent_profile_id is not None:` — the branch a plain
//     `agent_settings` request never takes.
//   * `OpenHandsAgentSettings.agent_context` has `default_factory=AgentContext`,
//     so an omitted context becomes an EMPTY one: no deny-list, and every
//     `load_*_skills` false.
//
// Measured consequence on this deployment: all 64 stored conversations had
// `condenser.max_tokens: null` while the profile said 80000, and an empty
// agent_context — i.e. the condenser page (decision #11) and the skill toggles
// (decision #17) were both writing settings that never reached a single run.
//
// So the BFF forwards them explicitly. This is an ALLOW-LIST on purpose:
// `GET /api/settings` returns secret values MASKED as "**********", so copying
// the persisted blob wholesale would write those literals into the
// conversation — `mcp_config` and `agent_context.secrets` are excluded for
// exactly that reason and remain a known gap (they need the unmasked source).
// `agent_context.skills` is excluded too: upstream materializes the resolved
// sources into it, and re-sending a stale copy is the one-way-toggle bug from
// decision #17 — send the flags and let the agent-server resolve them.

/** agent_context fields that select skills: secret-free and non-derived. */
export const CONVERSATION_AGENT_CONTEXT_KEYS = [
  "disabled_skills",
  "load_user_skills",
  "load_public_skills",
  "load_project_skills",
  "load_memory",
  "marketplace_path",
  "registered_marketplaces",
] as const;

/**
 * Build the `agent_settings` for POST /api/conversations: the caller's LLM
 * (which the BFF always owns — model choice and `stream: true`) plus the
 * global defaults the agent-server would otherwise drop.
 *
 * Fails open. With no persisted settings — or an unreachable settings read —
 * the result is exactly `{ llm }`, i.e. today's behaviour, so a settings
 * outage can never block conversation creation.
 */
export function conversationAgentSettings(
  settings: UpstreamAgentSettings | null | undefined,
  llm: Record<string, unknown>,
): Record<string, unknown> {
  const persisted = settings?.agent_settings ?? {};
  const out: Record<string, unknown> = { llm };

  if (persisted.condenser && typeof persisted.condenser === "object") {
    out.condenser = persisted.condenser;
  }

  const source = (persisted.agent_context ?? {}) as Record<string, unknown>;
  const context: Record<string, unknown> = {};
  for (const key of CONVERSATION_AGENT_CONTEXT_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== null) context[key] = value;
  }
  if (Object.keys(context).length > 0) out.agent_context = context;

  return out;
}
