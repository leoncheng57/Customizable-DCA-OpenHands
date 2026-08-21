// client/mock/fixtures/world.ts
//
// The invented world the conversations group's demo data lives in.
//
// Everything here is fiction. `tests/mock-fixtures.test.ts` fails the build if
// a real employer, host, repository, account or working directory shows up in
// client/mock/, so the org, the repos, the branches and the paths below are
// made up — and they are collected in ONE module so that stays easy to audit
// and easy to keep self-consistent across the scripted timeline, the seeded
// conversation list and the tests.
//
// What is NOT invented: tool ids (`terminal`, `file_editor`, `task_tracker`,
// `finish` — see the TOOL_DESCRIPTIONS map in server/openhands/setup.ts),
// execution statuses, the shape of tool output, and every piece of UI copy.
// Those must match what the real agent-server and the real app produce, or the
// demo is teaching visitors something false.

/** Fictional GitLab-style namespace every demo repository sits under. */
export const ORG = "bramblewick";

/** Where the agent works. The real deployment mounts a shared workspace root. */
export const WORKSPACE_ROOT = "/workspace";

export interface DemoRepo {
  /** Directory name under WORKSPACE_ROOT and the repo's short name. */
  readonly name: string;
  /** `group/project` path, as GitLab reports it. */
  readonly path: string;
  /** Absolute working directory inside the agent's container. */
  readonly dir: string;
}

// Spelled out as literals rather than built by a `repo()` helper on purpose.
// A top-level CALL is a side effect as far as Rollup is concerned, and it
// would pin this module — and everything that imports it — into the
// self-hosted bundle, where `if (import.meta.env.VITE_DEMO)` is folded to
// `false` and none of it should survive. Nothing in client/mock/ may do work
// at module-evaluation time; see the header of ../install.ts.

export const LEDGER: DemoRepo = {
  name: "ledger-service",
  path: `${ORG}/ledger-service`,
  dir: `${WORKSPACE_ROOT}/ledger-service`,
};

export const DESIGN_SYSTEM: DemoRepo = {
  name: "design-system",
  path: `${ORG}/design-system`,
  dir: `${WORKSPACE_ROOT}/design-system`,
};

export const DATA_PIPELINE: DemoRepo = {
  name: "data-pipeline",
  path: `${ORG}/data-pipeline`,
  dir: `${WORKSPACE_ROOT}/data-pipeline`,
};

export const EDGE_ROUTER: DemoRepo = {
  name: "edge-router",
  path: `${ORG}/edge-router`,
  dir: `${WORKSPACE_ROOT}/edge-router`,
};

export const SEARCH_API: DemoRepo = {
  name: "search-api",
  path: `${ORG}/search-api`,
  dir: `${WORKSPACE_ROOT}/search-api`,
};

/**
 * Model the demo conversations run on. Kept in the allowlist the hub's model
 * picker renders (MODEL_LABELS in client/pages/Hub.tsx) so the switcher shows
 * a label rather than a bare id.
 */
export const DEMO_MODEL = "anthropic/claude-sonnet-5";

/** Every model the demo's `GET /status` offers for a new conversation. */
export const DEMO_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-opus-4-6",
  "openai/gpt-5.6-terra",
] as const;

/**
 * Version string reported by `GET /status`. The real value comes from the
 * agent-server's `/server_info`; saying "demo" there would be a lie about
 * which API contract the mock implements, and saying a precise build number
 * would be a lie about a server that is not running — so it names the SDK
 * generation the fixtures were written against and marks itself simulated.
 */
export const DEMO_SERVER_VERSION = "1.40.1 (simulated)";
