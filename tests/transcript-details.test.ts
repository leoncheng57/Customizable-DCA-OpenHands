import { describe, expect, it } from "vitest";
import {
  cleanSummary,
  extractReasoning,
  groupEvents,
  normalizeEvents,
  toolDetails,
  type RawOpenHandsEvent,
} from "../client/lib/events.js";

/**
 * Shapes here mirror real agent-server 1.40.1 payloads captured from a live
 * conversation — notably that `summary` sits at the TOP level of ActionEvent
 * and that OpenAI-backed runs attach an encrypted `responses_reasoning_item`
 * to virtually every action.
 */
function action(overrides: Partial<RawOpenHandsEvent> = {}): RawOpenHandsEvent {
  return {
    id: "a1",
    kind: "ActionEvent",
    source: "agent",
    timestamp: "2026-08-21T01:00:00.000000",
    tool_name: "terminal",
    thought: [],
    action: { kind: "TerminalAction", command: "ls -la" },
    security_risk: "UNKNOWN",
    ...overrides,
  };
}

describe("cleanSummary", () => {
  it("reads the top-level ActionEvent summary (not action.summary)", () => {
    expect(cleanSummary(action({ summary: "List the workspace" }))).toBe("List the workspace");
  });

  it("still tolerates a nested action.summary", () => {
    const e = action({ action: { kind: "TerminalAction", command: "ls", summary: "Nested" } });
    expect(cleanSummary(e)).toBe("Nested");
  });

  it("rejects the SDK's generated `<tool>: <args-json>` fallback", () => {
    // The real fallback inlines old_str/new_str, i.e. an entire patch.
    const dump = 'file_editor: {"command": "str_replace", "path": "/a.ts", "old_str": "…", "new_str": "…"}';
    const e = action({ tool_name: "file_editor", summary: dump });
    expect(cleanSummary(e)).toBeUndefined();
  });

  it("rejects multi-line dumps and bounds long prose", () => {
    expect(cleanSummary(action({ summary: "line one\nline two" }))).toBeUndefined();
    const long = "x".repeat(400);
    const out = cleanSummary(action({ summary: long }));
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(201);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("returns undefined when there is no summary at all", () => {
    expect(cleanSummary(action())).toBeUndefined();
  });
});

describe("toolDetails", () => {
  it("includes the path for a file-editor create", () => {
    const e = action({
      tool_name: "file_editor",
      action: { kind: "FileEditorAction", command: "create", path: "/srv/app.ts", file_text: "x".repeat(5_000) },
    });
    expect(toolDetails(e)).toBe("create /srv/app.ts");
  });

  it("includes bounded selectors such as view_range", () => {
    const e = action({
      tool_name: "file_editor",
      action: { kind: "FileEditorAction", command: "view", path: "/srv/app.ts", view_range: [1, 50] },
    });
    expect(toolDetails(e)).toBe("view /srv/app.ts [view_range=1,50]");
  });

  it("never leaks file bodies or patches into the detail line", () => {
    const e = action({
      tool_name: "file_editor",
      action: {
        kind: "FileEditorAction",
        command: "str_replace",
        path: "/srv/app.ts",
        old_str: "SECRET_OLD_BODY",
        new_str: "SECRET_NEW_BODY",
      },
    });
    const detail = toolDetails(e);
    expect(detail).toBe("str_replace /srv/app.ts");
    expect(detail).not.toContain("SECRET_OLD_BODY");
    expect(detail).not.toContain("SECRET_NEW_BODY");
  });

  it("keeps terminal commands verbatim", () => {
    expect(toolDetails(action())).toBe("ls -la");
  });

  it("formats MCP arguments from action.data as [key=value]", () => {
    const e = action({
      tool_name: "search_docs",
      action: { kind: "MCPToolAction", data: { query: "plan mode", limit: 10, deep: true } },
    });
    expect(toolDetails(e)).toBe("[query=plan mode limit=10 deep=true]");
  });

  it("bounds oversized primitive values and the number of fields", () => {
    const e = action({
      tool_name: "search",
      action: { kind: "MCPToolAction", data: { a: "y".repeat(300), b: 1, c: 2, d: 3, e: 4, f: 5 } },
    });
    const detail = toolDetails(e);
    expect(detail).toContain("…");
    expect(detail.split(" ").length).toBeLessThanOrEqual(4);
    expect(detail).not.toContain("f=5");
  });
});

describe("extractReasoning", () => {
  it("returns readable reasoning_content", () => {
    const r = extractReasoning(action({ reasoning_content: "  I should list the files.  " }));
    expect(r).toEqual({ text: "I should list the files.", opaque: false });
  });

  it("reads Anthropic thinking blocks without exposing the signature", () => {
    const r = extractReasoning(action({
      thinking_blocks: [{ type: "thinking", thinking: "Consider the edge case", signature: "SIG_DO_NOT_RENDER" }],
    }));
    expect(r?.text).toBe("Consider the edge case");
    expect(JSON.stringify(r)).not.toContain("SIG_DO_NOT_RENDER");
  });

  it("never exposes redacted_thinking data — only marks it opaque", () => {
    const r = extractReasoning(action({
      thinking_blocks: [{ type: "redacted_thinking", data: "REDACTED_BLOB" }],
    }));
    expect(r).toEqual({ text: "", opaque: true });
    expect(JSON.stringify(r)).not.toContain("REDACTED_BLOB");
  });

  it("never exposes OpenAI encrypted_content — only marks it opaque", () => {
    const r = extractReasoning(action({
      responses_reasoning_item: { id: "rs_1", summary: [], encrypted_content: "ENCRYPTED_BLOB" },
    }));
    expect(r).toEqual({ text: "", opaque: true });
    expect(JSON.stringify(r)).not.toContain("ENCRYPTED_BLOB");
  });

  it("uses plaintext OpenAI summary/content when present", () => {
    const r = extractReasoning(action({
      responses_reasoning_item: { summary: ["Plan the edit"], content: ["Then run the tests"], encrypted_content: "BLOB" },
    }));
    expect(r?.opaque).toBe(false);
    expect(r?.text).toBe("Plan the edit\n\nThen run the tests");
    expect(r?.text).not.toContain("BLOB");
  });

  it("deduplicates the same thought reported through several fields", () => {
    const r = extractReasoning(action({
      reasoning_content: "Same thought",
      thinking_blocks: [{ type: "thinking", thinking: "Same   thought" }],
      responses_reasoning_item: { summary: ["Same thought"] },
    }));
    expect(r?.text).toBe("Same thought");
  });

  it("returns null when there is no reasoning at all", () => {
    expect(extractReasoning(action())).toBeNull();
  });
});

describe("normalizeEvents — reasoning rows", () => {
  it("emits one Thought row for readable reasoning", () => {
    const rows = normalizeEvents([action({ reasoning_content: "Thinking about it" })]);
    const thoughts = rows.filter((r) => r.kind === "reasoning");
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].label).toBe("Thought");
    expect(thoughts[0].text).toBe("Thinking about it");
  });

  it("orders the Thought row before the action it produced", () => {
    const rows = normalizeEvents([action({ reasoning_content: "First I think" })]);
    expect(rows.map((r) => r.kind)).toEqual(["reasoning", "tool"]);
  });

  it("does not duplicate reasoning across actions sharing an llm_response_id", () => {
    const rows = normalizeEvents([
      action({ id: "a1", llm_response_id: "resp-1", reasoning_content: "Shared thought" }),
      action({ id: "a2", llm_response_id: "resp-1", reasoning_content: "Shared thought" }),
    ]);
    expect(rows.filter((r) => r.kind === "reasoning")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "tool")).toHaveLength(2);
  });

  it("keeps separate reasoning for separate LLM responses", () => {
    const rows = normalizeEvents([
      action({ id: "a1", llm_response_id: "resp-1", reasoning_content: "One" }),
      action({ id: "a2", llm_response_id: "resp-2", reasoning_content: "Two" }),
    ]);
    expect(rows.filter((r) => r.kind === "reasoning").map((r) => r.text)).toEqual(["One", "Two"]);
  });

  it("marks the action instead of emitting an empty row for encrypted-only reasoning", () => {
    const rows = normalizeEvents([
      action({ responses_reasoning_item: { summary: [], encrypted_content: "BLOB" } }),
    ]);
    expect(rows.filter((r) => r.kind === "reasoning")).toHaveLength(0);
    const tool = rows.find((r) => r.kind === "tool");
    expect(tool?.opaque).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("BLOB");
  });

  it("keeps the existing thought narration row alongside reasoning", () => {
    const rows = normalizeEvents([
      action({ reasoning_content: "Internal reasoning", thought: [{ type: "text", text: "Now I will list files." }] }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["reasoning", "agent", "tool"]);
    expect(rows[1].text).toBe("Now I will list files.");
  });
});

describe("normalizeEvents — summary, detail and risk on the tool row", () => {
  it("carries the top-level summary and the compact detail", () => {
    const rows = normalizeEvents([action({
      tool_name: "file_editor",
      summary: "Create the entry point",
      action: { kind: "FileEditorAction", command: "create", path: "/srv/app.ts", file_text: "…" },
    })]);
    const tool = rows.find((r) => r.kind === "tool")!;
    expect(tool.summary).toBe("Create the entry point");
    expect(tool.text).toBe("create /srv/app.ts");
  });

  it("preserves a MEDIUM/HIGH security risk and drops UNKNOWN", () => {
    const risky = normalizeEvents([action({ security_risk: "HIGH" })]).find((r) => r.kind === "tool");
    expect(risky?.risk).toBe("HIGH");
    const unknown = normalizeEvents([action({ security_risk: "UNKNOWN" })]).find((r) => r.kind === "tool");
    expect(unknown?.risk).toBeUndefined();
  });

  it("shows details for a write still awaiting confirmation (no observation yet)", () => {
    const rows = normalizeEvents([action({
      id: "pending",
      tool_name: "file_editor",
      security_risk: "MEDIUM",
      action: { kind: "FileEditorAction", command: "create", path: "/srv/new.ts", file_text: "…" },
    })]);
    const items = groupEvents(rows);
    const call = items.find((i) => i.type === "toolCall");
    expect(call).toBeDefined();
    if (call?.type !== "toolCall") throw new Error("expected a toolCall item");
    expect(call.output).toBeNull();
    expect(call.tool.text).toBe("create /srv/new.ts");
    expect(call.tool.risk).toBe("MEDIUM");
  });
});

describe("normalizeEvents — existing behaviour is preserved", () => {
  it("still pairs an action with its observation by action_id", () => {
    const items = groupEvents(normalizeEvents([
      action({ id: "act-1" }),
      {
        id: "obs-1",
        kind: "ObservationEvent",
        timestamp: "2026-08-21T01:00:01.000000",
        action_id: "act-1",
        observation: { kind: "TerminalObservation", content: [{ type: "text", text: "total 0" }] },
      },
    ]));
    expect(items).toHaveLength(1);
    if (items[0].type !== "toolCall") throw new Error("expected a toolCall item");
    expect(items[0].tool.id).toBe("act-1");
    expect(items[0].output?.text).toBe("total 0");
  });

  it("still renders FinishAction as final agent prose", () => {
    const rows = normalizeEvents([action({
      tool_name: "finish",
      action: { kind: "FinishAction", message: "All done." },
    })]);
    const final = rows.find((r) => r.isFinal);
    expect(final?.kind).toBe("agent");
    expect(final?.text).toBe("All done.");
  });

  it("attaches reasoning to a FinishAction too", () => {
    const rows = normalizeEvents([action({
      tool_name: "finish",
      reasoning_content: "Wrapping up",
      action: { kind: "FinishAction", message: "All done." },
    })]);
    expect(rows.map((r) => r.kind)).toEqual(["reasoning", "agent"]);
  });
});
