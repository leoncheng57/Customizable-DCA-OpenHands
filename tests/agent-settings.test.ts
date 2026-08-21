import { describe, expect, it } from "vitest";
import {
  CONDENSER_STOCK,
  condenserResponse,
  conversationAgentSettings,
  validateCondenserPatch,
  type CondenserSettings,
} from "../server/openhands/agentSettings.js";

const current: CondenserSettings = { enabled: true, maxSize: 240, maxTokens: null, keepFirst: 2 };

describe("condenserResponse", () => {
  it("fills stock defaults for an empty settings body", () => {
    expect(condenserResponse({})).toEqual({ condenser: CONDENSER_STOCK });
    expect(condenserResponse({ agent_settings: {} })).toEqual({ condenser: CONDENSER_STOCK });
    expect(condenserResponse({ agent_settings: { condenser: null } })).toEqual({ condenser: CONDENSER_STOCK });
  });

  it("maps snake_case upstream fields to the client shape", () => {
    expect(
      condenserResponse({
        agent_settings: { condenser: { enabled: false, max_size: 100, max_tokens: 80_000, keep_first: 4 } },
      }),
    ).toEqual({ condenser: { enabled: false, maxSize: 100, maxTokens: 80_000, keepFirst: 4 } });
  });

  it("treats a missing max_tokens as null (token trigger off)", () => {
    expect(condenserResponse({ agent_settings: { condenser: { max_size: 240 } } }).condenser.maxTokens).toBeNull();
  });
});

describe("validateCondenserPatch", () => {
  it("builds a snake_case diff from a partial camelCase patch", () => {
    const result = validateCondenserPatch({ maxTokens: 80_000 }, current);
    expect(result).toEqual({
      diff: { max_tokens: 80_000 },
      next: { ...current, maxTokens: 80_000 },
    });
  });

  it("accepts a full patch including null maxTokens (trigger off)", () => {
    const result = validateCondenserPatch({ enabled: true, maxTokens: null, maxSize: 100, keepFirst: 3 }, current);
    expect(result).toEqual({
      diff: { enabled: true, max_tokens: null, max_size: 100, keep_first: 3 },
      next: { enabled: true, maxTokens: null, maxSize: 100, keepFirst: 3 },
    });
  });

  it("rejects non-object bodies and empty patches", () => {
    expect(validateCondenserPatch(null, current)).toHaveProperty("error");
    expect(validateCondenserPatch("x", current)).toHaveProperty("error");
    expect(validateCondenserPatch({}, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ unknownField: 1 }, current)).toHaveProperty("error");
  });

  it("bounds maxTokens to 10k-500k or null", () => {
    expect(validateCondenserPatch({ maxTokens: 9_999 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ maxTokens: 500_001 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ maxTokens: 80_000.5 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ maxTokens: "80000" }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ maxTokens: 10_000 }, current)).not.toHaveProperty("error");
    expect(validateCondenserPatch({ maxTokens: 500_000 }, current)).not.toHaveProperty("error");
  });

  it("bounds maxSize to 20-1000 integers", () => {
    expect(validateCondenserPatch({ maxSize: 19 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ maxSize: 1_001 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ maxSize: 20 }, current)).not.toHaveProperty("error");
  });

  it("rejects keepFirst >= half of the resulting maxSize (cross-field, partial patches)", () => {
    // keepFirst alone against current maxSize=240
    expect(validateCondenserPatch({ keepFirst: 120 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ keepFirst: 119 }, current)).not.toHaveProperty("error");
    // shrinking maxSize must respect the *current* keepFirst
    expect(validateCondenserPatch({ maxSize: 20 }, { ...current, keepFirst: 10 })).toHaveProperty("error");
    // both together validated as the merged result
    expect(validateCondenserPatch({ maxSize: 100, keepFirst: 49 }, current)).not.toHaveProperty("error");
    expect(validateCondenserPatch({ maxSize: 100, keepFirst: 50 }, current)).toHaveProperty("error");
  });

  it("rejects keepFirst < 1 and non-integers", () => {
    expect(validateCondenserPatch({ keepFirst: 0 }, current)).toHaveProperty("error");
    expect(validateCondenserPatch({ keepFirst: 1.5 }, current)).toHaveProperty("error");
  });

  it("rejects wrong-typed enabled", () => {
    expect(validateCondenserPatch({ enabled: "yes" }, current)).toHaveProperty("error");
  });
});

// The agent-server never merges the persisted default profile into a
// conversation created with an `agent_settings` payload (SDK 1.40.1:
// _populate_agent_from_settings validates only what you send; the settings
// store is read solely on the agent_profile_id path). Measured on the live
// deployment: 0 of 64 stored conversations had the configured condenser or any
// agent_context. These cases pin the forwarding that fixes it.
describe("conversationAgentSettings", () => {
  const llm = { model: "anthropic/claude-haiku-4-5", stream: true };

  it("forwards the persisted condenser and skill selection alongside the LLM", () => {
    expect(
      conversationAgentSettings(
        {
          agent_settings: {
            condenser: { enabled: true, max_size: 240, max_tokens: 80_000, keep_first: 2 },
            agent_context: { disabled_skills: ["discord"], load_public_skills: true, load_user_skills: false },
          },
        },
        llm,
      ),
    ).toEqual({
      llm,
      condenser: { enabled: true, max_size: 240, max_tokens: 80_000, keep_first: 2 },
      agent_context: { disabled_skills: ["discord"], load_public_skills: true, load_user_skills: false },
    });
  });

  it("fails open to today's behaviour when there is nothing persisted", () => {
    // A settings outage must never block conversation creation.
    for (const input of [null, undefined, {}, { agent_settings: null }, { agent_settings: {} }]) {
      expect(conversationAgentSettings(input, llm)).toEqual({ llm });
    }
  });

  it("never forwards mcp_config or agent_context.secrets (GET /api/settings masks them)", () => {
    // Secret values come back as "**********"; copying the blob wholesale
    // would persist those literals into the conversation.
    const out = conversationAgentSettings(
      {
        agent_settings: {
          mcp_config: { "slack-mcp": { command: "x", env: { TOKEN: "**********" } } },
          agent_context: { disabled_skills: [], secrets: { GH_TOKEN: "**********" } },
        },
      },
      llm,
    );
    expect(out).not.toHaveProperty("mcp_config");
    expect(out.agent_context).not.toHaveProperty("secrets");
    expect(JSON.stringify(out)).not.toContain("**********");
  });

  it("never forwards the materialized skills list (that is the one-way-toggle bug)", () => {
    const out = conversationAgentSettings(
      { agent_settings: { agent_context: { skills: [{ name: "pdf", content: "…" }], load_public_skills: true } } },
      llm,
    );
    expect(out.agent_context).toEqual({ load_public_skills: true });
    expect(JSON.stringify(out)).not.toContain("pdf");
  });

  it("drops unknown and null agent_context fields rather than passing them through", () => {
    const out = conversationAgentSettings(
      {
        agent_settings: {
          agent_context: { disabled_skills: null, current_datetime: "2026-08-21T00:00:00Z", nonsense: 1, load_memory: false },
        },
      },
      llm,
    );
    expect(out.agent_context).toEqual({ load_memory: false });
  });

  it("omits agent_context entirely when no selectable field survives", () => {
    expect(
      conversationAgentSettings({ agent_settings: { agent_context: { current_datetime: "x" } } }, llm),
    ).toEqual({ llm });
  });

  it("keeps the caller's LLM authoritative", () => {
    // The BFF owns model choice and stream:true; the profile must not win.
    const out = conversationAgentSettings({ agent_settings: { llm: { model: "other/model" } } }, llm);
    expect(out.llm).toEqual(llm);
  });
});
