// Guard for the demo backend's conversations group (client/mock/).
//
// Two things are being protected here, and they are different in kind.
//
// 1. THE NARRATIVE. The scripted run in client/mock/timeline.ts is the demo's
//    one piece of authored storytelling: a plan-mode bug fix that researches,
//    proposes a plan, stops at a MEDIUM-risk write, and finishes once the
//    visitor approves. A refactor that quietly drops the confirmation gate, or
//    lets the run finish without a FinishAction, breaks the demo without
//    breaking a type. So the beats are asserted, in order.
//
// 2. THE RENDERING. Fixtures that merely type-check can still produce a
//    transcript full of orphaned tool chips and empty Thought rows. Rather
//    than re-describe what a good transcript looks like, the tests below push
//    the fixtures through the REAL pipeline the page uses — normalizeEvents →
//    groupEvents → collapseActionGroups, plus runningActivity and
//    extractCommands from client/lib/events.ts — and assert on what comes out.
//    That is the assertion that actually says "the demo looks right".
import { beforeEach, describe, expect, it } from "vitest";

import {
  collapseActionGroups,
  extractCommands,
  groupEvents,
  normalizeEvents,
  runningActivity,
  type RawOpenHandsEvent,
  type TranscriptEvent,
} from "../client/lib/events.js";
import { conversationMode } from "../client/lib/planMode.js";
import { TERMINAL_STATUSES, type ConversationSummary } from "../client/lib/api.js";
import { handlers, SCRIPTED_CONVERSATION_ID } from "../client/mock/conversations.js";
import { demoState } from "../client/mock/state.js";
import { MockHttpError, type MockRequest } from "../client/mock/types.js";
import {
  allowWrites,
  approveRun,
  GATE_AT_MS,
  newRunProgress,
  pauseRun,
  rejectRun,
  resumeRun,
  runStatus,
  SCRIPT_END_MS,
  SCRIPT_FINAL_RESPONSE,
  SCRIPT_TASK,
  scriptRunMs,
  scriptedStatusAt,
  streamingSentence,
  timelineAt,
} from "../client/mock/timeline.js";

/** Fixed origin: the tests care about ordering, never about the wall clock. */
const ORIGIN = Date.UTC(2026, 0, 1, 12, 0, 0);

function at(runMs: number): RawOpenHandsEvent[] {
  return timelineAt(runMs, ORIGIN).events;
}

function ids(events: RawOpenHandsEvent[]): string[] {
  return events.map((e) => String(e.id));
}

// ── The script, as a story ───────────────────────────────────────────────────

describe("scripted timeline — the narrative", () => {
  it("opens with the user's task and nothing else", () => {
    const rows = normalizeEvents(at(0));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("user");
    expect(rows[0].text).toBe(SCRIPT_TASK);
  });

  it("researches with read-only tools before it proposes anything", () => {
    // Just before the plan is written down.
    const rows = normalizeEvents(at(GATE_AT_MS - 12_000));
    const tools = rows.filter((r) => r.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(4);
    expect(tools.map((t) => t.label)).toEqual(
      expect.arrayContaining(["terminal", "file_editor"]),
    );
    // Nothing risky has been attempted yet. The analyzer does score these —
    // as LOW — which is exactly why plan mode lets them run unprompted; only
    // MEDIUM and above earn a badge and the gate.
    expect(tools.every((t) => t.risk === "LOW")).toBe(true);
  });

  it("writes a task list that the pinned plan can render", () => {
    const rows = normalizeEvents(at(GATE_AT_MS));
    const withTasks = rows.filter((r) => r.tasks && r.tasks.length > 0);
    expect(withTasks.length).toBeGreaterThan(0);
    const plan = withTasks[withTasks.length - 1].tasks!;
    expect(plan).toHaveLength(4);
    expect(plan.filter((t) => t.status === "done")).toHaveLength(2);
    expect(plan.filter((t) => t.status === "in_progress")).toHaveLength(1);
  });

  it("posts the plan as agent prose before it tries to write", () => {
    const rows = normalizeEvents(at(GATE_AT_MS));
    const prose = rows.filter((r) => r.kind === "agent" && !r.isFinal);
    expect(prose.length).toBeGreaterThan(0);
    expect(prose.some((p) => p.text.includes("**Plan**"))).toBe(true);
  });

  it("parks the run on a MEDIUM-risk write batch", () => {
    const snapshot = timelineAt(GATE_AT_MS, ORIGIN);
    expect(snapshot.status).toBe("waiting_for_confirmation");
    expect(snapshot.awaitingConfirmation).toBe(true);

    const risky = normalizeEvents(snapshot.events).filter((r) => r.risk === "MEDIUM");
    expect(risky.length).toBe(3);
    // The chips must be renderable while pending — and must not leak the patch.
    for (const row of risky) {
      expect(row.text).not.toContain("randomUUID()");
      expect(row.text).not.toContain("import {");
      expect(row.text).toMatch(/^(str_replace|create) \/workspace\//);
    }
  });

  it("holds at the gate for as long as the visitor takes to answer", () => {
    // The clamp lives in the run clock, not in the script: an unapproved run
    // simply cannot advance its own `runMs` past the gate, so an hour of wall
    // clock reveals nothing further and the status never moves on.
    const started = resumeRun(newRunProgress(), 0);
    const anHourLater = 60 * 60_000;
    expect(scriptRunMs(started, anHourLater)).toBe(GATE_AT_MS);
    expect(ids(at(scriptRunMs(started, anHourLater)))).toEqual(ids(at(GATE_AT_MS)));
    expect(runStatus(started, anHourLater)).toBe("waiting_for_confirmation");
  });

  it("finishes with a FinishAction carrying the final response", () => {
    const rows = normalizeEvents(at(SCRIPT_END_MS));
    const final = rows.filter((r) => r.isFinal);
    expect(final).toHaveLength(1);
    expect(final[0].kind).toBe("agent");
    expect(final[0].text).toBe(SCRIPT_FINAL_RESPONSE);
    expect(scriptedStatusAt(SCRIPT_END_MS)).toBe("finished");
    expect(TERMINAL_STATUSES.has(scriptedStatusAt(SCRIPT_END_MS))).toBe(true);
  });

  it("stops: nothing is revealed after the end of the script", () => {
    expect(ids(at(SCRIPT_END_MS + 10 * 60_000))).toEqual(ids(at(SCRIPT_END_MS)));
  });

  it("keeps the published offsets in step with the script itself", () => {
    // GATE_AT_MS and SCRIPT_END_MS are declared as constants rather than read
    // back off the step list, so this is what stops them drifting when a beat
    // is retimed. The whole run clock is built on both.
    expect(scriptedStatusAt(GATE_AT_MS - 1)).toBe("running");
    expect(scriptedStatusAt(GATE_AT_MS)).toBe("waiting_for_confirmation");
    expect(scriptedStatusAt(SCRIPT_END_MS - 1)).not.toBe("finished");
    expect(scriptedStatusAt(SCRIPT_END_MS)).toBe("finished");
    expect(ids(at(SCRIPT_END_MS)).length).toBeGreaterThan(ids(at(SCRIPT_END_MS - 1)).length);
  });

  it("fits a demo attention span", () => {
    // ~33s of research to the gate, ~25s of implementation after it. Tune with
    // PACE in client/mock/timeline.ts, not by retiming individual beats.
    expect(SCRIPT_END_MS).toBeGreaterThan(40_000);
    expect(SCRIPT_END_MS).toBeLessThan(90_000);
    expect(GATE_AT_MS).toBeGreaterThan(20_000);
    expect(GATE_AT_MS).toBeLessThan(SCRIPT_END_MS);
  });

  it("never mentions a merge request it did not open", () => {
    // The demo has no /mr backend of its own, so a URL here would render a
    // sidebar that cannot be satisfied. Better to claim nothing.
    const text = JSON.stringify(at(SCRIPT_END_MS));
    expect(text).not.toMatch(/merge_requests\/\d+/);
    expect(text).not.toMatch(/github\.com\/[^"']+\/pull\/\d+/);
  });
});

// ── Monotonicity ─────────────────────────────────────────────────────────────

describe("scripted timeline — monotonicity", () => {
  /** Every 250ms across the whole arc, plus a little past the end. */
  const samples = Array.from({ length: Math.ceil(SCRIPT_END_MS / 250) + 8, }, (_, i) => i * 250);

  it("only ever adds events — nothing disappears or is reordered", () => {
    let previous: string[] = [];
    for (const runMs of samples) {
      const current = ids(at(runMs));
      expect(current.slice(0, previous.length)).toEqual(previous);
      previous = current;
    }
    expect(previous.length).toBeGreaterThan(20);
  });

  it("emits timestamps in non-decreasing order", () => {
    const events = at(SCRIPT_END_MS);
    const stamps = events.map((e) => e.timestamp ?? "");
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Date(stamps[0]).getTime()).toBe(ORIGIN);
  });

  it("gives every event a distinct, stable id", () => {
    const all = ids(at(SCRIPT_END_MS));
    expect(new Set(all).size).toBe(all.length);
    // Same slice, different origin: the ids must not move.
    expect(ids(timelineAt(SCRIPT_END_MS, ORIGIN + 999_999).events)).toEqual(all);
  });

  it("walks the status through the one legal sequence", () => {
    const seen: string[] = [];
    for (const runMs of samples) {
      const status = scriptedStatusAt(runMs);
      if (seen[seen.length - 1] !== status) seen.push(status);
    }
    expect(seen).toEqual(["running", "waiting_for_confirmation", "running", "finished"]);
  });

  it("never leaves a terminal status", () => {
    for (let runMs = SCRIPT_END_MS; runMs < SCRIPT_END_MS + 60_000; runMs += 500) {
      expect(scriptedStatusAt(runMs)).toBe("finished");
    }
  });

  it("keeps cost and context monotonically non-decreasing", () => {
    let cost = -1;
    let tokens = -1;
    for (const runMs of samples) {
      const snapshot = timelineAt(runMs, ORIGIN);
      expect(snapshot.costUsd).toBeGreaterThanOrEqual(cost);
      expect(snapshot.turnTokens).toBeGreaterThanOrEqual(tokens);
      cost = snapshot.costUsd;
      tokens = snapshot.turnTokens;
    }
    expect(cost).toBeGreaterThan(0);
  });
});

// ── The run clock ────────────────────────────────────────────────────────────

describe("run clock", () => {
  const T0 = 1_000_000;

  it("is idle until it is started, then runs", () => {
    const fresh = newRunProgress();
    expect(runStatus(fresh, T0)).toBe("idle");
    expect(scriptRunMs(fresh, T0 + 5_000)).toBe(0);

    const started = resumeRun(fresh, T0);
    expect(scriptRunMs(started, T0 + 5_000)).toBe(5_000);
    expect(runStatus(started, T0 + 5_000)).toBe("running");
  });

  it("banks elapsed time across a pause and resumes from there", () => {
    let p = resumeRun(newRunProgress(), T0);
    p = pauseRun(p, T0 + 8_000);
    expect(runStatus(p, T0 + 60_000)).toBe("paused");
    // Frozen: an hour of wall clock adds nothing.
    expect(scriptRunMs(p, T0 + 3_600_000)).toBe(8_000);

    p = resumeRun(p, T0 + 3_600_000);
    expect(scriptRunMs(p, T0 + 3_601_000)).toBe(9_000);
  });

  it("clamps at the gate no matter how long the tab stays open", () => {
    const p = resumeRun(newRunProgress(), T0);
    expect(scriptRunMs(p, T0 + SCRIPT_END_MS + 60_000)).toBe(GATE_AT_MS);
    expect(runStatus(p, T0 + SCRIPT_END_MS + 60_000)).toBe("waiting_for_confirmation");
  });

  it("plays act two from the moment of approval, not from page load", () => {
    const parked = resumeRun(newRunProgress(), T0);
    const dwell = T0 + GATE_AT_MS + 5 * 60_000; // visitor read the plan for 5 min
    const approved = approveRun(parked, dwell);

    expect(scriptRunMs(approved, dwell)).toBe(GATE_AT_MS);
    expect(runStatus(approved, dwell + 2_000)).toBe("running");
    expect(runStatus(approved, dwell + (SCRIPT_END_MS - GATE_AT_MS))).toBe("finished");
    // Act two's events are stamped from the approval, so they read as "now".
    const events = timelineAt(scriptRunMs(approved, dwell + 5_000), approved.originEpoch).events;
    const newest = new Date(events[events.length - 1].timestamp ?? "").getTime();
    expect(newest).toBeGreaterThan(dwell);
  });

  it("parks on rejection and re-arms the gate when the run restarts", () => {
    const parked = resumeRun(newRunProgress(), T0);
    const rejected = rejectRun(parked, T0 + GATE_AT_MS);
    expect(runStatus(rejected, T0 + GATE_AT_MS + 10_000)).toBe("paused");

    const restarted = resumeRun(rejected, T0 + GATE_AT_MS + 10_000);
    expect(runStatus(restarted, T0 + GATE_AT_MS + 11_000)).toBe("waiting_for_confirmation");
  });

  it("lifts the gate when plan mode is switched off before it fires", () => {
    const early = allowWrites(resumeRun(newRunProgress(), T0), T0 + 5_000);
    expect(early.approved).toBe(true);
    expect(early.gateSkipped).toBe(true);
    // No fast-forward: the run keeps its own pace, it just no longer stops.
    expect(scriptRunMs(early, T0 + 5_000)).toBe(5_000);
    expect(runStatus(early, T0 + SCRIPT_END_MS)).toBe("finished");
  });

  it("never reports a park that a NeverConfirm run would not have made", () => {
    // Switching to Build before the gate means the run never stopped, so the
    // status must never pass through waiting_for_confirmation and no separator
    // may claim it did.
    for (let runMs = 0; runMs <= SCRIPT_END_MS; runMs += 200) {
      expect(scriptedStatusAt(runMs, true)).not.toBe("waiting_for_confirmation");
    }
    const events = timelineAt(SCRIPT_END_MS, ORIGIN, { gateDisarmed: true }).events;
    expect(JSON.stringify(events)).not.toContain("waiting_for_confirmation");
    // …and the run still ends the way it should.
    expect(scriptedStatusAt(SCRIPT_END_MS, true)).toBe("finished");
    expect(normalizeEvents(events).some((e) => e.isFinal)).toBe(true);
  });

  it("keeps the park in the transcript when it really happened", () => {
    const approved = approveRun(resumeRun(newRunProgress(), T0), T0 + GATE_AT_MS);
    expect(approved.gateSkipped).toBe(false);
    const events = timelineAt(SCRIPT_END_MS, ORIGIN, { gateDisarmed: approved.gateSkipped }).events;
    expect(JSON.stringify(events)).toContain("waiting_for_confirmation");
  });

  it("treats switching off plan mode at the gate as an approval", () => {
    const parked = resumeRun(newRunProgress(), T0);
    const lifted = allowWrites(parked, T0 + GATE_AT_MS + 1_000);
    expect(scriptRunMs(lifted, T0 + GATE_AT_MS + 1_000)).toBe(GATE_AT_MS);
    expect(runStatus(lifted, T0 + GATE_AT_MS + 5_000)).toBe("running");
  });
});

// ── Through the real transcript pipeline ─────────────────────────────────────

function transcript(runMs: number) {
  const events = normalizeEvents(at(runMs));
  const items = groupEvents(events);
  return { events, items, display: collapseActionGroups(items) };
}

describe("the transcript the page will actually render", () => {
  it("pairs every completed tool call with its output", () => {
    const { items } = transcript(SCRIPT_END_MS);
    const calls = items.filter((i) => i.type === "toolCall");
    expect(calls.length).toBeGreaterThanOrEqual(12);
    // At the end of the run nothing is still pending.
    expect(calls.filter((c) => c.type === "toolCall" && !c.output)).toHaveLength(0);
    // …and no output was left orphaned into a synthetic "output" row.
    expect(calls.some((c) => c.type === "toolCall" && c.tool.label === "output")).toBe(false);
  });

  it("leaves the gated writes pending, with their risk badge, at the gate", () => {
    const { items } = transcript(GATE_AT_MS);
    const pending = items.filter((i) => i.type === "toolCall" && !i.output);
    expect(pending).toHaveLength(3);
    for (const call of pending) {
      if (call.type !== "toolCall") throw new Error("expected a toolCall");
      expect(call.tool.risk).toBe("MEDIUM");
      expect(call.tool.summary).toBeTruthy();
    }
  });

  it("reports the parked write as the live activity", () => {
    const { items } = transcript(GATE_AT_MS);
    const activity = runningActivity(items);
    expect(activity.kind).toBe("tool");
    if (activity.kind !== "tool") throw new Error("expected a tool activity");
    expect(activity.label).toBe("file_editor");
    // The newest unanswered call in the batch is what is "currently running".
    expect(activity.text).toMatch(/^(create|str_replace) \/workspace\/.+\.ts$/);
    expect(activity.since).toBeTruthy();
  });

  it("renders reasoning as Thought rows, and only when it is readable", () => {
    const { events } = transcript(SCRIPT_END_MS);
    const thoughts = events.filter((e) => e.kind === "reasoning");
    expect(thoughts.length).toBeGreaterThanOrEqual(2);
    expect(thoughts.every((t) => t.label === "Thought" && t.text.trim().length > 0)).toBe(true);
    // One action carries encrypted-only reasoning: it must be marked, not
    // rendered — and the blob must never reach a row.
    expect(events.some((e) => e.opaque === true)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("OPAQUE");
  });

  it("keeps the agent's narration as its own prose row, above the chip", () => {
    const { events } = transcript(SCRIPT_END_MS);
    const kinds = events.map((e) => e.kind);
    const firstThought = kinds.indexOf("reasoning");
    expect(firstThought).toBeGreaterThanOrEqual(0);
    // reasoning → narration → the tool call it produced.
    expect(kinds.slice(firstThought, firstThought + 3)).toEqual(["reasoning", "agent", "tool"]);
  });

  it("collapses completed runs of actions into groups", () => {
    const { display } = transcript(SCRIPT_END_MS);
    const groups = display.filter((d) => d.type === "actionGroup");
    expect(groups.length).toBeGreaterThanOrEqual(2);
    // Task-list cards must stay visible rather than hiding behind a chevron.
    for (const group of groups) {
      if (group.type !== "actionGroup") continue;
      expect(group.calls.every((c) => !c.tool.tasks && !c.output?.tasks)).toBe(true);
    }
  });

  it("shows a summary rather than a raw args dump on every tool chip", () => {
    const { events } = transcript(SCRIPT_END_MS);
    const chips = events.filter(
      (e): e is TranscriptEvent => e.kind === "tool" && e.label !== "Task list",
    );
    expect(chips.length).toBeGreaterThan(8);
    for (const chip of chips) {
      // cleanSummary() rejects the SDK's generated `<tool>: {json}` fallback,
      // so a surviving summary is a real one.
      expect(chip.summary ?? "").not.toContain("{");
      expect(chip.text.length).toBeLessThan(200);
    }
  });

  it("feeds the commands sidebar with real commands and edits", () => {
    const entries = extractCommands(transcript(SCRIPT_END_MS).items);
    const categories = new Set(entries.map((e) => e.category));
    expect(categories.has("command")).toBe(true);
    expect(categories.has("edit")).toBe(true);
    expect(entries.every((e) => e.status !== "pending")).toBe(true);
    expect(entries.some((e) => e.text === "npm test -- ledger")).toBe(true);
    // Task lists and skill cards are not commands.
    expect(entries.some((e) => e.label === "Task list")).toBe(false);
  });

  it("ends with a completed plan in the pinned task list", () => {
    const { events } = transcript(SCRIPT_END_MS);
    const withTasks = events.filter((e) => e.tasks && e.tasks.length > 0);
    const last = withTasks[withTasks.length - 1].tasks!;
    expect(last.every((t) => t.status === "done")).toBe(true);
  });
});

describe("live stream sentences", () => {
  it("offers something to type while the agent is working, and nothing after", () => {
    expect(streamingSentence(0)).toBeTruthy();
    expect(streamingSentence(GATE_AT_MS - 1_000)).toBeTruthy();
    expect(streamingSentence(SCRIPT_END_MS)).toBeNull();
  });
});

// ── Handlers ─────────────────────────────────────────────────────────────────

function request(method: string, path: string, init: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
} = {}): MockRequest {
  const url = new URL(`http://demo.test/api/openhands${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  return {
    method,
    path,
    params: init.params ?? {},
    query: url.searchParams,
    body: init.body,
    headers: new Headers(),
    url,
  };
}

async function call<T>(route: string, init: Parameters<typeof request>[2] = {}): Promise<T> {
  const [method, path] = route.split(" ") as [string, string];
  const handler = handlers.routes[route];
  if (!handler) throw new Error(`no handler for ${route}`);
  return (await handler(request(method, path, init))) as T;
}

/** Runs a handler and returns the MockHttpError it threw. */
async function callError(route: string, init: Parameters<typeof request>[2] = {}): Promise<MockHttpError> {
  try {
    await call(route, init);
  } catch (err) {
    if (err instanceof MockHttpError) return err;
    throw err;
  }
  throw new Error(`${route} was expected to fail`);
}

type ListResponse = { items: ConversationSummary[] };
type EventsPage = { items: RawOpenHandsEvent[]; next_page_id: string | null };

const LONG_CONVERSATION = "conv-icons-3140";

describe("conversation handlers", () => {
  beforeEach(() => {
    demoState.clear();
  });

  it("answers GET /status with a configured, allowlisted server", async () => {
    const status = await call<{ configured: boolean; models?: string[]; publicUrl: unknown }>("GET /status");
    expect(status.configured).toBe(true);
    expect(status.models?.length).toBeGreaterThan(1);
    // No Agent Canvas to link to in a demo.
    expect(status.publicUrl).toBeNull();
  });

  it("seeds a hub list covering every status tone", async () => {
    const { items } = await call<ListResponse>("GET /conversations");
    expect(items.length).toBeGreaterThanOrEqual(4);
    const statuses = items.map((c) => c.execution_status);
    expect(statuses).toEqual(expect.arrayContaining(["finished", "running", "paused", "error"]));
    expect(items.some((c) => !c.title)).toBe(true);
    expect(items.every((c) => c.workspace?.working_dir?.startsWith("/workspace"))).toBe(true);
    // Newest activity first.
    const updated = items.map((c) => c.updated_at ?? "");
    expect([...updated].sort().reverse()).toEqual(updated);
  });

  it("keeps the scripted run idle in the list and starts it when opened", async () => {
    const before = await call<ListResponse>("GET /conversations");
    expect(before.items.find((c) => c.id === SCRIPTED_CONVERSATION_ID)?.execution_status).toBe("idle");

    const opened = await call<ConversationSummary>("GET /conversations/:id", {
      params: { id: SCRIPTED_CONVERSATION_ID },
    });
    expect(opened.execution_status).toBe("running");
    expect(conversationMode(opened.confirmation_policy)).toBe("plan");

    const after = await call<ListResponse>("GET /conversations");
    expect(after.items.find((c) => c.id === SCRIPTED_CONVERSATION_ID)?.execution_status).toBe("running");
  });

  it("404s for a conversation that does not exist", async () => {
    const err = await callError("GET /conversations/:id", { params: { id: "conv-nope" } });
    expect(err.status).toBe(404);
  });

  describe("GET /conversations/:id/events", () => {
    it("returns pages that are disjoint, ordered and gap-free", async () => {
      const first = await call<EventsPage>("GET /conversations/:id/events", {
        params: { id: LONG_CONVERSATION },
        query: { limit: "300", order: "desc" },
      });
      expect(first.items).toHaveLength(300);
      expect(first.next_page_id).toBe(String(first.items[299].id));

      const second = await call<EventsPage>("GET /conversations/:id/events", {
        params: { id: LONG_CONVERSATION },
        query: { limit: "300", order: "desc", page_id: first.next_page_id! },
      });
      expect(second.items.length).toBeGreaterThan(0);
      expect(second.next_page_id).toBeNull();

      const firstIds = first.items.map((e) => String(e.id));
      const secondIds = second.items.map((e) => String(e.id));
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);

      // Concatenating the pages reproduces the whole log, newest first.
      const whole = await call<EventsPage>("GET /conversations/:id/events", {
        params: { id: LONG_CONVERSATION },
        query: { limit: "1000", order: "desc" },
      });
      expect([...firstIds, ...secondIds]).toEqual(whole.items.map((e) => String(e.id)));
      // …and desc really is the reverse of asc.
      const asc = await call<EventsPage>("GET /conversations/:id/events", {
        params: { id: LONG_CONVERSATION },
        query: { limit: "1000" },
      });
      expect(asc.items.map((e) => String(e.id)).reverse()).toEqual(whole.items.map((e) => String(e.id)));
    });

    it("stops paginating when a conversation fits in one page", async () => {
      const page = await call<EventsPage>("GET /conversations/:id/events", {
        params: { id: "conv-search-0865" },
        query: { limit: "300", order: "desc" },
      });
      expect(page.next_page_id).toBeNull();
      expect(page.items.length).toBeGreaterThan(2);
    });

    it("survives a stale cursor rather than serving an empty transcript", async () => {
      const page = await call<EventsPage>("GET /conversations/:id/events", {
        params: { id: "conv-search-0865" },
        query: { limit: "300", page_id: "ev-from-a-previous-life" },
      });
      expect(page.items.length).toBeGreaterThan(0);
    });
  });

  it("appends a follow-up, its images and a reply", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    await call("POST /conversations/:id/messages", {
      params: { id: "conv-search-0865" },
      body: { text: "Use the IETF spelling.", images: [{ mediaType: "image/png", data: png }] },
    });
    const page = await call<EventsPage>("GET /conversations/:id/events", {
      params: { id: "conv-search-0865" },
      query: { limit: "1000" },
    });
    const rows = normalizeEvents(page.items);
    const mine = rows.filter((r) => r.kind === "user");
    const latest = mine[mine.length - 1];
    expect(latest.text).toBe("Use the IETF spelling.");
    expect(latest.images).toEqual([`data:image/png;base64,${png}`]);
    // Sending resumes the run, which is what restarts the transcript poll.
    const summary = await call<ConversationSummary>("GET /conversations/:id", {
      params: { id: "conv-search-0865" },
    });
    expect(summary.execution_status).toBe("running");
  });

  it("rejects an empty follow-up", async () => {
    const err = await callError("POST /conversations/:id/messages", {
      params: { id: "conv-search-0865" },
      body: { text: "   " },
    });
    expect(err.status).toBe(400);
  });

  it("makes Run and Pause visibly change a static conversation", async () => {
    const id = "conv-nightly-2277";
    await call("POST /conversations/:id/pause", { params: { id } });
    expect((await call<ConversationSummary>("GET /conversations/:id", { params: { id } })).execution_status).toBe("paused");
    await call("POST /conversations/:id/run", { params: { id } });
    expect((await call<ConversationSummary>("GET /conversations/:id", { params: { id } })).execution_status).toBe("running");
  });

  it("round-trips the Plan/Build toggle through the confirmation policy", async () => {
    const id = SCRIPTED_CONVERSATION_ID;
    const build = await call<{ mode: string; notified: boolean }>("POST /conversations/:id/mode", {
      params: { id }, body: { mode: "build" },
    });
    expect(build).toEqual({ mode: "build", notified: false });
    let summary = await call<ConversationSummary>("GET /conversations/:id", { params: { id } });
    expect(conversationMode(summary.confirmation_policy)).toBe("build");

    await call("POST /conversations/:id/mode", { params: { id }, body: { mode: "plan" } });
    summary = await call<ConversationSummary>("GET /conversations/:id", { params: { id } });
    expect(conversationMode(summary.confirmation_policy)).toBe("plan");
  });

  it("delivers the canned approval message when Build is switched on with notify", async () => {
    const id = SCRIPTED_CONVERSATION_ID;
    const res = await call<{ notified: boolean }>("POST /conversations/:id/mode", {
      params: { id }, body: { mode: "build", notify: true },
    });
    expect(res.notified).toBe(true);
    const page = await call<EventsPage>("GET /conversations/:id/events", {
      params: { id }, query: { limit: "1000" },
    });
    const users = normalizeEvents(page.items).filter((r) => r.kind === "user");
    expect(users.some((u) => u.text.includes("plan mode is off"))).toBe(true);
  });

  it("validates respond_to_confirmation like the BFF does", async () => {
    const err = await callError("POST /conversations/:id/respond_to_confirmation", {
      params: { id: SCRIPTED_CONVERSATION_ID }, body: { accept: "yes" },
    });
    expect(err.status).toBe(400);
  });

  it("withholds the final response until the run has finished", async () => {
    const before = await call<string | null>("GET /conversations/:id/agent_final_response", {
      params: { id: "conv-nightly-2277" },
    });
    expect(before).toBeNull();
    const after = await call<string | null>("GET /conversations/:id/agent_final_response", {
      params: { id: LONG_CONVERSATION },
    });
    expect(typeof after).toBe("string");
    expect(after).toContain("@icons/core");
  });

  it("creates a conversation from the hub form and answers honestly", async () => {
    const created = await call<{ id: string; started: boolean }>("POST /conversations", {
      body: { prompt: "Add a health endpoint\nand wire it into the probe.", mode: "plan" },
    });
    expect(created.started).toBe(true);

    const summary = await call<ConversationSummary>("GET /conversations/:id", { params: { id: created.id } });
    expect(summary.title).toBe("Add a health endpoint");
    expect(conversationMode(summary.confirmation_policy)).toBe("plan");

    const page = await call<EventsPage>("GET /conversations/:id/events", {
      params: { id: created.id }, query: { limit: "100" },
    });
    expect(normalizeEvents(page.items)[0].text).toContain("Add a health endpoint");

    const { items } = await call<ListResponse>("GET /conversations");
    expect(items.some((c) => c.id === created.id)).toBe(true);
  });

  it("rejects a conversation with no prompt", async () => {
    expect((await callError("POST /conversations", { body: {} })).status).toBe(400);
  });

  it("deletes a conversation out of the list", async () => {
    const id = "conv-search-0865";
    await call("DELETE /conversations/:id", { params: { id } });
    const { items } = await call<ListResponse>("GET /conversations");
    expect(items.some((c) => c.id === id)).toBe(false);
    expect((await callError("GET /conversations/:id", { params: { id } })).status).toBe(404);
  });

  it("declares an SSE stream for the conversation route", () => {
    expect(Object.keys(handlers.streams ?? {})).toContain("GET /conversations/:id/stream");
  });
});
