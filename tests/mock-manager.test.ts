// Guards for the demo backend's manager-runs group (client/mock/manager.ts).
//
// Three things have to hold, and none of them can be checked by eyeballing a
// board that only moves once every five seconds:
//
//  1. THE SIMULATION IS A FUNCTION. Same elapsed time in, same board out; and
//     as time advances a worker never un-pushes a branch, un-opens an MR, or
//     loses a merge request it already had. `blocked` is the one detour a
//     worker may take and come back from — everything else only goes forward.
//  2. EVERY ENDPOINT EXISTS. The route list is derived from the real client
//     (client/lib/manager-api.ts) rather than restated here, so adding a call
//     there without a handler fails this test instead of failing in a browser.
//  3. `conversationRun` ANSWERS 404, NOT AN ERROR, for a conversation outside
//     any run. `managerApi.conversationRun` turns 404 into `null` and rethrows
//     anything else; a 400/500 would freeze `useRunMembership` on `undefined`
//     and hide the Promote button forever.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { handlers as manager } from "../client/mock/manager.js";
import { demoBoard, demoTimelines, DEMO_ALLOWED_MODELS, REPLAN_DELAY_MS } from "../client/mock/manager.js";
import { dispatch, matchRoute, registerGroup, resetRegistry } from "../client/mock/registry.js";
import { demoState } from "../client/mock/state.js";
import { DEMO_START, MINUTE, SECOND } from "../client/mock/clock.js";
import {
  PHASE_RANK,
  lastHeartbeatAt,
  runClockMs,
  runEpochMs,
  simulateRun,
  snapshotAt,
  type RunTimeline,
} from "../client/mock/fixtures/manager-simulation.js";
import { SEEDED_SCENARIOS } from "../client/mock/fixtures/manager-scenarios.js";
import type { BoardState, RunRecord, WorkerPhase } from "../client/lib/manager-api.js";
import type { MockRequest } from "../client/mock/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The showpiece: the one run that is mid-flight when the page loads. */
const ACTIVE_RUN = SEEDED_SCENARIOS[0];
/** The run parked on its approval card. */
const GATED_RUN = SEEDED_SCENARIOS[1];
/** The finished run. */
const COMPLETED_RUN = SEEDED_SCENARIOS[2];
/** The abandoned run. */
const CANCELLED_RUN = SEEDED_SCENARIOS[3];

function request(method: string, path: string, init: { body?: unknown; query?: string } = {}): MockRequest {
  const url = new URL(`http://demo.test/api/openhands${path}${init.query ? `?${init.query}` : ""}`);
  return {
    method,
    path,
    params: {},
    query: url.searchParams,
    body: init.body,
    headers: new Headers(),
    url,
  };
}

async function call(method: string, path: string, init: { body?: unknown; query?: string } = {}) {
  const result = await dispatch(request(method, path, init));
  return { status: result.status, body: JSON.parse(result.text) as unknown };
}

/** Reset the demo store so each test starts from the seeded scenarios. */
beforeEach(() => {
  demoState.clear();
  resetRegistry();
  registerGroup(manager);
});

// ---------------------------------------------------------------------------
// 1 — the simulation is a deterministic, monotonic function of elapsed time
// ---------------------------------------------------------------------------

/** Every scripted scenario, recompiled so the tests never share mutable state. */
function timelines(): RunTimeline[] {
  return SEEDED_SCENARIOS.map(simulateRun);
}

describe("the run simulation is a pure function of elapsed time", () => {
  it("compiles every seeded scenario", () => {
    expect(timelines()).toHaveLength(4);
    for (const timeline of timelines()) {
      expect(timeline.activity.length).toBeGreaterThan(0);
      // Ids are dense and ascending — they are the activity log's React keys.
      expect(timeline.activity.map((a) => a.id)).toEqual(
        timeline.activity.map((_, i) => i + 1),
      );
      expect(timeline.nextActivityId).toBe(timeline.activity.length + 1);
    }
  });

  it("returns an identical snapshot for the same run time", () => {
    for (const timeline of timelines()) {
      for (const runMs of [0, 90 * SECOND, 12 * MINUTE, 27.5 * MINUTE, 3 * 60 * MINUTE]) {
        expect(snapshotAt(timeline, runMs)).toEqual(snapshotAt(timeline, runMs));
      }
    }
    // …and two independent compilations agree, so nothing is captured at
    // module load beyond the scenario data itself.
    const [a] = timelines();
    const [b] = timelines();
    expect(snapshotAt(a, 25 * MINUTE)).toEqual(snapshotAt(b, 25 * MINUTE));
  });

  it("never regresses a worker's completed phase", () => {
    const rank = (phase: WorkerPhase) => PHASE_RANK[phase];
    for (const timeline of timelines()) {
      const best = new Map<string, number>();
      const mrSeen = new Map<string, number>();
      for (let runMs = 0; runMs <= 60 * MINUTE; runMs += 5 * SECOND) {
        for (const worker of snapshotAt(timeline, runMs).workers) {
          const reached = best.get(worker.task) ?? 0;
          if (worker.phase !== "blocked") {
            expect(
              rank(worker.phase),
              `${timeline.scenario.id}/${worker.task} regressed at ${runMs}ms`,
            ).toBeGreaterThanOrEqual(reached);
            best.set(worker.task, Math.max(reached, rank(worker.phase)));
          }
          const mr = mrSeen.get(worker.task);
          if (mr != null) expect(worker.mrIid).toBe(mr);
          if (worker.mrIid != null) mrSeen.set(worker.task, worker.mrIid);
        }
      }
      // The showpiece actually gets somewhere — a frozen board is not a
      // simulation.
      if (timeline.scenario.id === ACTIVE_RUN.id) {
        expect([...best.values()].every((r) => r >= rank("pr-open"))).toBe(false);
        expect(Math.max(...best.values())).toBeGreaterThanOrEqual(rank("pr-open"));
      }
    }
  });

  it("only ever grows the worker roster and the activity log", () => {
    for (const timeline of timelines()) {
      let workers = 0;
      let entries = 0;
      for (let runMs = 0; runMs <= 45 * MINUTE; runMs += 10 * SECOND) {
        const snapshot = snapshotAt(timeline, runMs);
        expect(snapshot.workers.length).toBeGreaterThanOrEqual(workers);
        expect(snapshot.activity.length).toBeGreaterThanOrEqual(entries);
        workers = snapshot.workers.length;
        entries = snapshot.activity.length;
      }
    }
  });

  it("advances the showpiece run while the visitor watches", () => {
    const [timeline] = timelines();
    const at = (runMs: number) =>
      Object.fromEntries(snapshotAt(timeline, runMs).workers.map((w) => [w.task, w.phase]));
    const load = at(ACTIVE_RUN.startedAtRunMs);
    const later = at(ACTIVE_RUN.startedAtRunMs + 7 * MINUTE);
    expect(load).not.toEqual(later);
    // Wave 2 does not exist yet on arrival, and does six minutes later.
    expect(load["search-ranking"]).toBeUndefined();
    expect(later["search-ranking"]).toBe("working");
    expect(snapshotAt(timeline, ACTIVE_RUN.startedAtRunMs).currentWave).toBe(1);
    expect(snapshotAt(timeline, ACTIVE_RUN.startedAtRunMs + 7 * MINUTE).currentWave).toBe(2);
  });

  it("goes quiet where a scenario says so — the only source of `stale`", () => {
    const [timeline] = timelines();
    const silent = timeline.workers.find((w) => w.task === "stock-badges");
    if (!silent) throw new Error("expected the stock-badges worker");
    // Inside its quiet window the last heartbeat is pinned to its start.
    expect(lastHeartbeatAt(silent, 21 * MINUTE)).toBe(lastHeartbeatAt(silent, 10 * MINUTE));
    // Beyond it, heartbeats resume.
    expect(lastHeartbeatAt(silent, 23 * MINUTE)).toBeGreaterThan(
      lastHeartbeatAt(silent, 21 * MINUTE) ?? 0,
    );
  });

  it("maps demo time onto run time, pausing at the approval gate", () => {
    const [active, gated, completed] = timelines();
    // A run already in flight advances one-for-one with the page's clock.
    expect(runClockMs(active, { elapsedMs: 0 })).toBe(ACTIVE_RUN.startedAtRunMs);
    expect(runClockMs(active, { elapsedMs: 90 * SECOND })).toBe(
      ACTIVE_RUN.startedAtRunMs + 90 * SECOND,
    );
    // A gated run stands still until the visitor approves, then resumes from
    // the gate — not from wherever the page happened to be.
    expect(runClockMs(gated, { elapsedMs: 10 * MINUTE })).toBe((GATED_RUN.gateAtRunMs ?? 0) - 1);
    expect(
      runClockMs(gated, { elapsedMs: 10 * MINUTE + 30 * SECOND, approvedAtElapsedMs: 10 * MINUTE }),
    ).toBe((GATED_RUN.gateAtRunMs ?? 0) + 30 * SECOND);
    // A finished run is frozen, and a cancel freezes any run.
    expect(runClockMs(completed, { elapsedMs: 99 * MINUTE })).toBe(COMPLETED_RUN.frozenAtRunMs);
    expect(runClockMs(active, { elapsedMs: 99 * MINUTE, frozenAtRunMs: 4 * MINUTE })).toBe(
      4 * MINUTE,
    );
  });

  it("keeps a run's epoch fixed so past timestamps never drift", () => {
    const [active] = timelines();
    const a = runEpochMs(active, { elapsedMs: 0 }, DEMO_START);
    const b = runEpochMs(active, { elapsedMs: 7 * MINUTE }, DEMO_START);
    expect(a).toBe(b);
    expect(a).toBe(DEMO_START - ACTIVE_RUN.startedAtRunMs);
  });
});

// ---------------------------------------------------------------------------
// 2 — every endpoint the client calls has a handler
// ---------------------------------------------------------------------------

/**
 * Route keys the real client actually fetches, parsed out of
 * client/lib/manager-api.ts. Derived rather than restated: a new endpoint in
 * `managerApi` with no handler here has to fail the build, which a hand-kept
 * list would not do.
 */
function routesUsedByTheClient(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../client/lib/manager-api.ts", import.meta.url)),
    "utf8",
  );
  const keys = new Set<string>();
  for (const match of source.matchAll(/fetch\(\s*`\$\{BASE\}([^`]*)`([^)]*)\)/g)) {
    const path = match[1]
      .split("?")[0]
      .replace(/\$\{[^}]*\}/g, ":param")
      .replace(/\/$/, "");
    const method = /method:\s*"([A-Z]+)"/.exec(match[2])?.[1] ?? "GET";
    keys.add(`${method} /manager${path}`);
  }
  return [...keys].sort();
}

describe("route coverage", () => {
  it("finds every managerApi call in the client", () => {
    // Ten endpoints today; the count is asserted so a regex that silently
    // stops matching cannot make the coverage test vacuous.
    expect(routesUsedByTheClient()).toHaveLength(10);
  });

  it("registers a handler for each of them", () => {
    for (const key of routesUsedByTheClient()) {
      const [method, pattern] = key.split(" ") as [string, string];
      const path = pattern.replace(/:param/g, "demo-id");
      expect(matchRoute(method, path), `no demo handler for ${key}`).not.toBeNull();
      expect(matchRoute(method, path)?.group).toBe("manager");
    }
  });

  it("claims nothing outside /manager/", () => {
    for (const key of Object.keys(manager.routes)) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/manager(\/|$)/);
    }
    expect(manager.streams ?? {}).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3 — the endpoints behave the way the pages expect
// ---------------------------------------------------------------------------

describe("GET /manager/runs", () => {
  it("lists the seeded runs newest first, across every status", async () => {
    const { status, body } = await call("GET", "/manager/runs");
    expect(status).toBe(200);
    const items = (body as { items: RunRecord[] }).items;
    expect(items).toHaveLength(4);
    const times = items.map((r) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(new Set(items.map((r) => r.status))).toEqual(
      new Set(["active", "plan-ready", "completed", "cancelled"]),
    );
    // Everything the list row renders is populated.
    for (const run of items) {
      expect(run.projectPath).toBeTruthy();
      expect(run.plan?.waves.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(run.updatedAt))).toBe(true);
    }
  });

  it("stamps timestamps relative to the page load, never absolute dates", async () => {
    const { body } = await call("GET", "/manager/runs");
    for (const run of (body as { items: RunRecord[] }).items) {
      const created = Date.parse(run.createdAt);
      expect(created).toBeLessThanOrEqual(DEMO_START + 60 * SECOND);
      expect(created).toBeGreaterThan(DEMO_START - 3 * 60 * MINUTE);
    }
  });
});

describe("GET /manager/runs/:id", () => {
  it("404s for an unknown run", async () => {
    const { status, body } = await call("GET", "/manager/runs/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "run not found" });
  });

  it("serves a board the page can render end to end", async () => {
    const { status, body } = await call("GET", `/manager/runs/${ACTIVE_RUN.id}`);
    expect(status).toBe(200);
    const board = body as BoardState;
    expect(board.run.id).toBe(ACTIVE_RUN.id);
    expect(board.run.status).toBe("active");
    expect(board.defaultWorkerModel).toBeTruthy();
    expect(board.workers.length).toBeGreaterThanOrEqual(4);
    expect(board.activity.length).toBeGreaterThan(0);
    for (const worker of board.workers) {
      expect(worker.runId).toBe(ACTIVE_RUN.id);
      expect(worker.model).toBeTruthy();
      expect(worker.branch).toMatch(/^[a-z]+\//);
      expect(worker.ageSeconds == null || worker.ageSeconds >= 0).toBe(true);
      if (worker.mrIid != null) expect(worker.mrUrl).toContain(`/${worker.mrIid}`);
    }
    // Worst-first: nothing sorts above a blocked or stale worker.
    const firstHealthy = board.workers.findIndex((w) => w.phase !== "blocked" && !w.stale);
    const problems = board.workers.filter((w) => w.phase === "blocked" || w.stale).length;
    expect(firstHealthy === -1 || firstHealthy === problems).toBe(true);
  });

  it("shows the showpiece mid-flight: an open MR and a silent worker", () => {
    const board = demoBoard(ACTIVE_RUN.id, DEMO_START);
    const byTask = Object.fromEntries(board.workers.map((w) => [w.task, w]));
    expect(byTask["catalog-filters"].phase).toBe("pr-open");
    expect(byTask["catalog-filters"].mrIid).toBe(104);
    expect(byTask["catalog-filters"].ciStatus).toBe("success");
    expect(byTask["stock-badges"].stale).toBe(true);
    expect(byTask["price-rounding"].phase).toBe("working");
    expect(byTask["price-rounding"].stale).toBe(false);
  });

  it("keeps advancing on the board's own 5s poll", () => {
    const before = demoBoard(ACTIVE_RUN.id, DEMO_START);
    const after = demoBoard(ACTIVE_RUN.id, DEMO_START + 6 * MINUTE);
    expect(after.workers.length).toBeGreaterThan(before.workers.length);
    expect(after.activity.length).toBeGreaterThan(before.activity.length);
    expect(after.run.currentWave).toBeGreaterThan(before.run.currentWave);
  });

  it("freezes a completed run and marks nothing stale on it", () => {
    const a = demoBoard(COMPLETED_RUN.id, DEMO_START);
    const b = demoBoard(COMPLETED_RUN.id, DEMO_START + 20 * MINUTE);
    expect(a.run.status).toBe("completed");
    expect(b.run.status).toBe("completed");
    expect(b.workers.map((w) => w.phase)).toEqual(a.workers.map((w) => w.phase));
    expect(b.workers.every((w) => w.phase === "done")).toBe(true);
    expect(b.workers.some((w) => w.stale)).toBe(false);
    expect(a.run.notes[0]).toMatch(/^SUMMARY: /);
  });

  it("keeps the cancelled run's evidence intact", () => {
    const board = demoBoard(CANCELLED_RUN.id, DEMO_START);
    expect(board.run.status).toBe("cancelled");
    expect(board.workers.some((w) => w.phase === "blocked")).toBe(true);
    expect(board.run.notes.some((n) => n.startsWith("MANAGER REQUESTS HUMAN"))).toBe(true);
  });
});

describe("POST /manager/runs/:id/approve", () => {
  it("launches wave 1 and then lets it progress", async () => {
    const { status, body } = await call("POST", `/manager/runs/${GATED_RUN.id}/approve`);
    expect(status).toBe(200);
    const res = body as { result: { ok: boolean; message: string }; run: RunRecord };
    expect(res.result.ok).toBe(true);
    expect(res.result.message).toMatch(/^wave 1 launched: /);
    expect(res.run.status).toBe("active");
    expect(res.run.currentWave).toBe(1);

    const now = Date.now();
    expect(demoBoard(GATED_RUN.id, now).workers.length).toBeGreaterThan(0);
    const later = demoBoard(GATED_RUN.id, now + 9 * MINUTE);
    expect(later.workers.some((w) => w.phase === "pr-open")).toBe(true);
    expect(later.activity.some((a) => a.message === "plan approved")).toBe(true);
  });

  it("409s when there is no pending plan", async () => {
    const { status, body } = await call("POST", `/manager/runs/${ACTIVE_RUN.id}/approve`);
    expect(status).toBe(409);
    expect((body as { error: string }).error).toBe("run is active; nothing to approve");
  });
});

describe("POST /manager/runs/:id/reject-plan", () => {
  it("returns the run to planning and re-proposes on its own", async () => {
    const { status, body } = await call("POST", `/manager/runs/${GATED_RUN.id}/reject-plan`, {
      body: { reason: "wave 2 touches the same migrations as wave 1" },
    });
    expect(status).toBe(200);
    const res = body as { ok: boolean; message: string; run: RunRecord };
    expect(res.ok).toBe(true);
    expect(res.run.status).toBe("planning");
    expect(res.run.plan).toBeNull();

    const now = Date.now();
    expect(demoBoard(GATED_RUN.id, now).run.status).toBe("planning");
    const revised = demoBoard(GATED_RUN.id, now + REPLAN_DELAY_MS + SECOND);
    expect(revised.run.status).toBe("plan-ready");
    expect(revised.run.plan?.waves.length).toBeGreaterThan(0);
    expect(revised.activity.some((a) => a.message.startsWith("plan rejected:"))).toBe(true);
  });

  it("409s when nothing is pending", async () => {
    const { status } = await call("POST", `/manager/runs/${COMPLETED_RUN.id}/reject-plan`, {
      body: { reason: "" },
    });
    expect(status).toBe(409);
  });
});

describe("POST /manager/runs/:id/nudge", () => {
  it("logs the nudge, switches the model and clears `stale`", async () => {
    const before = demoBoard(ACTIVE_RUN.id);
    expect(before.workers.find((w) => w.task === "stock-badges")?.stale).toBe(true);

    const { status, body } = await call("POST", `/manager/runs/${ACTIVE_RUN.id}/nudge`, {
      body: {
        task: "stock-badges",
        message: "post your current diff",
        model: DEMO_ALLOWED_MODELS[0],
      },
    });
    expect(status).toBe(200);
    const res = body as { ok: boolean; message: string };
    expect(res.ok).toBe(true);
    expect(res.message).toContain("nudge delivered to stock-badges (human)");
    expect(res.message).toContain(DEMO_ALLOWED_MODELS[0]);

    const after = demoBoard(ACTIVE_RUN.id);
    const worker = after.workers.find((w) => w.task === "stock-badges");
    expect(worker?.stale).toBe(false);
    expect(worker?.model).toBe(DEMO_ALLOWED_MODELS[0]);
    expect(after.activity.at(-1)?.actor).toBe("executor");
  });

  it("unblocks a blocked worker", async () => {
    const blocked = demoBoard(CANCELLED_RUN.id).workers.find((w) => w.phase === "blocked");
    if (!blocked) throw new Error("expected a blocked worker to nudge");
    await call("POST", `/manager/runs/${CANCELLED_RUN.id}/nudge`, {
      body: { task: blocked.task, message: "try the other key order" },
    });
    const after = demoBoard(CANCELLED_RUN.id).workers.find((w) => w.task === blocked.task);
    expect(after?.phase).toBe("working");
    expect(after?.blockReason).toBeNull();
  });

  it("rejects an unknown worker, a missing message and an unlisted model", async () => {
    const missing = await call("POST", `/manager/runs/${ACTIVE_RUN.id}/nudge`, {
      body: { task: "stock-badges" },
    });
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toBe("task and message are required");

    const unknown = await call("POST", `/manager/runs/${ACTIVE_RUN.id}/nudge`, {
      body: { task: "no-such-worker", message: "hello" },
    });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { error: string }).error).toBe('no worker "no-such-worker" in run');

    const model = await call("POST", `/manager/runs/${ACTIVE_RUN.id}/nudge`, {
      body: { task: "stock-badges", message: "hello", model: "acme/not-a-model" },
    });
    expect(model.status).toBe(400);
    expect((model.body as { error: string }).error).toContain("not in the configured allowlist");
  });
});

describe("POST /manager/runs/:id/cancel", () => {
  it("freezes the run where it stood", async () => {
    const { status, body } = await call("POST", `/manager/runs/${ACTIVE_RUN.id}/cancel`);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, message: "run cancelled" });

    const now = Date.now();
    const at = demoBoard(ACTIVE_RUN.id, now);
    const later = demoBoard(ACTIVE_RUN.id, now + 15 * MINUTE);
    expect(at.run.status).toBe("cancelled");
    expect(later.run.status).toBe("cancelled");
    expect(later.workers.map((w) => w.phase)).toEqual(at.workers.map((w) => w.phase));
    expect(at.activity.at(-1)?.message).toBe("run cancelled");
  });

  it("404s for an unknown run", async () => {
    const { status } = await call("POST", "/manager/runs/nope/cancel");
    expect(status).toBe(404);
  });
});

describe("POST /manager/runs — promoting a conversation", () => {
  const conversationId = "11111111-2222-4333-8444-555555555555";

  it("creates a planning run that proposes a plan on its own", async () => {
    const { status, body } = await call("POST", "/manager/runs", {
      body: { managerConversationId: conversationId },
    });
    expect(status).toBe(201);
    const run = body as RunRecord;
    expect(run.status).toBe("planning");
    expect(run.managerConversationId).toBe(conversationId);
    expect(run.repoInferred).toBe(true);
    expect(demoTimelines()).toHaveLength(5);

    // The manager's plan lands without anybody polling anything into being.
    const ready = demoBoard(run.id, Date.now() + 40 * SECOND);
    expect(ready.run.status).toBe("plan-ready");
    expect(ready.run.plan?.waves.length).toBeGreaterThan(0);
  });

  it("makes the promoted conversation the run's manager", async () => {
    const { body } = await call("POST", "/manager/runs", {
      body: { managerConversationId: conversationId },
    });
    const run = body as RunRecord;
    const membership = await call("GET", `/manager/conversations/${conversationId}/run`);
    expect(membership.status).toBe(200);
    expect(membership.body).toMatchObject({ runId: run.id, role: "manager" });
  });

  it("refuses a conversation that already drives a live run", async () => {
    const { status, body } = await call("POST", "/manager/runs", {
      body: { managerConversationId: ACTIVE_RUN.managerConversationId },
    });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("already the manager of run");
  });

  it("allows re-promoting a conversation whose run ended", async () => {
    const { status } = await call("POST", "/manager/runs", {
      body: { managerConversationId: COMPLETED_RUN.managerConversationId },
    });
    expect(status).toBe(201);
  });

  it("requires a conversation to promote", async () => {
    const { status, body } = await call("POST", "/manager/runs", { body: {} });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toContain("managerConversationId is required");
  });
});

describe("GET /manager/conversations/:id/run", () => {
  it("404s — not 200-with-null and not a 4xx error — for an outsider", async () => {
    const { status, body } = await call(
      "GET",
      "/manager/conversations/00000000-0000-4000-8000-000000000000/run",
    );
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("not part of a run");
  });

  it("tolerates ids owned by another handler group", async () => {
    for (const id of ["", "not-a-uuid", "conv_42", "🙂"]) {
      const { status } = await call("GET", `/manager/conversations/${id || "empty"}/run`);
      expect(status).toBe(404);
    }
  });

  it("is what `managerApi.conversationRun` turns into null", async () => {
    // The client's contract, exercised through its own code path: 404 → null,
    // anything else → throw. Patching fetch is the only way to prove it.
    const { managerApi } = await import("../client/lib/manager-api.js");
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://demo.test");
      const result = await dispatch({
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname.replace("/api/openhands", ""),
        params: {},
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(),
        url,
      });
      return new Response(result.text, { status: result.status, headers: result.headers });
    }) as typeof fetch;
    try {
      await expect(
        managerApi.conversationRun("00000000-0000-4000-8000-000000000000"),
      ).resolves.toBeNull();
      const known = await managerApi.conversationRun(ACTIVE_RUN.managerConversationId);
      expect(known).toMatchObject({ runId: ACTIVE_RUN.id, role: "manager", status: "active" });
      expect(known?.title).toBe(ACTIVE_RUN.title);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports a worker's task so the banner can name it", async () => {
    const worker = demoBoard(ACTIVE_RUN.id).workers[0];
    if (!worker.conversationId) throw new Error("expected a launched worker");
    const { status, body } = await call(
      "GET",
      `/manager/conversations/${worker.conversationId}/run`,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ runId: ACTIVE_RUN.id, role: "worker", task: worker.task });
  });
});

describe("GET /manager/conversation-roles", () => {
  it("agrees with the boards it is derived from", async () => {
    const { status, body } = await call("GET", "/manager/conversation-roles");
    expect(status).toBe(200);
    const roles = (body as { roles: Record<string, { role: string; runId: string; task?: string }> })
      .roles;
    for (const scenario of SEEDED_SCENARIOS) {
      expect(roles[scenario.managerConversationId]).toEqual({
        role: "manager",
        runId: scenario.id,
      });
      for (const worker of demoBoard(scenario.id).workers) {
        if (!worker.conversationId) continue;
        expect(roles[worker.conversationId]).toEqual({
          role: "worker",
          runId: scenario.id,
          task: worker.task,
        });
      }
    }
    // Exactly one manager per run — `groupConversationsByRun` assumes it.
    const managers = Object.values(roles).filter((r) => r.role === "manager");
    expect(new Set(managers.map((r) => r.runId)).size).toBe(managers.length);
  });

  it("has no role for a conversation this group does not own", async () => {
    const { body } = await call("GET", "/manager/conversation-roles");
    const roles = (body as { roles: Record<string, unknown> }).roles;
    expect(roles["00000000-0000-4000-8000-000000000000"]).toBeUndefined();
  });
});

describe("GET /manager/repo-stats", () => {
  it("advises on the shared-pod clone footprint", async () => {
    const { status, body } = await call("GET", "/manager/repo-stats", {
      query: `repoUrl=${encodeURIComponent(ACTIVE_RUN.repoUrl ?? "")}&workers=8`,
    });
    expect(status).toBe(200);
    const stats = body as { projectPath: string; repoSizeBytes: number; projectedBytes: number; level: string };
    expect(stats.projectPath).toBe(ACTIVE_RUN.projectPath);
    expect(stats.projectedBytes).toBe(stats.repoSizeBytes * 8);
    expect(["info", "warn", "confirm"]).toContain(stats.level);
  });

  it("reports `unknown` for a repo the demo has no size for", async () => {
    const { body } = await call("GET", "/manager/repo-stats", {
      query: "repoUrl=https%3A%2F%2Fgitlab.com%2Fexample-org%2Funseen-repo&workers=4",
    });
    expect(body).toMatchObject({ level: "unknown", repoSizeBytes: null, projectedBytes: null });
  });

  it("400s on a repoUrl it cannot resolve", async () => {
    const { status, body } = await call("GET", "/manager/repo-stats", {
      query: "repoUrl=not-a-url&workers=4",
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("invalid repoUrl");
  });
});
