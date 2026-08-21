// client/mock/timeline.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// The scripted agent run — one bug fix, start to finish, on a clock.
// ═══════════════════════════════════════════════════════════════════════════
//
// The demo has no agent. What it has instead is this: a flat, ordered list of
// the raw events an agent-server WOULD have written to the event log, each
// stamped with how long into the run it appeared. `timelineAt()` slices that
// list at a point in time and reports the conversation's `execution_status`
// there, so ./conversations.ts can answer `GET /conversations/:id/events`
// without any push machinery — the transcript's own 3s poll (Conversation.tsx
// ~:914) animates the story for free.
//
// Everything here is a pure function of (elapsed ms, origin epoch). No timers,
// no globals, no `Date.now()` — which is what makes the whole arc unit-testable
// in tests/mock-conversations.test.ts, including the parts a visitor only
// reaches by clicking.
//
// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------
//
// A plan-mode run against a fictional `ledger-service`:
//
//   1. The user reports duplicate ledger entries on retried payments.
//   2. The agent reads — git log, grep, two file views. Plan mode's
//      LLMSecurityAnalyzer scores these LOW, so nothing is held up.
//   3. It writes a task list and posts a plan.
//   4. It emits three writes in one LLM response, scored MEDIUM. The
//      ConfirmRisky policy parks the run at `waiting_for_confirmation`.
//   5. The user approves → the run resumes, the edits land, the tests run.
//   6. FinishAction, `execution_status: "finished"`.
//
// ---------------------------------------------------------------------------
// Two honest simplifications, stated up front
// ---------------------------------------------------------------------------
//
//  · A real ConfirmRisky policy re-gates EVERY later MEDIUM batch, not just
//    the first. The script keeps its post-approval work (a test run, a
//    diffstat) read-only and LOW-risk, so one approval genuinely carries the
//    run to the end. That is the flow the product is designed around; it is
//    not a claim that one approval disarms the policy.
//  · Rejecting parks the run at `paused` with the write still pending, rather
//    than scripting the agent's reaction to a rejection. Pressing Run re-arms
//    the gate. See ./conversations.ts.
//
// ---------------------------------------------------------------------------
// What is invented and what is not
// ---------------------------------------------------------------------------
//
// The repository, the branch, the file paths, the bug and the agent's prose
// are fiction (see ./fixtures/world.ts). The event SHAPES are not: `summary`,
// `reasoning_content`, `thinking_blocks`, `responses_reasoning_item`,
// `security_risk`, `llm_response_id` and `tool_call` all sit at the top level
// of an ActionEvent exactly as agent-server 1.40.x writes them (the shapes in
// tests/transcript-details.test.ts were captured from a live conversation).
// Tool ids (`terminal`, `file_editor`, `task_tracker`, `finish`) come from the
// TOOL_DESCRIPTIONS map in server/openhands/setup.ts, and tool OUTPUT is
// written the way the tools themselves phrase it.
import type { RawOpenHandsEvent, TaskItem } from "../lib/events.js";
import {
  actionEvent,
  messageEvent,
  observationEvent,
  statusEvent,
  type ActionSpec,
  type MessageSpec,
  type ObservationSpec,
} from "./fixtures/events.js";
import { LEDGER } from "./fixtures/world.js";

// ── Pacing ───────────────────────────────────────────────────────────────────

/**
 * Playback speed. Every offset below is authored in "story seconds" and
 * multiplied by this, so the whole arc is tunable from one place: 1 runs the
 * script in ~58s of demo time plus however long the visitor spends at the
 * confirmation gate, which lands the full experience in the 60–90s a demo can
 * hold attention for. Raise it to slow the story down for a walkthrough.
 */
export const PACE = 1;

/** Story seconds → milliseconds of scripted run time. */
function s(seconds: number): number {
  return Math.round(seconds * 1_000 * PACE);
}

// ── Statuses ─────────────────────────────────────────────────────────────────

/**
 * The `execution_status` values this script uses. The full upstream set is
 * wider (`idle`, `error`, `stuck`); those belong to the seeded conversations
 * in ./fixtures/seeds.ts, not to the happy path.
 */
export type ScriptedStatus = "running" | "waiting_for_confirmation" | "finished";

// ── The fictional workspace ──────────────────────────────────────────────────

const RETRY_QUEUE = `${LEDGER.dir}/src/ledger/retryQueue.ts`;
const POST_ENTRY = `${LEDGER.dir}/src/ledger/postEntry.ts`;
const RETRY_JOB = `${LEDGER.dir}/src/payments/retryJob.ts`;
const RETRY_QUEUE_TEST = `${LEDGER.dir}/src/ledger/retryQueue.test.ts`;

/** Branch the scripted run works on. Referenced by the final summary. */
export const SCRIPT_BRANCH = "fix/duplicate-ledger-entries";

/** Title the hub and the browser tab show for the scripted conversation. */
export const SCRIPT_TITLE = "Duplicate ledger entries on payment retry";

// Multi-line strings below are template literals, not `[…].join("\n")`.
// A top-level call is a side effect to Rollup, and one of those anywhere in
// client/mock/ pins the whole demo backend into the self-hosted bundle (see
// the header of ./install.ts). That is also why the script itself is built
// lazily at the bottom of this file rather than as a module-level array.

/** The task the visitor is watching the agent work on. */
export const SCRIPT_TASK = `Retried payments are posting to the ledger twice. It looks like the retry path
drops the idempotency key, so the second attempt is treated as a brand-new entry.
Find the cause in ledger-service and fix it, with a regression test.`;

// ── Event builders ───────────────────────────────────────────────────────────
//
// Thin curried wrappers over ./fixtures/events.ts: the script declares WHEN an
// event lands, the builder is handed the timestamp for it. Keeping the shapes
// in one shared module is what stops the scripted run and the seeded
// conversations from drifting apart.

type Build = (timestamp: string) => RawOpenHandsEvent;

function action(spec: Omit<ActionSpec, "timestamp">): Build {
  return (timestamp) => actionEvent({ ...spec, timestamp });
}

function observation(spec: Omit<ObservationSpec, "timestamp">): Build {
  return (timestamp) => observationEvent({ ...spec, timestamp });
}

function message(spec: Omit<MessageSpec, "timestamp">): Build {
  return (timestamp) => messageEvent({ ...spec, timestamp });
}

function status(id: string, value: ScriptedStatus): Build {
  return (timestamp) => statusEvent(id, timestamp, value);
}

// ── The task list, snapshot by snapshot ──────────────────────────────────────
//
// The pinned task list renders the LAST snapshot in the transcript, so each
// task_tracker call carries the whole plan at that moment, not a delta.

function plan(states: ReadonlyArray<TaskItem["status"]>): TaskItem[] {
  const titles = [
    "Trace the ledger posting path",
    "Find where the retry drops the idempotency key",
    "Reuse the original key when replaying a payment",
    "Cover the replay path with a regression test",
  ];
  return titles.map((title, i) => ({ title, status: states[i] }));
}

// ── Tool output ──────────────────────────────────────────────────────────────

const GIT_LOG_OUTPUT = `9f3c1ab Add exponential backoff to the payment retry worker
4be07d2 Extract postEntry from the payment handler
1c88e40 Log the settlement id on every ledger write
0a45f19 Bump the store client to 3.2.0
77d2b6c Fix timezone handling in the daily rollup`;

const GREP_OUTPUT = `src/ledger/postEntry.ts:34:  idempotencyKey: string;
src/ledger/postEntry.ts:53:  const existing = await store.findByIdempotencyKey(input.idempotencyKey);
src/ledger/retryQueue.ts:12:import { randomUUID } from "node:crypto";
src/ledger/retryQueue.ts:43:    idempotencyKey: randomUUID(),
src/payments/handler.ts:96:    idempotencyKey: request.idempotencyKey,`;

// The file editor's `view` command answers with `cat -n` output under this
// header — the phrasing is the tool's, not ours.
const POST_ENTRY_VIEW = `Here's the result of running \`cat -n\` on ${POST_ENTRY}:
    52\texport async function postEntry(input: PostEntryInput): Promise<LedgerEntry> {
    53\t  const existing = await store.findByIdempotencyKey(input.idempotencyKey);
    54\t  if (existing) return existing;
    55\t
    56\t  return store.insert({
    57\t    accountId: input.accountId,
    58\t    amountMinor: input.amountMinor,
    59\t    idempotencyKey: input.idempotencyKey,
    60\t  });
    61\t}`;

const RETRY_QUEUE_VIEW = `Here's the result of running \`cat -n\` on ${RETRY_QUEUE}:
    36\texport async function replayFailedPayment(job: RetryJob): Promise<void> {
    37\t  const payment = await payments.load(job.paymentId);
    38\t
    39\t  await postEntry({
    40\t    accountId: payment.accountId,
    41\t    amountMinor: payment.amountMinor,
    42\t    // TODO: carry the idempotency key through
    43\t    idempotencyKey: randomUUID(),
    44\t  });
    45\t}`;

const TEST_OUTPUT = `> ledger-service@2.4.0 test
> vitest run ledger

 ✓ src/ledger/postEntry.test.ts (9 tests) 41ms
 ✓ src/ledger/retryQueue.test.ts (4 tests) 63ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Duration  1.12s`;

const DIFFSTAT_OUTPUT = ` src/ledger/retryQueue.ts      |  8 ++++----
 src/ledger/retryQueue.test.ts | 52 ++++++++++++++++++++++++++++++++++
 src/payments/retryJob.ts      |  3 ++-
 3 files changed, 58 insertions(+), 5 deletions(-)`;

// ── Agent prose ──────────────────────────────────────────────────────────────

const PLAN_MESSAGE = `**Cause.** \`replayFailedPayment\` in \`src/ledger/retryQueue.ts\` mints a fresh
\`randomUUID()\` for every replay, so the de-duplication guard in \`postEntry\` —
which looks the entry up by idempotency key — never sees the original attempt
and inserts a second row. The guard itself is correct; it is being handed the
wrong key.

**Plan**

1. Persist the payment's original idempotency key on the retry job, and pass it
   through in \`replayFailedPayment\` instead of generating a new one.
2. Keep \`randomUUID()\` only as the fallback for jobs enqueued before the field
   existed, so the queue drains without a migration.
3. Add a regression test that replays a payment twice and asserts a single
   ledger entry.

The first edit is a write, so it will wait for your approval before it lands.`;

/** The FinishAction summary — also what `GET /agent_final_response` returns. */
export const SCRIPT_FINAL_RESPONSE = `Fixed. \`replayFailedPayment\` now reuses the payment's original idempotency key,
so the guard in \`postEntry\` finds the first attempt and returns it instead of
inserting a second row. \`randomUUID()\` survives only as the fallback for jobs
enqueued before the field existed, so the queue drains without a migration.

Changed:

- \`src/ledger/retryQueue.ts\` — pass \`job.idempotencyKey\` through to \`postEntry\`
- \`src/payments/retryJob.ts\` — persist the key on the job
- \`src/ledger/retryQueue.test.ts\` — new: replaying a payment twice posts one entry

\`npm test -- ledger\` is green (13 tests). The work is on
\`${SCRIPT_BRANCH}\`; nothing has been pushed.`;

// ── The script ───────────────────────────────────────────────────────────────

interface Step {
  /** Milliseconds into the run at which this event appears. */
  at: number;
  build: (timestamp: string) => RawOpenHandsEvent;
  /**
   * Part of the confirmation gate: the park and the resume that brackets it.
   * A NeverConfirm run never stops for a MEDIUM action, so if plan mode is
   * switched off BEFORE the gate would have fired, these two status
   * transitions never happened and must not appear as separators either.
   */
  gate?: true;
}

/** The LLM response each batch of actions came from. */
const R = {
  survey: "resp-01",
  read: "resp-02",
  plan: "resp-03",
  write: "resp-04",
  verify: "resp-05",
  finish: "resp-06",
} as const;

/** Story second at which the write gate fires; the end of act one. */
const GATE_AT_SECONDS = 33;

/** Story second at which the last event lands. */
const SCRIPT_END_SECONDS = 58;

/**
 * Milliseconds of scripted run time at which the run parks for approval.
 * Until the visitor approves, the clock is clamped here.
 */
export const GATE_AT_MS = GATE_AT_SECONDS * 1_000 * PACE;

/** Scripted run time at which the last event lands. */
export const SCRIPT_END_MS = SCRIPT_END_SECONDS * 1_000 * PACE;

/**
 * Act one: research, a plan, and three writes that park the run.
 *
 * Read this as the story. Offsets are story seconds; the gate is the last
 * entry, and nothing after it plays until the visitor approves.
 */
function actOne(): Step[] {
  return [
    {
      at: s(0),
      build: message({ id: "sc-m1", role: "user", text: SCRIPT_TASK, skills: ["repo-conventions"] }),
    },
    { at: s(1), build: status("sc-s1", "running") },

    {
      at: s(3),
      build: action({
        id: "sc-a1",
        tool: "terminal",
        response: R.survey,
        summary: "Look at recent history around the ledger posting path",
        thought: "Let me start with the change history — a duplicate-posting bug that showed up recently is usually a regression in the retry path rather than in the ledger core.",
        reasoning: {
          provider: "openai",
          summary: [
            "Duplicate rows with a de-duplication guard in place normally means the guard is keyed on something that changes between attempts. Check what changed recently before reading any code.",
          ],
        },
        action: { kind: "TerminalAction", command: "git log --oneline -5 -- src/ledger" },
      }),
    },
    {
      at: s(6),
      build: observation({ id: "sc-o1", of: "sc-a1", tool: "terminal", kind: "TerminalObservation", text: GIT_LOG_OUTPUT }),
    },

    {
      at: s(8.5),
      build: action({
        id: "sc-a2",
        tool: "terminal",
        response: R.read,
        summary: "Find every read and write of the idempotency key",
        action: { kind: "TerminalAction", command: "grep -rn \"idempotencyKey\" src/" },
      }),
    },
    {
      at: s(10.5),
      build: observation({ id: "sc-o2", of: "sc-a2", tool: "terminal", kind: "TerminalObservation", text: GREP_OUTPUT }),
    },

    {
      at: s(13),
      build: action({
        id: "sc-a3",
        tool: "file_editor",
        response: R.read,
        summary: "Read the de-duplication guard in postEntry",
        action: { kind: "FileEditorAction", command: "view", path: POST_ENTRY, view_range: [52, 61] },
      }),
    },
    {
      at: s(15),
      build: observation({ id: "sc-o3", of: "sc-a3", tool: "file_editor", kind: "FileEditorObservation", text: POST_ENTRY_VIEW }),
    },

    {
      at: s(17.5),
      build: action({
        id: "sc-a4",
        tool: "file_editor",
        response: R.read,
        summary: "Read the replay path that calls postEntry",
        action: { kind: "FileEditorAction", command: "view", path: RETRY_QUEUE, view_range: [36, 45] },
      }),
    },
    {
      at: s(19.5),
      build: observation({ id: "sc-o4", of: "sc-a4", tool: "file_editor", kind: "FileEditorObservation", text: RETRY_QUEUE_VIEW }),
    },

    {
      at: s(22),
      build: action({
        id: "sc-a5",
        tool: "task_tracker",
        response: R.plan,
        summary: "Write down the plan",
        thought: "That is the bug: the guard is fine, the key it is handed is not. Here is what I intend to do.",
        action: { kind: "TaskTrackerAction", command: "plan", task_list: plan(["done", "done", "in_progress", "todo"]) },
      }),
    },
    {
      at: s(23),
      build: observation({
        id: "sc-o5",
        of: "sc-a5",
        tool: "task_tracker",
        kind: "TaskTrackerObservation",
        text: "Task list updated.",
        taskList: plan(["done", "done", "in_progress", "todo"]),
      }),
    },

    { at: s(25), build: message({ id: "sc-m2", role: "assistant", text: PLAN_MESSAGE }) },

    // One LLM response, three writes. The security analyzer scores them MEDIUM,
    // so ConfirmRisky holds the whole batch — which is why all three chips are
    // on screen, pending, while the confirmation strip is up.
    {
      at: s(31),
      build: action({
        id: "sc-a6",
        tool: "file_editor",
        response: R.write,
        risk: "MEDIUM",
        summary: "Reuse the payment's original idempotency key when replaying",
        thought: "Implementing the plan now. These are writes, so they need your approval before they land.",
        reasoning: {
          provider: "anthropic",
          thinking: "Keep randomUUID() as a fallback rather than deleting it — jobs already sitting in the queue were enqueued without the field, and failing them would be worse than the duplicate.",
        },
        action: {
          kind: "FileEditorAction",
          command: "str_replace",
          path: RETRY_QUEUE,
          old_str: "    // TODO: carry the idempotency key through\n    idempotencyKey: randomUUID(),",
          new_str: "    idempotencyKey: job.idempotencyKey ?? randomUUID(),",
        },
      }),
    },
    {
      at: s(31.4),
      build: action({
        id: "sc-a7",
        tool: "file_editor",
        response: R.write,
        risk: "MEDIUM",
        summary: "Persist the idempotency key on the retry job",
        action: {
          kind: "FileEditorAction",
          command: "str_replace",
          path: RETRY_JOB,
          old_str: "export interface RetryJob {\n  paymentId: string;",
          new_str: "export interface RetryJob {\n  paymentId: string;\n  /** Key of the original attempt; absent on jobs enqueued before 2.4.0. */\n  idempotencyKey?: string;",
        },
      }),
    },
    {
      at: s(31.8),
      build: action({
        id: "sc-a8",
        tool: "file_editor",
        response: R.write,
        risk: "MEDIUM",
        summary: "Add a regression test for a replayed payment",
        action: {
          kind: "FileEditorAction",
          command: "create",
          path: RETRY_QUEUE_TEST,
          file_text: "import { describe, expect, it } from \"vitest\";\n// … 52 lines …\n",
        },
      }),
    },
    { at: s(GATE_AT_SECONDS), gate: true, build: status("sc-s2", "waiting_for_confirmation") },
  ];
}


/** Act two: everything the approval unblocks. */
function actTwo(): Step[] {
  return [
    { at: s(34), gate: true, build: status("sc-s3", "running") },

    {
      at: s(36),
      build: observation({
        id: "sc-o6",
        of: "sc-a6",
        tool: "file_editor",
        kind: "FileEditorObservation",
        text: `The file ${RETRY_QUEUE} has been edited.`,
      }),
    },
    {
      at: s(36.6),
      build: observation({
        id: "sc-o7",
        of: "sc-a7",
        tool: "file_editor",
        kind: "FileEditorObservation",
        text: `The file ${RETRY_JOB} has been edited.`,
      }),
    },
    {
      at: s(37.2),
      build: observation({
        id: "sc-o8",
        of: "sc-a8",
        tool: "file_editor",
        kind: "FileEditorObservation",
        text: `File created successfully at: ${RETRY_QUEUE_TEST}`,
      }),
    },

    {
      at: s(39.5),
      build: action({
        id: "sc-a9",
        tool: "task_tracker",
        response: R.verify,
        summary: "Mark the implementation done",
        action: { kind: "TaskTrackerAction", command: "plan", task_list: plan(["done", "done", "done", "in_progress"]) },
      }),
    },
    {
      at: s(40.5),
      build: observation({
        id: "sc-o9",
        of: "sc-a9",
        tool: "task_tracker",
        kind: "TaskTrackerObservation",
        text: "Task list updated.",
        taskList: plan(["done", "done", "done", "in_progress"]),
      }),
    },

    {
      at: s(42.5),
      build: action({
        id: "sc-a10",
        tool: "terminal",
        response: R.verify,
        summary: "Run the ledger test suite",
        // Encrypted-only reasoning: the transcript marks the chip rather than
        // rendering an empty Thought row.
        reasoning: { provider: "encrypted" },
        action: { kind: "TerminalAction", command: "npm test -- ledger" },
      }),
    },
    {
      at: s(48),
      build: observation({ id: "sc-o10", of: "sc-a10", tool: "terminal", kind: "TerminalObservation", text: TEST_OUTPUT }),
    },

    {
      at: s(50),
      build: action({
        id: "sc-a11",
        tool: "terminal",
        response: R.verify,
        summary: "Check the shape of the diff",
        action: { kind: "TerminalAction", command: "git diff --stat" },
      }),
    },
    {
      at: s(51.5),
      build: observation({ id: "sc-o11", of: "sc-a11", tool: "terminal", kind: "TerminalObservation", text: DIFFSTAT_OUTPUT }),
    },

    {
      at: s(53.5),
      build: action({
        id: "sc-a12",
        tool: "task_tracker",
        response: R.finish,
        summary: "Close out the plan",
        action: { kind: "TaskTrackerAction", command: "plan", task_list: plan(["done", "done", "done", "done"]) },
      }),
    },
    {
      at: s(54.5),
      build: observation({
        id: "sc-o12",
        of: "sc-a12",
        tool: "task_tracker",
        kind: "TaskTrackerObservation",
        text: "Task list updated.",
        taskList: plan(["done", "done", "done", "done"]),
      }),
    },

    {
      at: s(57),
      build: action({
        id: "sc-a13",
        tool: "finish",
        response: R.finish,
        action: { kind: "FinishAction", message: SCRIPT_FINAL_RESPONSE },
      }),
    },
    { at: s(SCRIPT_END_SECONDS), build: status("sc-s4", "finished") },
  ];
}

// Built on first use, then memoized. Not a module-level array: see the note
// above SCRIPT_TASK — nothing in client/mock/ may run at import time.
let compiled: readonly Step[] | null = null;

/** Every scripted step, in order. */
function script(): readonly Step[] {
  compiled ??= [...actOne(), ...actTwo()];
  return compiled;
}

// ── Reading the script ───────────────────────────────────────────────────────

export interface TimelineSnapshot {
  /** Every event visible at this point, oldest first. */
  events: RawOpenHandsEvent[];
  /** `execution_status` derived from the last status event in `events`. */
  status: ScriptedStatus;
  /** True while a MEDIUM-risk write is parked awaiting approval. */
  awaitingConfirmation: boolean;
  /** Accumulated cost, in USD, at this point in the run. */
  costUsd: number;
  /** Prompt+completion tokens the last turn occupied. */
  turnTokens: number;
}

/**
 * The scripted `execution_status` at `runMs`, read off the status events
 * themselves rather than tracked separately — so the pill in the header and
 * the status separators in the transcript can never disagree.
 */
export function scriptedStatusAt(runMs: number, gateDisarmed = false): ScriptedStatus {
  let status: ScriptedStatus = "running";
  for (const step of script()) {
    if (step.at > runMs) break;
    if (gateDisarmed && step.gate) continue;
    const event = step.build("");
    if (event.kind === "ConversationStateUpdateEvent" && event.key === "execution_status") {
      status = event.value as ScriptedStatus;
    }
  }
  return status;
}

/**
 * The run as it looked `runMs` into the script.
 *
 * `originEpoch` is the wall-clock instant the run's t=0 maps to; every event is
 * stamped `originEpoch + step.at`, so timestamps stay stable across polls and
 * the transcript's relative labels ("just now", "2m ago") behave.
 *
 * `gateDisarmed` drops the confirmation gate's two status transitions — pass it
 * for a run that had plan mode switched off before the gate could fire, where
 * they never happened.
 */
export function timelineAt(
  runMs: number,
  originEpoch: number,
  options: { gateDisarmed?: boolean } = {},
): TimelineSnapshot {
  const gateDisarmed = options.gateDisarmed === true;
  const events: RawOpenHandsEvent[] = [];
  for (const step of script()) {
    if (step.at > runMs) break; // the script is ordered: nothing later qualifies
    if (gateDisarmed && step.gate) continue;
    events.push(step.build(new Date(originEpoch + step.at).toISOString()));
  }
  const status = scriptedStatusAt(runMs, gateDisarmed);
  const played = Math.min(Math.max(runMs, 0), SCRIPT_END_MS);
  return {
    events,
    status,
    awaitingConfirmation: status === "waiting_for_confirmation",
    // Cost and context grow with the run so the status bar is not a frozen
    // readout. Linear is a lie in the detail and true in the shape: a longer
    // run costs more. ~$2.10 by the time the agent finishes.
    costUsd: Math.round(played * 0.0362) / 1_000,
    turnTokens: 4_200 + Math.round(played / 40),
  };
}

// ── The run clock ────────────────────────────────────────────────────────────
//
// Scripted time is not wall-clock time: the visitor can pause the run, and the
// confirmation gate holds it indefinitely. ./conversations.ts owns one of these
// records per scripted conversation and mutates it from the run/pause/approve
// routes; the arithmetic lives here so it can be tested without a fetch patch.

export interface RunProgress {
  /** Scripted ms banked before the current running stretch. */
  bankedMs: number;
  /** Epoch at which the current running stretch began; null while stopped. */
  runningSince: number | null;
  /**
   * Wall-clock instant the run's t=0 maps to — every event is stamped
   * `originEpoch + step.at`. Held explicitly rather than derived so that
   * sitting at the confirmation gate does not drag the whole transcript's
   * timestamps forward one poll at a time. It is rebased when the run
   * genuinely resumes (Run, or an approval), which is the one moment the
   * story's clock and the visitor's clock should be resynchronised.
   */
  originEpoch: number;
  /** The gated write batch has been approved (or plan mode was switched off). */
  approved: boolean;
  /**
   * The gate was disarmed before it could fire, so the run never parked. Kept
   * apart from `approved` because an approval means the park DID happen and
   * belongs in the transcript.
   */
  gateSkipped: boolean;
  /** The gated write batch was rejected — the run holds until Run is pressed. */
  rejected: boolean;
}

/** A scripted run that has not been opened yet. */
export function newRunProgress(): RunProgress {
  return { bankedMs: 0, runningSince: null, originEpoch: 0, approved: false, gateSkipped: false, rejected: false };
}

/** True once the run has been started at least once. */
export function hasStarted(progress: RunProgress): boolean {
  return progress.runningSince !== null || progress.bankedMs > 0;
}

/**
 * Scripted milliseconds elapsed at `now`.
 *
 * Clamped at the gate until the write batch is approved — that clamp IS the
 * confirmation policy, expressed as arithmetic: no later event can be revealed
 * while the run is parked, however long the visitor leaves the tab open.
 */
export function scriptRunMs(progress: RunProgress, now: number): number {
  const live = progress.runningSince === null ? 0 : Math.max(0, now - progress.runningSince);
  const raw = progress.bankedMs + live;
  return progress.approved ? Math.min(raw, SCRIPT_END_MS) : Math.min(raw, GATE_AT_MS);
}

/** Freeze the clock, banking what has run so far. Idempotent. */
export function pauseRun(progress: RunProgress, now: number): RunProgress {
  return { ...progress, bankedMs: scriptRunMs(progress, now), runningSince: null };
}

/** Start (or resume) the clock. Idempotent while already running. */
export function resumeRun(progress: RunProgress, now: number): RunProgress {
  if (progress.runningSince !== null && !progress.rejected) return progress;
  return { ...progress, runningSince: now, originEpoch: now - progress.bankedMs, rejected: false };
}

/**
 * Approve the gated write batch: the clock rebases to the gate so act two
 * plays from the moment of approval rather than from whenever the visitor
 * happened to open the tab and start reading.
 */
export function approveRun(progress: RunProgress, now: number): RunProgress {
  return {
    ...progress,
    bankedMs: GATE_AT_MS,
    runningSince: now,
    originEpoch: now - GATE_AT_MS,
    approved: true,
    rejected: false,
  };
}

/**
 * Lift the write gate without fast-forwarding.
 *
 * Switching the composer's toggle to Build sets a NeverConfirm policy, and a
 * NeverConfirm run does not stop for a MEDIUM action — so the gate must never
 * fire afterwards. Before the gate that is just "clear the clamp"; at or after
 * it, it is an approval.
 */
export function allowWrites(progress: RunProgress, now: number): RunProgress {
  if (progress.approved) return progress;
  return scriptRunMs(progress, now) >= GATE_AT_MS
    ? approveRun(progress, now)
    : { ...progress, approved: true, gateSkipped: true };
}

/** Reject it: the write stays pending and the run parks (see the header). */
export function rejectRun(progress: RunProgress, now: number): RunProgress {
  return { ...pauseRun(progress, now), rejected: true };
}

/**
 * The status a scripted conversation reports, including the states the script
 * itself cannot express: `paused` (the visitor stopped the run or rejected the
 * write) and `idle` (never started).
 */
export function runStatus(progress: RunProgress, now: number): string {
  if (progress.rejected) return "paused";
  if (progress.runningSince === null) return progress.bankedMs === 0 ? "idle" : "paused";
  return scriptedStatusAt(scriptRunMs(progress, now), progress.gateSkipped);
}

// ── Live token stream ────────────────────────────────────────────────────────

/**
 * The sentence the SSE stream types out while the agent is mid-response.
 *
 * Drawn from the prose that is genuinely about to land in the transcript, so
 * the draft bubble is a preview rather than a separate fiction — which is what
 * a real `delta` frame is. Returns null when nothing is being composed.
 */
export function streamingSentence(runMs: number): string | null {
  if (runMs < s(3)) return "Let me start with the change history.";
  if (runMs < s(25)) return "The de-duplication guard looks correct, so the key it is handed must be wrong on the replay path.";
  if (runMs < GATE_AT_MS) return "**Cause.** `replayFailedPayment` mints a fresh `randomUUID()` for every replay, so the guard never sees the original attempt.";
  if (runMs < s(48)) return "Applying the change and adding a regression test that replays a payment twice.";
  if (runMs < SCRIPT_END_MS) return "The ledger suite is green — 13 tests, including the four new replay cases.";
  return null;
}
