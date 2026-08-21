import { describe, expect, it } from "vitest";
import { runningActivity, type TranscriptEvent, type TranscriptItem } from "../client/lib/events.js";
import { formatElapsedSince } from "../client/lib/time.js";

const ev = (over: Partial<TranscriptEvent>): TranscriptEvent => ({
  id: over.id ?? "e1",
  kind: over.kind ?? "agent",
  label: over.label ?? "",
  text: over.text ?? "",
  timestamp: over.timestamp ?? "",
  ...over,
});

const toolCall = (
  tool: Partial<TranscriptEvent>,
  output: Partial<TranscriptEvent> | null,
): TranscriptItem => ({
  type: "toolCall",
  tool: ev({ kind: "tool", ...tool }),
  output: output ? ev({ kind: "observation", ...output }) : null,
});

const event = (e: Partial<TranscriptEvent>): TranscriptItem => ({ type: "event", event: ev(e) });

describe("runningActivity", () => {
  it("reports thinking with no items", () => {
    expect(runningActivity([])).toEqual({ kind: "thinking", since: null });
  });

  it("reports the trailing pending tool call as the current activity", () => {
    const items = [
      event({ kind: "user", timestamp: "2026-08-20T10:00:00Z" }),
      toolCall(
        { label: "terminal", text: "npm run build", timestamp: "2026-08-20T10:00:10Z" },
        null,
      ),
    ];
    expect(runningActivity(items)).toEqual({
      kind: "tool",
      label: "terminal",
      text: "npm run build",
      since: "2026-08-20T10:00:10Z",
    });
  });

  it("still sees the pending call through trailing status separators", () => {
    const items = [
      toolCall({ label: "terminal", text: "git push", timestamp: "2026-08-20T10:00:10Z" }, null),
      event({ kind: "status", label: "status", text: "running", timestamp: "2026-08-20T10:00:11Z" }),
    ];
    expect(runningActivity(items)).toMatchObject({ kind: "tool", label: "terminal" });
  });

  it("ignores a stale unpaired call buried under later activity", () => {
    const items = [
      toolCall({ label: "terminal", text: "old command", timestamp: "2026-08-20T09:00:00Z" }, null),
      event({ kind: "agent", text: "moving on", timestamp: "2026-08-20T10:00:00Z" }),
    ];
    expect(runningActivity(items)).toEqual({ kind: "thinking", since: "2026-08-20T10:00:00Z" });
  });

  it("thinking `since` is the newest timestamp across tools and outputs", () => {
    const items = [
      toolCall(
        { label: "terminal", text: "ls", timestamp: "2026-08-20T10:00:00Z" },
        { timestamp: "2026-08-20T10:00:05Z" },
      ),
      event({ kind: "agent", text: "done", timestamp: "2026-08-20T10:00:02Z" }),
    ];
    expect(runningActivity(items)).toEqual({ kind: "thinking", since: "2026-08-20T10:00:05Z" });
  });
});

describe("formatElapsedSince", () => {
  const now = Date.parse("2026-08-20T10:01:00Z");

  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsedSince("2026-08-20T10:00:13Z", now)).toBe("47s");
    expect(formatElapsedSince("2026-08-20T09:58:47Z", now)).toBe("2m 13s");
    expect(formatElapsedSince("2026-08-20T08:57:00Z", now)).toBe("1h 04m");
  });

  it("clamps future timestamps to zero and handles bad input", () => {
    expect(formatElapsedSince("2026-08-20T10:02:00Z", now)).toBe("0s");
    expect(formatElapsedSince(null, now)).toBe("");
    expect(formatElapsedSince("not-a-date", now)).toBe("");
  });
});
