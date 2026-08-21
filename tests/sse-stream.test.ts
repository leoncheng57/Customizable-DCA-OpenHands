import { describe, expect, it } from "vitest";
import { mapWsFrame, sseSerialize, wsAuthFrame, wsEventsUrl } from "../server/openhands/stream.js";

describe("mapWsFrame", () => {
  it("maps StreamingDeltaEvent content to a delta frame", () => {
    const raw = JSON.stringify({ kind: "StreamingDeltaEvent", content: "Hello", reasoning_content: null });
    expect(mapWsFrame(raw)).toEqual({ event: "delta", data: JSON.stringify({ content: "Hello" }) });
  });

  it("forwards reasoning-only deltas on their own channel", () => {
    expect(mapWsFrame(JSON.stringify({ kind: "StreamingDeltaEvent", reasoning_content: "thinking" })))
      .toEqual({ event: "reasoning", data: JSON.stringify({ content: "thinking" }) });
  });

  it("prefers answer content over reasoning when a frame carries both", () => {
    const raw = JSON.stringify({ kind: "StreamingDeltaEvent", content: "Hello", reasoning_content: "thinking" });
    expect(mapWsFrame(raw)).toEqual({ event: "delta", data: JSON.stringify({ content: "Hello" }) });
  });

  it("drops empty deltas", () => {
    expect(mapWsFrame(JSON.stringify({ kind: "StreamingDeltaEvent", content: "" }))).toBeNull();
    expect(mapWsFrame(JSON.stringify({ kind: "StreamingDeltaEvent", content: "", reasoning_content: "" }))).toBeNull();
    expect(mapWsFrame(JSON.stringify({ kind: "StreamingDeltaEvent" }))).toBeNull();
  });

  it("maps durable events to a lightweight kind ping (no payload passthrough)", () => {
    const raw = JSON.stringify({
      kind: "ActionEvent",
      tool_name: "terminal",
      action: { command: "secret command" },
    });
    expect(mapWsFrame(raw)).toEqual({ event: "event", data: JSON.stringify({ kind: "ActionEvent" }) });
  });

  it("drops malformed frames", () => {
    expect(mapWsFrame("not json")).toBeNull();
    expect(mapWsFrame("null")).toBeNull();
    expect(mapWsFrame('"string"')).toBeNull();
    expect(mapWsFrame(JSON.stringify({ content: "no kind" }))).toBeNull();
    expect(mapWsFrame("")).toBeNull();
  });
});

describe("sseSerialize", () => {
  it("produces spec-compliant SSE frames", () => {
    expect(sseSerialize({ event: "delta", data: '{"content":"x"}' })).toBe('event: delta\ndata: {"content":"x"}\n\n');
  });
});

describe("wsAuthFrame / wsEventsUrl", () => {
  it("builds the first-message auth frame", () => {
    expect(JSON.parse(wsAuthFrame("k123"))).toEqual({ type: "auth", session_api_key: "k123" });
  });

  it("derives ws and wss URLs from the http base", () => {
    expect(wsEventsUrl("http://localhost:8010", "abc")).toBe("ws://localhost:8010/sockets/events/abc");
    expect(wsEventsUrl("https://agent.example", "abc")).toBe("wss://agent.example/sockets/events/abc");
  });
});
