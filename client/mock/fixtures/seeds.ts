// client/mock/fixtures/seeds.ts
//
// The conversations that are already there when a visitor arrives.
//
// One of them — the ledger-service bug fix — is the SCRIPTED run and is built
// by ../timeline.ts, not here. These four are static: a finished refactor, a
// run still in flight, one the user paused, and an untitled one that failed
// before it got a title. Between them the hub list shows every tone the status
// pill has (ok / busy / warn / error) and the conversation view has something
// worth opening in each state.
//
// The finished refactor is deliberately LONG — 350-odd events. It is the only
// way `next_page_id` and the transcript's "Load older events" button are real
// rather than theoretical: the page fetches the newest 300 events, so a
// conversation has to genuinely exceed that before there is an older page to
// walk to. Editing a large component library one file at a time is also what
// these agents actually do, so the length is honest rather than padding.
import type { ConversationSummary } from "../../lib/api.js";
import type { RawOpenHandsEvent, TaskItem } from "../../lib/events.js";
import type { ConversationStats } from "../../lib/statusBar.js";
import { isoAt, MINUTE, SECOND } from "../clock.js";
import { actionEvent, errorEvent, messageEvent, observationEvent, statusEvent } from "./events.js";
import { DATA_PIPELINE, DEMO_MODEL, DESIGN_SYSTEM, EDGE_ROUTER, SEARCH_API } from "./world.js";

/** A conversation the demo ships with, transcript included. */
export interface SeededConversation {
  summary: ConversationSummary;
  /** Chronological, oldest first — the order the events route pages over. */
  events: RawOpenHandsEvent[];
  /** FinishAction summary, or null when the run never finished. */
  finalResponse: string | null;
}

// ── Summary helpers ──────────────────────────────────────────────────────────

/**
 * Per-LLM usage in the shape the status bar reads (client/lib/statusBar.ts):
 * cost sums across entries, and the context gauge follows the newest
 * `token_usages` entry of the LLM that billed last.
 */
function stats(cost: number, turnTokens: number): ConversationStats {
  return {
    usage_to_metrics: {
      default: {
        model_name: DEMO_MODEL,
        accumulated_cost: cost,
        token_usages: [
          {
            prompt_tokens: Math.round(turnTokens * 0.92),
            completion_tokens: Math.round(turnTokens * 0.08),
            per_turn_token: turnTokens,
            context_window: 200_000,
          },
        ],
      },
    },
  };
}

/** ConfirmRisky is Plan mode; NeverConfirm is Build (see client/lib/planMode). */
const PLAN_POLICY = { kind: "ConfirmRisky" };
const BUILD_POLICY = { kind: "NeverConfirm" };

function summary(spec: {
  id: string;
  title: string | null;
  status: string;
  workingDir: string;
  createdAgoMs: number;
  updatedAgoMs: number;
  cost: number;
  turnTokens: number;
  plan?: boolean;
}): ConversationSummary {
  return {
    id: spec.id,
    title: spec.title,
    execution_status: spec.status,
    created_at: isoAt(-spec.createdAgoMs),
    updated_at: isoAt(-spec.updatedAgoMs),
    // Upstream leaves `metrics` null on both the detail and the search
    // payload — `stats` is the field with the real numbers in it.
    metrics: null,
    stats: stats(spec.cost, spec.turnTokens),
    agent: { llm: { model: DEMO_MODEL } },
    workspace: { working_dir: spec.workingDir },
    confirmation_policy: spec.plan ? PLAN_POLICY : BUILD_POLICY,
  };
}

/**
 * Stamps a finished transcript backwards from "`endAgoMs` before now", one
 * event every `stepMs`, so the newest event is the most recent.
 *
 * Applied AFTER the events are built rather than while building them: the
 * builders below would otherwise each have to predict their own length, and a
 * miscount silently produces `undefined` timestamps, which sort to the front
 * and quietly change the conversation's reported status. Fixtures declare
 * event ORDER; the clock decides when they happened, so nothing here carries
 * an absolute date.
 */
function retime(events: RawOpenHandsEvent[], endAgoMs: number, stepMs: number): RawOpenHandsEvent[] {
  const last = events.length - 1;
  return events.map((e, i) => ({ ...e, timestamp: isoAt(-endAgoMs - (last - i) * stepMs) }));
}

/** Placeholder stamp; `retime` replaces it once the length is known. */
const PENDING_STAMP = "";

// ── 1. The long refactor (finished) ──────────────────────────────────────────

const ICON_COMPONENTS = [
  "accordion", "alert", "avatar", "badge", "banner", "breadcrumb", "button",
  "callout", "card", "carousel", "checkbox", "chip", "combobox", "datepicker",
  "dialog", "divider", "drawer", "dropdown", "empty-state", "field", "filter",
  "footer", "form-row", "grid", "header", "heading", "icon-button", "input",
  "label", "link", "list", "menu", "modal", "nav", "pagination", "panel",
  "popover", "progress", "radio", "rating", "search-box", "select", "sidebar",
  "skeleton", "slider", "spinner", "stack", "stat", "stepper", "switch",
  "table", "tabs", "tag", "textarea", "toast",
] as const;

/** "empty-state" → "EmptyState" */
function pascal(name: string): string {
  return name.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

/** Every file the codemod touches, in the order the agent walked them. */
function iconFiles(): string[] {
  const out: string[] = [];
  for (const name of ICON_COMPONENTS) {
    const Comp = pascal(name);
    out.push(`${DESIGN_SYSTEM.dir}/src/components/${name}/${Comp}.tsx`);
    out.push(`${DESIGN_SYSTEM.dir}/src/components/${name}/${Comp}.stories.tsx`);
    out.push(`${DESIGN_SYSTEM.dir}/src/components/${name}/${Comp}.test.tsx`);
  }
  return out;
}

const ICON_TASKS = (states: ReadonlyArray<TaskItem["status"]>): TaskItem[] =>
  [
    "Count the files still importing the legacy package",
    "Rewrite the imports component by component",
    "Type-check and lint the result",
  ].map((title, i) => ({ title, status: states[i] }));

// Template literal, not `[…].join("\n")`: a top-level call is a side effect
// as far as Rollup is concerned, and one of those in client/mock/ keeps the
// whole demo backend in the self-hosted bundle. See ../install.ts.
const ICON_FINAL = `Done — every import of \`@icons/legacy\` in the design system now comes from
\`@icons/core\`. Component names are unchanged, so nothing downstream has to move.

- 165 files rewritten across 55 components (implementation, stories, tests)
- \`npx tsc --noEmit\` clean
- \`npm run lint\` clean

The legacy package is now only referenced from \`package.json\`; removing the
dependency itself is a separate change because two apps outside this repo still
resolve it transitively.`;

function iconRefactor(): SeededConversation {
  const files = iconFiles();
  const events: RawOpenHandsEvent[] = [];
  const next = (): string => PENDING_STAMP;
  let n = 0;
  const id = (prefix: string): string => `ic-${prefix}${String(++n).padStart(4, "0")}`;

  events.push(messageEvent({
    id: "ic-m1",
    timestamp: next(),
    role: "user",
    text: [
      "`@icons/legacy` is being retired at the end of the quarter. Move every import in",
      "this repo over to `@icons/core` — the component names are identical — and make",
      "sure the stories and tests still type-check.",
    ].join("\n"),
  }));
  events.push(statusEvent("ic-s1", next(), "running"));

  events.push(actionEvent({
    id: "ic-a1",
    timestamp: next(),
    tool: "terminal",
    response: "ic-resp-1",
    summary: "Count the files that still import the legacy package",
    thought: "First, how big is this? The answer decides whether I rewrite by hand or reach for a script.",
    reasoning: {
      provider: "openai",
      summary: ["Both packages export the same names, so this is a mechanical import rewrite. The only real risk is missing a file, so start from an exhaustive list."],
    },
    action: { kind: "TerminalAction", command: "grep -rl \"@icons/legacy\" src/ | wc -l" },
  }));
  events.push(observationEvent({
    id: "ic-o1", timestamp: next(), of: "ic-a1", tool: "terminal",
    kind: "TerminalObservation", text: String(files.length),
  }));

  events.push(actionEvent({
    id: "ic-a2",
    timestamp: next(),
    tool: "terminal",
    response: "ic-resp-2",
    summary: "Look at what those imports actually look like",
    action: { kind: "TerminalAction", command: "grep -rn \"@icons/legacy\" src/components/accordion" },
  }));
  events.push(observationEvent({
    id: "ic-o2", timestamp: next(), of: "ic-a2", tool: "terminal", kind: "TerminalObservation",
    text: [
      "src/components/accordion/Accordion.tsx:3:import { ChevronDown } from \"@icons/legacy\";",
      "src/components/accordion/Accordion.stories.tsx:4:import { ChevronDown } from \"@icons/legacy\";",
      "src/components/accordion/Accordion.test.tsx:2:import { ChevronDown } from \"@icons/legacy\";",
    ].join("\n"),
  }));

  events.push(actionEvent({
    id: "ic-a3",
    timestamp: next(),
    tool: "task_tracker",
    response: "ic-resp-3",
    summary: "Write down the plan",
    action: { kind: "TaskTrackerAction", command: "plan", task_list: ICON_TASKS(["done", "in_progress", "todo"]) },
  }));
  events.push(observationEvent({
    id: "ic-o3", timestamp: next(), of: "ic-a3", tool: "task_tracker",
    kind: "TaskTrackerObservation", text: "Task list updated.",
    taskList: ICON_TASKS(["done", "in_progress", "todo"]),
  }));

  events.push(messageEvent({
    id: "ic-m2",
    timestamp: next(),
    role: "assistant",
    text: [
      `${files.length} files across ${ICON_COMPONENTS.length} components. The specifier is the only thing that`,
      "changes, so I will rewrite them component by component and lint as I go rather",
      "than land one enormous unreviewable edit.",
    ].join("\n"),
  }));

  files.forEach((path, i) => {
    const actionId = id("a");
    events.push(actionEvent({
      id: actionId,
      timestamp: next(),
      tool: "file_editor",
      response: `ic-resp-file-${Math.floor(i / 3)}`,
      summary: `Point ${path.split("/").pop()} at the new icon package`,
      action: {
        kind: "FileEditorAction",
        command: "str_replace",
        path,
        old_str: "from \"@icons/legacy\"",
        new_str: "from \"@icons/core\"",
      },
    }));
    events.push(observationEvent({
      id: id("o"), timestamp: next(), of: actionId, tool: "file_editor",
      kind: "FileEditorObservation", text: `The file ${path} has been edited.`,
    }));
    if ((i + 1) % 60 === 0) {
      const lintId = id("a");
      events.push(actionEvent({
        id: lintId,
        timestamp: next(),
        tool: "terminal",
        response: `ic-resp-lint-${i}`,
        summary: "Lint checkpoint",
        action: { kind: "TerminalAction", command: "npm run lint -- --quiet src/components" },
      }));
      events.push(observationEvent({
        id: id("o"), timestamp: next(), of: lintId, tool: "terminal",
        kind: "TerminalObservation", text: `Checked ${i + 1} files, no problems found.`,
      }));
    }
  });

  events.push(actionEvent({
    id: "ic-a-tsc",
    timestamp: next(),
    tool: "terminal",
    response: "ic-resp-verify",
    summary: "Type-check the whole package",
    action: { kind: "TerminalAction", command: "npx tsc --noEmit" },
  }));
  events.push(observationEvent({
    id: "ic-o-tsc", timestamp: next(), of: "ic-a-tsc", tool: "terminal",
    kind: "TerminalObservation", text: "",
  }));

  events.push(actionEvent({
    id: "ic-a-lint",
    timestamp: next(),
    tool: "terminal",
    response: "ic-resp-verify",
    summary: "Lint the whole package",
    action: { kind: "TerminalAction", command: "npm run lint" },
  }));
  events.push(observationEvent({
    id: "ic-o-lint", timestamp: next(), of: "ic-a-lint", tool: "terminal",
    kind: "TerminalObservation", text: "> design-system@4.1.0 lint\n> eslint src\n",
  }));

  events.push(actionEvent({
    id: "ic-a-done",
    timestamp: next(),
    tool: "task_tracker",
    response: "ic-resp-finish",
    summary: "Close out the plan",
    action: { kind: "TaskTrackerAction", command: "plan", task_list: ICON_TASKS(["done", "done", "done"]) },
  }));
  events.push(observationEvent({
    id: "ic-o-done", timestamp: next(), of: "ic-a-done", tool: "task_tracker",
    kind: "TaskTrackerObservation", text: "Task list updated.",
    taskList: ICON_TASKS(["done", "done", "done"]),
  }));

  events.push(actionEvent({
    id: "ic-a-finish",
    timestamp: next(),
    tool: "finish",
    response: "ic-resp-finish",
    action: { kind: "FinishAction", message: ICON_FINAL },
  }));
  events.push(statusEvent("ic-s2", next(), "finished"));

  return {
    summary: summary({
      id: "conv-icons-3140",
      title: "Replace deprecated icon imports across the design system",
      status: "finished",
      workingDir: DESIGN_SYSTEM.dir,
      createdAgoMs: 42 * MINUTE,
      updatedAgoMs: 6 * MINUTE,
      cost: 4.86,
      turnTokens: 61_400,
    }),
    events: retime(events, 6 * MINUTE, 5 * SECOND),
    finalResponse: ICON_FINAL,
  };
}

// ── 2. Still running ─────────────────────────────────────────────────────────

const NIGHTLY_TASKS = (states: ReadonlyArray<TaskItem["status"]>): TaskItem[] =>
  [
    "Pull the last two weeks of nightly results",
    "Find what the failing runs have in common",
    "Reproduce the failure locally",
    "Propose a fix",
  ].map((title, i) => ({ title, status: states[i] }));

function nightlyInvestigation(): SeededConversation {
  const next = (): string => PENDING_STAMP;
  const events: RawOpenHandsEvent[] = [
    messageEvent({
      id: "ni-m1",
      timestamp: next(),
      role: "user",
      text: [
        "The nightly import job fails about one run in four, always on a different table.",
        "Work out what the failing runs have in common before we start changing anything.",
      ].join("\n"),
    }),
    statusEvent("ni-s1", next(), "running"),
    actionEvent({
      id: "ni-a1",
      timestamp: next(),
      tool: "terminal",
      response: "ni-resp-1",
      summary: "Read the last two weeks of nightly results",
      thought: "One in four, never the same table — that smells like a shared resource rather than a bad row. Let me look at the pattern before I look at the code.",
      action: { kind: "TerminalAction", command: "ls -1 reports/nightly | tail -14" },
    }),
    observationEvent({
      id: "ni-o1", timestamp: next(), of: "ni-a1", tool: "terminal", kind: "TerminalObservation",
      text: Array.from({ length: 6 }, (_, i) => `run-${240 + i}.json`).join("\n"),
    }),
    actionEvent({
      id: "ni-a2",
      timestamp: next(),
      tool: "terminal",
      response: "ni-resp-2",
      summary: "Extract the failing stage from each report",
      action: { kind: "TerminalAction", command: "jq -r '.failures[].stage' reports/nightly/*.json | sort | uniq -c" },
    }),
    observationEvent({
      id: "ni-o2", timestamp: next(), of: "ni-a2", tool: "terminal", kind: "TerminalObservation",
      text: ["      1 extract", "     11 load", "      2 transform"].join("\n"),
    }),
    actionEvent({
      id: "ni-a3",
      timestamp: next(),
      tool: "task_tracker",
      response: "ni-resp-3",
      summary: "Write down the plan",
      action: { kind: "TaskTrackerAction", command: "plan", task_list: NIGHTLY_TASKS(["done", "done", "in_progress", "todo"]) },
    }),
    observationEvent({
      id: "ni-o3", timestamp: next(), of: "ni-a3", tool: "task_tracker",
      kind: "TaskTrackerObservation", text: "Task list updated.",
      taskList: NIGHTLY_TASKS(["done", "done", "in_progress", "todo"]),
    }),
    messageEvent({
      id: "ni-m2",
      timestamp: next(),
      role: "assistant",
      text: [
        "Almost every failure is in the **load** stage, and the ones that are not still",
        "overlap it in time. That points at the connection pool rather than at any one",
        "table. Reproducing it now by replaying the integration suite twenty times —",
        "this will take a while.",
      ].join("\n"),
    }),
    // Deliberately left without an observation: the tool is still executing,
    // which is what makes the running indicator report a live command rather
    // than a silent "Thinking…" stall.
    actionEvent({
      id: "ni-a4",
      timestamp: next(),
      tool: "terminal",
      response: "ni-resp-4",
      summary: "Replay the integration suite until it fails",
      action: { kind: "TerminalAction", command: "npm run test:integration -- --repeat 20" },
    }),
  ];

  return {
    summary: summary({
      id: "conv-nightly-2277",
      title: "Investigate the flaky nightly import job",
      status: "running",
      workingDir: DATA_PIPELINE.dir,
      createdAgoMs: 13 * MINUTE,
      updatedAgoMs: 20 * SECOND,
      cost: 0.74,
      turnTokens: 18_900,
    }),
    events: retime(events, 20 * SECOND, 70 * SECOND),
    finalResponse: null,
  };
}

// ── 3. Paused mid-plan ───────────────────────────────────────────────────────

function rateLimitHeaders(): SeededConversation {
  const next = (): string => PENDING_STAMP;
  const events: RawOpenHandsEvent[] = [
    messageEvent({
      id: "rl-m1",
      timestamp: next(),
      role: "user",
      text: [
        "Add the standard rate-limit headers to every response from the public search API.",
        "Stay in plan mode until we have agreed the header names.",
      ].join("\n"),
    }),
    statusEvent("rl-s1", next(), "running"),
    actionEvent({
      id: "rl-a1",
      timestamp: next(),
      tool: "terminal",
      response: "rl-resp-1",
      summary: "Find the middleware chain the public routes go through",
      action: { kind: "TerminalAction", command: "grep -rn \"rateLimit\" src/http" },
    }),
    observationEvent({
      id: "rl-o1", timestamp: next(), of: "rl-a1", tool: "terminal", kind: "TerminalObservation",
      text: [
        "src/http/middleware/rateLimit.ts:18:export function rateLimit(options: RateLimitOptions) {",
        "src/http/router.ts:41:  app.use(rateLimit({ windowMs: 60_000, max: 600 }));",
      ].join("\n"),
    }),
    actionEvent({
      id: "rl-a2",
      timestamp: next(),
      tool: "file_editor",
      response: "rl-resp-2",
      summary: "Read the current middleware",
      action: { kind: "FileEditorAction", command: "view", path: `${SEARCH_API.dir}/src/http/middleware/rateLimit.ts`, view_range: [18, 34] },
    }),
    observationEvent({
      id: "rl-o2", timestamp: next(), of: "rl-a2", tool: "file_editor", kind: "FileEditorObservation",
      text: [
        `Here's the result of running \`cat -n\` on ${SEARCH_API.dir}/src/http/middleware/rateLimit.ts:`,
        "    18\texport function rateLimit(options: RateLimitOptions) {",
        "    19\t  const bucket = new TokenBucket(options);",
        "    20\t  return async (req, res, next) => {",
        "    21\t    if (!bucket.take(keyFor(req))) {",
        "    22\t      res.status(429).end();",
        "    23\t      return;",
        "    24\t    }",
        "    25\t    await next();",
        "    26\t  };",
        "    27\t}",
      ].join("\n"),
    }),
    messageEvent({
      id: "rl-m2",
      timestamp: next(),
      role: "assistant",
      text: [
        "The bucket already knows the limit, the remaining allowance and the reset time —",
        "it just never writes them out, and the 429 path returns an empty body.",
        "",
        "Two candidate spellings before I touch anything:",
        "",
        "1. `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` (the IETF draft)",
        "2. `X-RateLimit-*` (what most clients in the wild already parse)",
        "",
        "Which do you want? I would send both for a deprecation window, but that doubles",
        "the header budget on every response, so it is your call.",
      ].join("\n"),
    }),
    statusEvent("rl-s2", next(), "paused"),
  ];

  return {
    summary: summary({
      id: "conv-search-0865",
      title: "Add rate-limit headers to the public search API",
      status: "paused",
      workingDir: SEARCH_API.dir,
      createdAgoMs: 11 * MINUTE,
      updatedAgoMs: 4 * MINUTE,
      cost: 0.38,
      turnTokens: 9_100,
      plan: true,
    }),
    events: retime(events, 4 * MINUTE, 45 * SECOND),
    finalResponse: null,
  };
}

// ── 4. Untitled, and it never got going ──────────────────────────────────────

function failedClone(): SeededConversation {
  const next = (): string => PENDING_STAMP;
  const events: RawOpenHandsEvent[] = [
    messageEvent({
      id: "fc-m1",
      timestamp: next(),
      role: "user",
      text: "Have a look at why the edge router drops websocket upgrades behind the new load balancer.",
    }),
    statusEvent("fc-s1", next(), "running"),
    actionEvent({
      id: "fc-a1",
      timestamp: next(),
      tool: "terminal",
      response: "fc-resp-1",
      summary: "Clone the repository into the workspace",
      action: { kind: "TerminalAction", command: `git clone --depth 1 ${EDGE_ROUTER.path}` },
    }),
    observationEvent({
      id: "fc-o1", timestamp: next(), of: "fc-a1", tool: "terminal", kind: "TerminalObservation",
      isError: true,
      text: [
        `Cloning into '${EDGE_ROUTER.name}'...`,
        `remote: The project you were looking for could not be found or you don't have permission to view it.`,
        `fatal: repository not found`,
      ].join("\n"),
    }),
    errorEvent({
      id: "fc-e1",
      timestamp: next(),
      detail: [
        `The workspace could not be prepared: cloning ${EDGE_ROUTER.path} failed.`,
        "Check the repository path, and that the account the agent clones with has been",
        "granted access to it.",
      ].join(" "),
    }),
  ];
  events.push(statusEvent("fc-s2", next(), "error"));

  return {
    summary: summary({
      // No title: upstream names a conversation from its first exchange, and
      // this one never got far enough. The hub falls back to the id.
      id: "conv-scratch-1903",
      title: null,
      status: "error",
      workingDir: EDGE_ROUTER.dir,
      createdAgoMs: 28 * MINUTE,
      updatedAgoMs: 27 * MINUTE,
      cost: 0.02,
      turnTokens: 1_100,
    }),
    events: retime(events, 27 * MINUTE, 12 * SECOND),
    finalResponse: null,
  };
}

// ── ─────────────────────────────────────────────────────────────────────────

/**
 * Every static conversation, newest activity first — the order the hub list
 * renders them in.
 */
export function seededConversations(): SeededConversation[] {
  return [nightlyInvestigation(), rateLimitHeaders(), iconRefactor(), failedClone()];
}
