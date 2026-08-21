// client/mock/fixtures/manager-scenarios.ts
//
// The four runs the demo ships with, written as story boards in RUN TIME (see
// ./manager-simulation.ts). Nothing here has any effect on its own: the
// scenarios are compiled once by `simulateRun()` and then queried by elapsed
// time, so this file is data, not behaviour.
//
// EVERY NAME IS INVENTED. The repositories, branches, task slugs, merge
// request numbers, authors and agent messages below describe a fictional
// storefront company; none of them exist. tests/mock-fixtures.test.ts is the
// backstop for that rule.
//
// The cast:
//
//   1. Storefront checkout hardening   ACTIVE — the showpiece. Started 21
//      minutes before the page loaded and keeps moving while you watch: two
//      workers push and open draft MRs in the first four minutes, a silent
//      worker is nudged back to life, and wave 2 launches at the six-minute
//      mark.
//   2. Ledger service: settlement split  PLAN-READY — parked on the approval
//      card. Approving it starts a real wave; rejecting it sends the manager
//      back to planning and it re-proposes half a minute later.
//   3. Design tokens: dark-mode audit    COMPLETED — three merged-ready MRs
//      and a manager summary.
//   4. Metrics pipeline: backfill rewrite  CANCELLED — one stale branch, one
//      stuck worker, and the human note that ended it.

import { MINUTE, SECOND } from "../clock.js";
import { simulateRun, type RunScenario, type RunTimeline } from "./manager-simulation.js";

const BALANCED = "anthropic/claude-sonnet-5";
const STRONGER = "anthropic/claude-opus-4-8";

const AUTHOR = "avery.stone@example.test";

/** GitLab draft-MR URL for a project path and iid. */
export function mrUrl(projectPath: string, iid: number): string {
  return `https://gitlab.com/${projectPath}/-/merge_requests/${iid}`;
}

// ---------------------------------------------------------------------------
// 1 — Storefront checkout hardening (active)
// ---------------------------------------------------------------------------

const STOREFRONT_PATH = "tidepool-labs/storefront-web";

const storefront: RunScenario = {
  id: "8f2c41d6-5b07-4a9e-93c1-6e0b7d4f9182",
  title: "Storefront checkout hardening",
  repoUrl: `https://gitlab.com/${STOREFRONT_PATH}`,
  projectPath: STOREFRONT_PATH,
  repoInferred: false,
  baseBranch: "main",
  goal: "Split the checkout hardening backlog into file-disjoint slices and land each one as its own draft MR.",
  maxWorkersPerWave: 8,
  managerConversationId: "2f8a41c6-5d07-4b9e-a3c1-6e0b7d4f9182",
  createdBy: AUTHOR,
  createdAtRunMs: -8 * MINUTE,
  startedAtRunMs: 21 * MINUTE,
  defaultWorkerModel: BALANCED,
  statusSteps: [
    { at: -8 * MINUTE, status: "planning", currentWave: 0 },
    { at: -5 * MINUTE, status: "plan-ready", currentWave: 0 },
    { at: 0, status: "active", currentWave: 1 },
    { at: 27 * MINUTE, status: "active", currentWave: 2 },
  ],
  managerStatusSteps: [
    { at: 0, status: "idle" },
    { at: 12.1 * MINUTE, status: "running" },
    { at: 12.6 * MINUTE, status: "idle" },
    { at: 20.1 * MINUTE, status: "running" },
    { at: 20.9 * MINUTE, status: "idle" },
    { at: 26.6 * MINUTE, status: "running" },
    { at: 27.2 * MINUTE, status: "idle" },
  ],
  plan: {
    waves: [
      {
        index: 1,
        baseBranch: "main",
        workers: [
          {
            task: "catalog-filters",
            branch: "feat/catalog-filters",
            contract:
              "Replace the per-facet count queries on the catalog page with one aggregate query. Own the facet query builder and its tests; do not touch pricing.",
            ownsPaths: ["src/catalog/facets/", "tests/catalog/facets/"],
            offLimitsPaths: ["src/pricing/"],
          },
          {
            task: "price-rounding",
            branch: "feat/price-rounding",
            contract:
              "Move every money calculation onto an integer-cents helper so the cart total stops drifting by a cent. Own the pricing module; do not touch catalog or checkout views.",
            ownsPaths: ["src/pricing/", "tests/pricing/"],
            offLimitsPaths: ["src/catalog/", "src/checkout/views/"],
          },
          {
            task: "receipt-emails",
            branch: "feat/receipt-emails",
            contract:
              "Give the order receipt a plain-text fallback and pull its copy into the localisation catalogue. Own the mail templates only.",
            ownsPaths: ["src/mail/templates/", "locales/"],
            offLimitsPaths: ["src/pricing/"],
          },
          {
            task: "stock-badges",
            branch: "feat/stock-badges",
            contract:
              "Put the low-stock badge threshold behind a feature flag and cover each badge state with a story. Own the inventory badge component.",
            ownsPaths: ["src/inventory/badges/"],
            offLimitsPaths: ["src/checkout/"],
          },
        ],
      },
      {
        index: 2,
        baseBranch: "main",
        workers: [
          {
            task: "search-ranking",
            branch: "feat/search-ranking",
            contract:
              "Re-weight the search ranking now that facet counts are aggregated. Own the search scoring module.",
            ownsPaths: ["src/search/scoring/"],
          },
          {
            task: "checkout-summary",
            branch: "feat/checkout-summary",
            contract:
              "Rebuild the order summary panel on top of the integer-cents helper landed in wave 1. Own the checkout summary component.",
            ownsPaths: ["src/checkout/summary/"],
          },
        ],
      },
    ],
  },
  workers: [
    {
      task: "catalog-filters",
      branch: "feat/catalog-filters",
      contract: "Aggregate the facet counts into one query; own the facet query builder.",
      ownsPaths: ["src/catalog/facets/"],
      waveIndex: 1,
      conversationId: "b41d7e92-08c5-4f63-a17d-9c2e5b30f684",
      launchAt: 0,
      quiet: [{ from: 9 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        {
          at: 30 * SECOND,
          phase: "working",
          message: "Cloning the repo and mapping how the facet counts are queried today.",
        },
        {
          at: 7 * MINUTE,
          phase: "pushed",
          message: "Pushed a first pass: the six facet count queries are now one aggregate.",
        },
        {
          at: 9 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !104 is open — aggregate facet query plus the regression tests for it.",
        },
      ],
      mergeRequest: {
        at: 9 * MINUTE,
        iid: 104,
        ci: [
          { at: 9 * MINUTE, status: "pending" },
          { at: 9.4 * MINUTE, status: "running" },
          { at: 11.2 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "price-rounding",
      branch: "feat/price-rounding",
      contract: "Route money maths through an integer-cents helper; own the pricing module.",
      ownsPaths: ["src/pricing/"],
      waveIndex: 1,
      conversationId: "c7e05a38-1b94-42d7-8f60-3ad91c67be25",
      launchAt: 0,
      quiet: [{ from: 24 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        {
          at: 40 * SECOND,
          phase: "working",
          message: "Reading the money helpers — the drift comes from rounding floats at display time.",
        },
        {
          at: 22.2 * MINUTE,
          phase: "pushed",
          message: "Pushed: 41 call sites now go through the integer-cents helper.",
        },
        {
          at: 24 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !105 up — currency snapshots refreshed, cart totals match to the cent.",
        },
      ],
      mergeRequest: {
        at: 24 * MINUTE,
        iid: 105,
        ci: [
          { at: 24 * MINUTE, status: "pending" },
          { at: 24.5 * MINUTE, status: "running" },
          { at: 26.4 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "receipt-emails",
      branch: "feat/receipt-emails",
      contract: "Plain-text receipt fallback and localised copy; own the mail templates.",
      ownsPaths: ["src/mail/templates/"],
      waveIndex: 1,
      conversationId: "d93b62f1-4c78-4e05-b2a9-70f18d5c3ae6",
      launchAt: 0,
      quiet: [
        { from: 8 * MINUTE, until: 12.5 * MINUTE },
        { from: 25.2 * MINUTE },
      ],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        {
          at: 35 * SECOND,
          phase: "working",
          message: "Tracing where the receipt template is rendered and which strings are hard-coded.",
        },
        {
          at: 8 * MINUTE,
          phase: "blocked",
          blockReason: "agent finished without opening an MR",
          executionStatus: "finished",
          message: "The template refactor is done locally but I stopped before pushing the branch.",
        },
        {
          at: 12.5 * MINUTE,
          phase: "working",
          message: "Nudge received — pushing the branch and opening the draft MR now.",
        },
        {
          at: 23.3 * MINUTE,
          phase: "pushed",
          message: "Pushed feat/receipt-emails with the plain-text fallback and extracted strings.",
        },
        {
          at: 25.2 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !106 open: fallback renderer plus two template snapshot tests.",
        },
      ],
      mergeRequest: {
        at: 25.2 * MINUTE,
        iid: 106,
        ci: [
          { at: 25.2 * MINUTE, status: "pending" },
          { at: 25.7 * MINUTE, status: "running" },
          { at: 27.6 * MINUTE, status: "failed" },
        ],
      },
    },
    {
      task: "stock-badges",
      branch: "feat/stock-badges",
      contract: "Flag the low-stock threshold and cover the badge states; own the badge component.",
      ownsPaths: ["src/inventory/badges/"],
      waveIndex: 1,
      conversationId: "e2f47c05-9a13-4b8e-86d2-1c5b90ae7f38",
      launchAt: 0,
      model: STRONGER,
      quiet: [
        { from: 4.5 * MINUTE, until: 22.6 * MINUTE },
        { from: 26.4 * MINUTE },
      ],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        {
          at: 50 * SECOND,
          phase: "working",
          message: "Auditing the badge component and the snapshot tests that pin its states.",
        },
        {
          at: 22.6 * MINUTE,
          phase: "working",
          silentInLog: true,
          message: "Back on it — posting the current diff and finishing the flagged threshold.",
        },
        {
          at: 24.4 * MINUTE,
          phase: "pushed",
          message: "Pushed feat/stock-badges; the threshold now reads from the feature flag.",
        },
        {
          at: 26.4 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !107 open — three stories cover in-stock, low-stock and sold-out.",
        },
      ],
      mergeRequest: {
        at: 26.4 * MINUTE,
        iid: 107,
        ci: [
          { at: 26.4 * MINUTE, status: "pending" },
          { at: 26.9 * MINUTE, status: "running" },
          { at: 28.8 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "search-ranking",
      branch: "feat/search-ranking",
      contract: "Re-weight search ranking on top of the aggregated facet counts.",
      ownsPaths: ["src/search/scoring/"],
      waveIndex: 2,
      conversationId: "a15c8b74-6d20-4f19-9e37-42b0c8d5e916",
      launchAt: 27 * MINUTE,
      steps: [
        { at: 27 * MINUTE, phase: "assigned", silentInLog: true },
        {
          at: 27.6 * MINUTE,
          phase: "working",
          message: "Cloned at the wave-2 base; reading how the ranking weights are configured.",
        },
      ],
    },
    {
      task: "checkout-summary",
      branch: "feat/checkout-summary",
      contract: "Rebuild the order summary on the integer-cents helper from wave 1.",
      ownsPaths: ["src/checkout/summary/"],
      waveIndex: 2,
      conversationId: "f60a2d9b-3e51-4c86-b0d4-78e91a3f6c27",
      launchAt: 27 * MINUTE,
      steps: [
        { at: 27 * MINUTE, phase: "assigned", silentInLog: true },
        {
          at: 27.8 * MINUTE,
          phase: "working",
          message: "Mapping the summary panel's data dependencies before touching anything.",
        },
      ],
    },
  ],
  activity: [
    {
      at: -8 * MINUTE,
      actor: "human",
      message:
        "conversation 2f8a41c6-5d07-4b9e-a3c1-6e0b7d4f9182 promoted to manager; manager drafting plan",
    },
    { at: -8 * MINUTE + 4 * SECOND, actor: "executor", message: "promotion prompt delivered to the manager" },
    {
      at: -5 * MINUTE,
      actor: "manager",
      message: "plan proposed (2 wave(s)); awaiting human approval",
    },
    { at: -2 * SECOND, actor: "human", message: "plan approved" },
    {
      at: 12.1 * MINUTE,
      actor: "monitor",
      message: "trigger → manager: worker-blocked (receipt-emails)",
    },
    {
      at: 12.4 * MINUTE,
      actor: "executor",
      message:
        "nudge delivered to receipt-emails (manager): push the branch with the run's prefix — the pod's git credentials are already configured, then open the draft MR.",
    },
    {
      at: 20.1 * MINUTE,
      actor: "monitor",
      message: "trigger → manager: worker-stale (stock-badges)",
    },
    {
      at: 22.5 * MINUTE,
      actor: "executor",
      message: `nudge delivered to stock-badges (manager) [model → ${STRONGER}]: you have been silent for 16 minutes — post your current diff and finish the flagged threshold.`,
    },
    {
      at: 26.6 * MINUTE,
      actor: "monitor",
      message: "trigger → manager: wave-complete (wave 1)",
    },
    {
      at: 26.9 * MINUTE,
      actor: "manager",
      message: "launch_wave accepted: every wave-1 worker is at pr-open",
    },
  ],
};

// ---------------------------------------------------------------------------
// 2 — Ledger service: settlement split (plan-ready, gated on approval)
// ---------------------------------------------------------------------------

const LEDGER_PATH = "tidepool-labs/ledger-service";

const ledger: RunScenario = {
  id: "5a91c73e-24b8-4d60-8f15-c39e7b02a14f",
  title: "Ledger service: split the settlement worker",
  repoUrl: `https://gitlab.com/${LEDGER_PATH}`,
  projectPath: LEDGER_PATH,
  repoInferred: true,
  baseBranch: "main",
  goal: "Break the settlement worker into a queue reader, a retry ledger and a payout webhook, one MR each.",
  maxWorkersPerWave: 4,
  managerConversationId: "6b3d90e4-71af-4c25-8d0a-1f5c2e83b7d6",
  createdBy: AUTHOR,
  createdAtRunMs: -7 * MINUTE,
  startedAtRunMs: 0,
  gateAtRunMs: 0,
  defaultWorkerModel: BALANCED,
  statusSteps: [
    { at: -7 * MINUTE, status: "planning", currentWave: 0 },
    { at: -90 * SECOND, status: "plan-ready", currentWave: 0 },
    { at: 0, status: "active", currentWave: 1 },
    { at: 16 * MINUTE, status: "active", currentWave: 2 },
  ],
  managerStatusSteps: [
    { at: -7 * MINUTE, status: "running" },
    { at: -90 * SECOND, status: "idle" },
  ],
  plan: {
    waves: [
      {
        index: 1,
        baseBranch: "main",
        workers: [
          {
            task: "settlement-split",
            branch: "refactor/settlement-split",
            contract:
              "Extract the queue reader out of the settlement worker behind its existing interface. Own the settlement package; leave the retry tables alone.",
            ownsPaths: ["internal/settlement/"],
            offLimitsPaths: ["internal/retry/"],
          },
          {
            task: "retry-ledger",
            branch: "refactor/retry-ledger",
            contract:
              "Give retries their own append-only ledger table and a replay command. Own the retry package and its migrations.",
            ownsPaths: ["internal/retry/", "migrations/"],
            offLimitsPaths: ["internal/settlement/"],
          },
        ],
      },
      {
        index: 2,
        baseBranch: "main",
        workers: [
          {
            task: "payout-webhooks",
            branch: "feat/payout-webhooks",
            contract:
              "Emit payout webhooks from the extracted queue reader landed in wave 1. Own the webhook package.",
            ownsPaths: ["internal/webhooks/"],
          },
        ],
      },
    ],
  },
  workers: [
    {
      task: "settlement-split",
      branch: "refactor/settlement-split",
      contract: "Extract the queue reader from the settlement worker; own the settlement package.",
      ownsPaths: ["internal/settlement/"],
      waveIndex: 1,
      conversationId: "07be413c-8f52-4a97-b6e0-d21c39f8a45b",
      launchAt: 0,
      quiet: [{ from: 8 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        {
          at: 20 * SECOND,
          phase: "working",
          message: "Cloned; reading the settlement worker to find the seam for the queue reader.",
        },
        {
          at: 6 * MINUTE,
          phase: "pushed",
          message: "Pushed refactor/settlement-split — the reader is behind the existing interface.",
        },
        {
          at: 8 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !212 open with the extracted reader and its contract tests.",
        },
      ],
      mergeRequest: {
        at: 8 * MINUTE,
        iid: 212,
        ci: [
          { at: 8 * MINUTE, status: "pending" },
          { at: 8.6 * MINUTE, status: "running" },
          { at: 10.4 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "retry-ledger",
      branch: "refactor/retry-ledger",
      contract: "Append-only retry ledger plus a replay command; own the retry package.",
      ownsPaths: ["internal/retry/"],
      waveIndex: 1,
      conversationId: "1d8f6a20-b394-4e75-9c81-5be0273fa96d",
      launchAt: 0,
      quiet: [{ from: 12 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        {
          at: 26 * SECOND,
          phase: "working",
          message: "Sketching the ledger table and the migration that backfills it.",
        },
        {
          at: 9.5 * MINUTE,
          phase: "pushed",
          message: "Pushed refactor/retry-ledger with the migration and the replay command.",
        },
        {
          at: 12 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !213 open — replay is covered end to end against a seeded ledger.",
        },
      ],
      mergeRequest: {
        at: 12 * MINUTE,
        iid: 213,
        ci: [
          { at: 12 * MINUTE, status: "pending" },
          { at: 12.7 * MINUTE, status: "running" },
          { at: 14.9 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "payout-webhooks",
      branch: "feat/payout-webhooks",
      contract: "Emit payout webhooks from the extracted reader; own the webhook package.",
      ownsPaths: ["internal/webhooks/"],
      waveIndex: 2,
      conversationId: "3c05e87b-2f16-4d40-a9b3-6704e1c8fd52",
      launchAt: 16 * MINUTE,
      steps: [
        { at: 16 * MINUTE, phase: "assigned", silentInLog: true },
        {
          at: 16.5 * MINUTE,
          phase: "working",
          message: "Cloned at the wave-2 base; the reader interface from !212 is what I hook into.",
        },
      ],
    },
  ],
  activity: [
    {
      at: -7 * MINUTE,
      actor: "human",
      message:
        "conversation 6b3d90e4-71af-4c25-8d0a-1f5c2e83b7d6 promoted to manager; manager drafting plan; repo inferred from the conversation: https://gitlab.com/tidepool-labs/ledger-service",
    },
    { at: -7 * MINUTE + 3 * SECOND, actor: "executor", message: "promotion prompt delivered to the manager" },
    {
      at: -90 * SECOND,
      actor: "manager",
      message: "plan proposed (2 wave(s)); awaiting human approval",
    },
    {
      at: 15.6 * MINUTE,
      actor: "monitor",
      message: "trigger → manager: wave-complete (wave 1)",
    },
  ],
};

// ---------------------------------------------------------------------------
// 3 — Design tokens: dark-mode audit (completed)
// ---------------------------------------------------------------------------

const TOKENS_PATH = "tidepool-labs/design-tokens";

const tokens: RunScenario = {
  id: "b6e30f48-91d2-4c57-8a0e-53f7c214db69",
  title: "Design tokens: dark-mode audit",
  repoUrl: `https://gitlab.com/${TOKENS_PATH}`,
  projectPath: TOKENS_PATH,
  repoInferred: false,
  baseBranch: "main",
  goal: "Audit every semantic colour token for dark mode and land the fixes as reviewable slices.",
  maxWorkersPerWave: 6,
  managerConversationId: "9c47e15b-2a68-4f30-b7d9-53e8104ca6f2",
  createdBy: AUTHOR,
  createdAtRunMs: -5 * MINUTE,
  startedAtRunMs: 42 * MINUTE,
  frozenAtRunMs: 42 * MINUTE,
  defaultWorkerModel: BALANCED,
  statusSteps: [
    { at: -5 * MINUTE, status: "planning", currentWave: 0 },
    { at: -2 * MINUTE, status: "plan-ready", currentWave: 0 },
    { at: 0, status: "active", currentWave: 1 },
    { at: 18 * MINUTE, status: "active", currentWave: 2 },
    { at: 40 * MINUTE, status: "completed", currentWave: 2 },
  ],
  managerStatusSteps: [{ at: 40 * MINUTE, status: "finished" }],
  plan: {
    waves: [
      {
        index: 1,
        baseBranch: "main",
        workers: [
          {
            task: "surface-tokens",
            branch: "fix/surface-tokens",
            contract:
              "Re-derive the surface and elevation tokens for dark mode. Own the surface token set.",
            ownsPaths: ["tokens/surface/"],
          },
          {
            task: "text-contrast",
            branch: "fix/text-contrast",
            contract:
              "Raise every text token to at least 4.5:1 against its surface. Own the text token set.",
            ownsPaths: ["tokens/text/"],
          },
        ],
      },
      {
        index: 2,
        baseBranch: "main",
        workers: [
          {
            task: "chart-palette",
            branch: "fix/chart-palette",
            contract:
              "Rebuild the categorical chart palette on the corrected surfaces. Own the chart token set.",
            ownsPaths: ["tokens/chart/"],
          },
        ],
      },
    ],
  },
  workers: [
    {
      task: "surface-tokens",
      branch: "fix/surface-tokens",
      contract: "Re-derive the surface and elevation tokens for dark mode.",
      ownsPaths: ["tokens/surface/"],
      waveIndex: 1,
      conversationId: "4e7a19d3-5c80-4b26-9f14-a0d63b8e572c",
      launchAt: 0,
      quiet: [{ from: 11 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        { at: 45 * SECOND, phase: "working", message: "Reading how the surface ramp is generated." },
        { at: 8 * MINUTE, phase: "pushed", message: "Pushed the re-derived surface ramp." },
        {
          at: 11 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !58 open — six surface tokens changed, contrast table attached.",
        },
        { at: 40 * MINUTE, phase: "done", message: "Draft MR !58 open — handed over for review." },
      ],
      mergeRequest: {
        at: 11 * MINUTE,
        iid: 58,
        ci: [
          { at: 11 * MINUTE, status: "running" },
          { at: 13 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "text-contrast",
      branch: "fix/text-contrast",
      contract: "Raise text tokens to 4.5:1 against their surface.",
      ownsPaths: ["tokens/text/"],
      waveIndex: 1,
      conversationId: "8b23f60a-d719-4e58-b3c6-2f9507ae184d",
      launchAt: 0,
      quiet: [{ from: 16 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        { at: 50 * SECOND, phase: "working", message: "Measuring the current contrast ratios." },
        { at: 13 * MINUTE, phase: "pushed", message: "Pushed the corrected text ramp." },
        {
          at: 16 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !59 open — every text token now clears 4.5:1.",
        },
        { at: 40 * MINUTE, phase: "done", message: "Draft MR !59 open — handed over for review." },
      ],
      mergeRequest: {
        at: 16 * MINUTE,
        iid: 59,
        ci: [
          { at: 16 * MINUTE, status: "running" },
          { at: 18 * MINUTE, status: "success" },
        ],
      },
    },
    {
      task: "chart-palette",
      branch: "fix/chart-palette",
      contract: "Rebuild the categorical chart palette on the corrected surfaces.",
      ownsPaths: ["tokens/chart/"],
      waveIndex: 2,
      conversationId: "c5d84e17-3a62-4098-8be5-1470f9c2a3b8",
      launchAt: 18 * MINUTE,
      quiet: [{ from: 35 * MINUTE }],
      steps: [
        { at: 18 * MINUTE, phase: "assigned", silentInLog: true },
        {
          at: 18.7 * MINUTE,
          phase: "working",
          message: "Rebuilding the categorical ramp against the new surfaces.",
        },
        { at: 32 * MINUTE, phase: "pushed", message: "Pushed the eight-step categorical palette." },
        {
          at: 35 * MINUTE,
          phase: "pr-open",
          message: "Draft MR !60 open — palette regenerated and colour-blind checked.",
        },
        { at: 40 * MINUTE, phase: "done", message: "Draft MR !60 open — handed over for review." },
      ],
      mergeRequest: {
        at: 35 * MINUTE,
        iid: 60,
        ci: [
          { at: 35 * MINUTE, status: "running" },
          { at: 37 * MINUTE, status: "success" },
        ],
      },
    },
  ],
  notes: [
    {
      at: 40 * MINUTE,
      text: "SUMMARY: three draft MRs are open against main (!58 surfaces, !59 text, !60 charts). They are independent; review and merge them in any order.",
    },
  ],
  activity: [
    {
      at: -5 * MINUTE,
      actor: "human",
      message:
        "conversation 9c47e15b-2a68-4f30-b7d9-53e8104ca6f2 promoted to manager; manager drafting plan",
    },
    { at: -2 * MINUTE, actor: "manager", message: "plan proposed (2 wave(s)); awaiting human approval" },
    { at: -3 * SECOND, actor: "human", message: "plan approved" },
    { at: 17.4 * MINUTE, actor: "monitor", message: "trigger → manager: wave-complete (wave 1)" },
    { at: 39.4 * MINUTE, actor: "monitor", message: "trigger → manager: run-review" },
    {
      at: 40 * MINUTE,
      actor: "manager",
      message:
        "run completed: three draft MRs are open against main (!58 surfaces, !59 text, !60 charts)",
    },
  ],
};

// ---------------------------------------------------------------------------
// 4 — Metrics pipeline: backfill rewrite (cancelled)
// ---------------------------------------------------------------------------

const METRICS_PATH = "wren-analytics/metrics-pipeline";

const metrics: RunScenario = {
  id: "d0715c96-4e83-4b21-a7f8-96c3e5017b4a",
  title: "Metrics pipeline: backfill rewrite",
  repoUrl: `https://gitlab.com/${METRICS_PATH}`,
  projectPath: METRICS_PATH,
  repoInferred: false,
  baseBranch: "main",
  goal: "Rewrite the nightly backfill so it streams instead of loading each partition into memory.",
  maxWorkersPerWave: 4,
  managerConversationId: "4d10b8f3-6c92-4a57-9e81-b2f70d3c5a49",
  createdBy: AUTHOR,
  createdAtRunMs: -3 * MINUTE,
  startedAtRunMs: 34 * MINUTE,
  frozenAtRunMs: 34 * MINUTE,
  defaultWorkerModel: BALANCED,
  statusSteps: [
    { at: -3 * MINUTE, status: "planning", currentWave: 0 },
    { at: -30 * SECOND, status: "plan-ready", currentWave: 0 },
    { at: 0, status: "active", currentWave: 1 },
    { at: 34 * MINUTE, status: "cancelled", currentWave: 1 },
  ],
  managerStatusSteps: [{ at: 31 * MINUTE, status: "idle" }],
  plan: {
    waves: [
      {
        index: 1,
        baseBranch: "main",
        workers: [
          {
            task: "csv-export",
            branch: "perf/csv-export",
            contract:
              "Stream the CSV export instead of buffering each partition. Own the export package.",
            ownsPaths: ["pipeline/export/"],
          },
          {
            task: "partition-keys",
            branch: "perf/partition-keys",
            contract:
              "Re-key the backfill partitions so a rerun is idempotent. Own the partitioning module and its migrations.",
            ownsPaths: ["pipeline/partitions/", "migrations/"],
          },
        ],
      },
    ],
  },
  workers: [
    {
      task: "csv-export",
      branch: "perf/csv-export",
      contract: "Stream the CSV export instead of buffering partitions.",
      ownsPaths: ["pipeline/export/"],
      waveIndex: 1,
      conversationId: "6f21ab84-0d53-4917-8e6b-c47a2035df19",
      launchAt: 0,
      quiet: [{ from: 11 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        { at: 40 * SECOND, phase: "working", message: "Reading the export writer and its buffering." },
        {
          at: 11 * MINUTE,
          phase: "pushed",
          message: "Pushed perf/csv-export; the streaming writer still needs a memory cap.",
        },
      ],
    },
    {
      task: "partition-keys",
      branch: "perf/partition-keys",
      contract: "Re-key the backfill partitions so reruns are idempotent.",
      ownsPaths: ["pipeline/partitions/"],
      waveIndex: 1,
      conversationId: "2a904e6d-7b18-45c3-90fa-e836b1d7c405",
      launchAt: 0,
      quiet: [{ from: 6 * MINUTE }],
      steps: [
        { at: 0, phase: "assigned", silentInLog: true },
        { at: 45 * SECOND, phase: "working", message: "Mapping which jobs read the partition keys." },
        {
          at: 6 * MINUTE,
          phase: "blocked",
          blockReason: "agent stuck",
          executionStatus: "stuck",
          message:
            "Every re-keying I try conflicts with the retention job's assumptions; I cannot decide this alone.",
        },
      ],
    },
  ],
  notes: [
    {
      at: 31 * MINUTE,
      text: "MANAGER REQUESTS HUMAN: the backfill needs a schema decision I cannot make — the new partition keys conflict with the retention job's window.",
    },
  ],
  activity: [
    {
      at: -3 * MINUTE,
      actor: "human",
      message:
        "conversation 4d10b8f3-6c92-4a57-9e81-b2f70d3c5a49 promoted to manager; manager drafting plan",
    },
    { at: -30 * SECOND, actor: "manager", message: "plan proposed (1 wave(s)); awaiting human approval" },
    { at: -2 * SECOND, actor: "human", message: "plan approved" },
    { at: 6.3 * MINUTE, actor: "monitor", message: "trigger → manager: worker-blocked (partition-keys)" },
    {
      at: 6.8 * MINUTE,
      actor: "executor",
      message:
        "nudge delivered to partition-keys (manager): describe the exact conflict and stop; do not change the retention job.",
    },
    {
      at: 31 * MINUTE,
      actor: "manager",
      message:
        "manager requested human attention: the backfill needs a schema decision I cannot make",
    },
    { at: 34 * MINUTE, actor: "human", message: "run cancelled" },
  ],
};

// ---------------------------------------------------------------------------
// Runs a visitor creates by promoting a conversation
// ---------------------------------------------------------------------------

/** How long the manager "thinks" before its plan appears on the board. */
export const PROMOTED_PLAN_DELAY_MS = 25 * SECOND;

/** Repository the demo pretends to infer from a promoted conversation. */
export const PROMOTED_REPO_URL = `https://gitlab.com/${STOREFRONT_PATH}`;

/**
 * A run created by the visitor clicking "Promote to manager". It starts in
 * `planning`, the manager proposes a two-wave plan ~25s later, and the plan
 * then waits at the approval gate exactly like the seeded plan-ready run.
 */
export function promotedScenario(input: {
  runId: string;
  managerConversationId: string;
  title: string;
  goal: string;
  repoUrl: string | null;
  projectPath: string | null;
  repoInferred: boolean;
  baseBranch: string;
  maxWorkersPerWave: number;
  createdBy: string;
  birthElapsedMs: number;
  /** Distinguishes the conversation ids of concurrently promoted runs. */
  sequence: number;
}): RunScenario {
  const seq = String(input.sequence % 100).padStart(2, "0");
  const cid = (tail: string) => `9e0${seq}f5a-4b71-4c39-8d62-${tail}`;
  const delay = PROMOTED_PLAN_DELAY_MS;
  return {
    id: input.runId,
    title: input.title,
    repoUrl: input.repoUrl,
    projectPath: input.projectPath,
    repoInferred: input.repoInferred,
    baseBranch: input.baseBranch,
    goal: input.goal,
    maxWorkersPerWave: input.maxWorkersPerWave,
    managerConversationId: input.managerConversationId,
    createdBy: input.createdBy,
    createdAtRunMs: -delay,
    startedAtRunMs: -delay,
    birthElapsedMs: input.birthElapsedMs,
    gateAtRunMs: 0,
    defaultWorkerModel: BALANCED,
    statusSteps: [
      { at: -delay, status: "planning", currentWave: 0 },
      { at: -1, status: "plan-ready", currentWave: 0 },
      { at: 0, status: "active", currentWave: 1 },
      { at: 14 * MINUTE, status: "active", currentWave: 2 },
    ],
    managerStatusSteps: [
      { at: -delay, status: "running" },
      { at: -1, status: "idle" },
    ],
    plan: {
      waves: [
        {
          index: 1,
          baseBranch: input.baseBranch,
          workers: [
            {
              task: "cart-totals",
              branch: "feat/cart-totals",
              contract:
                "Carve the cart total calculation out of the view layer and cover it with unit tests. Own the cart package.",
              ownsPaths: ["src/cart/"],
              offLimitsPaths: ["src/checkout/"],
            },
            {
              task: "address-form",
              branch: "feat/address-form",
              contract:
                "Rebuild the address form on the shared field primitives and localise its validation copy. Own the address form.",
              ownsPaths: ["src/checkout/address/", "locales/"],
              offLimitsPaths: ["src/cart/"],
            },
          ],
        },
        {
          index: 2,
          baseBranch: input.baseBranch,
          workers: [
            {
              task: "order-review",
              branch: "feat/order-review",
              contract:
                "Assemble the order review step from the cart totals and address form landed in wave 1.",
              ownsPaths: ["src/checkout/review/"],
            },
          ],
        },
      ],
    },
    workers: [
      {
        task: "cart-totals",
        branch: "feat/cart-totals",
        contract: "Carve the cart total calculation out of the view layer; own the cart package.",
        ownsPaths: ["src/cart/"],
        waveIndex: 1,
        conversationId: cid("70a1c4e6b352"),
        launchAt: 0,
        quiet: [{ from: 7 * MINUTE }],
        steps: [
          { at: 0, phase: "assigned", silentInLog: true },
          {
            at: 18 * SECOND,
            phase: "working",
            message: "Cloned; the total is computed in three places, consolidating them first.",
          },
          {
            at: 5 * MINUTE,
            phase: "pushed",
            message: "Pushed feat/cart-totals with the extracted calculator and its tests.",
          },
          {
            at: 7 * MINUTE,
            phase: "pr-open",
            message: "Draft MR !311 open — one calculator, twelve cases covered.",
          },
        ],
        mergeRequest: {
          at: 7 * MINUTE,
          iid: 311,
          ci: [
            { at: 7 * MINUTE, status: "pending" },
            { at: 7.5 * MINUTE, status: "running" },
            { at: 9.2 * MINUTE, status: "success" },
          ],
        },
      },
      {
        task: "address-form",
        branch: "feat/address-form",
        contract: "Rebuild the address form on the shared primitives; own the address form.",
        ownsPaths: ["src/checkout/address/"],
        waveIndex: 1,
        conversationId: cid("8b47d0e29f16"),
        launchAt: 0,
        quiet: [{ from: 11 * MINUTE }],
        steps: [
          { at: 0, phase: "assigned", silentInLog: true },
          {
            at: 24 * SECOND,
            phase: "working",
            message: "Reading the field primitives before touching the address form.",
          },
          {
            at: 8.5 * MINUTE,
            phase: "pushed",
            message: "Pushed feat/address-form; validation copy now lives in the locale files.",
          },
          {
            at: 11 * MINUTE,
            phase: "pr-open",
            message: "Draft MR !312 open — form rebuilt, four locales updated.",
          },
        ],
        mergeRequest: {
          at: 11 * MINUTE,
          iid: 312,
          ci: [
            { at: 11 * MINUTE, status: "pending" },
            { at: 11.6 * MINUTE, status: "running" },
            { at: 13.4 * MINUTE, status: "success" },
          ],
        },
      },
      {
        task: "order-review",
        branch: "feat/order-review",
        contract: "Assemble the order review step from the wave-1 pieces.",
        ownsPaths: ["src/checkout/review/"],
        waveIndex: 2,
        conversationId: cid("5c92a70be431"),
        launchAt: 14 * MINUTE,
        steps: [
          { at: 14 * MINUTE, phase: "assigned", silentInLog: true },
          {
            at: 14.6 * MINUTE,
            phase: "working",
            message: "Cloned at the wave-2 base; wiring the review step to !311 and !312.",
          },
        ],
      },
    ],
    activity: [
      {
        at: -delay,
        actor: "human",
        message:
          `conversation ${input.managerConversationId} promoted to manager; manager drafting plan` +
          (input.repoInferred && input.repoUrl
            ? `; repo inferred from the conversation: ${input.repoUrl}`
            : ""),
      },
      { at: -delay + 2 * SECOND, actor: "executor", message: "promotion prompt delivered to the manager" },
      { at: -1, actor: "manager", message: "plan proposed (2 wave(s)); awaiting human approval" },
      { at: 13.6 * MINUTE, actor: "monitor", message: "trigger → manager: wave-complete (wave 1)" },
    ],
  };
}

// ---------------------------------------------------------------------------

/** The seeded runs, newest first is decided by createdAt at request time. */
export const SEEDED_SCENARIOS: readonly RunScenario[] = [storefront, ledger, tokens, metrics];

/** Compile every seeded scenario once. */
export function buildSeededTimelines(): RunTimeline[] {
  return SEEDED_SCENARIOS.map(simulateRun);
}
