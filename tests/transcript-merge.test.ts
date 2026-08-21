// The bottom-anchored transcript accumulates every raw event it has ever
// fetched — newest-first poll windows plus "Load older events" pages — into
// one deduped, chronological list. These tests pin the merge semantics the
// Conversation page relies on: gap-free unions of sliding windows, stable
// identity when nothing new arrived (no re-render churn), and chronological
// output regardless of the order pages arrive in.
import { describe, expect, it } from "vitest";
import { mergeRawEvents, type RawOpenHandsEvent } from "../client/lib/events.js";

function ev(id: string, ts: string): RawOpenHandsEvent {
  return { id, kind: "MessageEvent", timestamp: ts };
}

const ids = (list: RawOpenHandsEvent[]) => list.map((e) => e.id);

describe("mergeRawEvents", () => {
  it("sorts a newest-first page into chronological order", () => {
    const page = [ev("c", "2026-01-01T00:00:03"), ev("b", "2026-01-01T00:00:02"), ev("a", "2026-01-01T00:00:01")];
    expect(ids(mergeRawEvents([], page))).toEqual(["a", "b", "c"]);
  });

  it("merges an older page below the existing window (prepend)", () => {
    const window = mergeRawEvents([], [ev("d", "2026-01-01T00:00:04"), ev("c", "2026-01-01T00:00:03")]);
    const older = [ev("b", "2026-01-01T00:00:02"), ev("a", "2026-01-01T00:00:01")];
    expect(ids(mergeRawEvents(window, older))).toEqual(["a", "b", "c", "d"]);
  });

  it("bridges a slid window without gaps or duplicates", () => {
    // Poll 1 saw [a, b]; the agent kept working; poll 2's newest-2 window is
    // [c, d]. The union must contain everything once, in order.
    const first = mergeRawEvents([], [ev("b", "2026-01-01T00:00:02"), ev("a", "2026-01-01T00:00:01")]);
    const second = [ev("d", "2026-01-01T00:00:04"), ev("c", "2026-01-01T00:00:03")];
    expect(ids(mergeRawEvents(first, second))).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps overlapping windows deduplicated", () => {
    const first = mergeRawEvents([], [ev("b", "2026-01-01T00:00:02"), ev("a", "2026-01-01T00:00:01")]);
    const overlapping = [ev("c", "2026-01-01T00:00:03"), ev("b", "2026-01-01T00:00:02")];
    expect(ids(mergeRawEvents(first, overlapping))).toEqual(["a", "b", "c"]);
  });

  it("returns the previous array identity when nothing new arrived", () => {
    const prev = mergeRawEvents([], [ev("a", "2026-01-01T00:00:01"), ev("b", "2026-01-01T00:00:02")]);
    expect(mergeRawEvents(prev, [ev("a", "2026-01-01T00:00:01")])).toBe(prev);
    expect(mergeRawEvents(prev, [])).toBe(prev);
  });

  it("orders identical timestamps deterministically by id", () => {
    const a = ev("aaa", "2026-01-01T00:00:01");
    const b = ev("bbb", "2026-01-01T00:00:01");
    expect(ids(mergeRawEvents([], [b, a]))).toEqual(["aaa", "bbb"]);
    expect(ids(mergeRawEvents([a], [b]))).toEqual(["aaa", "bbb"]);
  });

  it("tolerates events without ids via a timestamp/kind key", () => {
    const noId: RawOpenHandsEvent = { kind: "ConversationStateUpdateEvent", timestamp: "2026-01-01T00:00:05" };
    const merged = mergeRawEvents([], [noId, ev("a", "2026-01-01T00:00:01")]);
    expect(merged).toHaveLength(2);
    expect(mergeRawEvents(merged, [noId])).toBe(merged);
  });
});
