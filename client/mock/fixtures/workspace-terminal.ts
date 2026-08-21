// client/mock/fixtures/workspace-terminal.ts
//
// The shared bash history behind `GET /terminal/commands`.
//
// There is no PTY here and there is none in the real product either:
// `client/pages/Terminal.tsx` is explicit that this is a read-only audit list
// of the agent's bash events, with no input and no way to run anything. So the
// fixture is a TRANSCRIPT — one work session, in order — not a shell.
//
// The session is the same one the git fixtures describe: adding a per-batch
// capacity guard to `parcel-router` so the planner stops over-assigning
// parcels to depots that are already full. Read top to bottom it should look
// like somebody actually did that: orient, reproduce, fail, fix, verify,
// commit — including the two commands that legitimately exit non-zero (a test
// run before the fix, and a `rg` that finds nothing).
//
// Commands are stored OLDEST FIRST and reversed on the way out, because the
// page renders newest first.
import { MINUTE, SECOND, isoAt } from "../clock.js";
import { CONSOLE_REPO, ROUTER_REPO, WORKSPACE_ROOT } from "./workspace-project.js";

/** One output chunk of a command, in emission order. */
export interface OutputChunk {
  stdout?: string;
  stderr?: string;
  /** Set on the LAST chunk only — the page reads the latest non-null value. */
  exitCode?: number;
}

export interface CommandFixture {
  /** 32 hex chars, matching the agent-server's bash-event id shape. */
  id: string;
  command: string;
  cwd: string;
  /** Milliseconds before the demo started. */
  agoMs: number;
  exitCode: number;
  chunks: OutputChunk[];
}

const ROUTER = ROUTER_REPO;
const CONSOLE = CONSOLE_REPO;

/**
 * Oldest first. `agoMs` counts down as the session progresses, so the newest
 * command is a couple of minutes before the visitor arrived.
 */
const SESSION: CommandFixture[] = [
  {
    id: "0a71c4e58b3d42f6905ae1c7b48d3620",
    command: "ls -1",
    cwd: WORKSPACE_ROOT,
    agoMs: 96 * MINUTE,
    exitCode: 0,
    chunks: [{ stdout: "local\nsessions\n", exitCode: 0 }],
  },
  {
    id: "1c58b0d7e9a34260c8b71ae35409d7f6",
    command: "git status --short --branch",
    cwd: ROUTER,
    agoMs: 95 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: "## work/capacity-guard...origin/work/capacity-guard\n M src/http/routes.ts\n",
        exitCode: 0,
      },
    ],
  },
  {
    id: "2b46f0a91c7d38e504b1ca67398d02ec",
    command: "git log --oneline -6",
    cwd: ROUTER,
    agoMs: 94 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "9a2f45c http: pass the configured ceiling into the planner",
          "c7d81b0 config: raise the depot capacity ceiling to 0.92",
          "2fb6094 docs: explain the batch ordering choice",
          "70e5c1a tests: cover the heaviest-first batch order",
          "1d93a05 strategies: weight proximity by service level",
          "e58b2c6 depots: keep serving the last snapshot when a refresh fails",
        ].join("\n") + "\n",
        exitCode: 0,
      },
    ],
  },
  {
    id: "3f902ae64c17b58d0e2fa93c6710bd45",
    command: "rg -n 'capacityCeiling' src",
    cwd: ROUTER,
    agoMs: 92 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "src/config.ts:12:  capacityCeiling: number;",
          "src/config.ts:38:    capacityCeiling: number(env.DEPOT_CAPACITY_CEILING, 0.92, \"DEPOT_CAPACITY_CEILING\"),",
          "src/http/routes.ts:27:      capacityCeiling: deps.config.capacityCeiling,",
          "src/routing/planner.ts:39:  capacityCeiling: 0.92,",
          "src/routing/planner.ts:66:      ceiling: this.#options.capacityCeiling,",
        ].join("\n") + "\n",
        exitCode: 0,
      },
    ],
  },
  {
    id: "4d17be08529ca364071be8d29350a1cf",
    command: "sed -n '55,95p' src/routing/planner.ts",
    cwd: ROUTER,
    agoMs: 91 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "  plan(parcels: readonly Parcel[], snapshot: DepotSnapshot): Plan {",
          "    const startedAt = performance.now();",
          "    const guard = new CapacityGuard(snapshot, {",
          "      ceiling: this.#options.capacityCeiling,",
          "      allowOverflow: this.#options.allowOverflowDepots,",
          "    });",
          "",
          "    const assignments: Assignment[] = [];",
          "    const rejections: Rejection[] = [];",
        ].join("\n") + "\n",
        exitCode: 0,
      },
    ],
  },
  {
    id: "5e8036b1af49c27d05b3ea160c8d4972",
    command: "npx vitest run tests/routing",
    cwd: ROUTER,
    agoMs: 88 * MINUTE,
    exitCode: 1,
    chunks: [
      { stdout: "\n RUN  v2.1.8 " + ROUTER + "\n\n" },
      {
        stdout: [
          " \u2713 tests/routing/planner.test.ts (5 tests) 11ms",
          " \u2717 tests/routing/capacity-guard.test.ts (5 tests | 5 failed) 8ms",
          "",
        ].join("\n"),
      },
      {
        stderr: [
          "FAIL  tests/routing/capacity-guard.test.ts > CapacityGuard > accumulates reservations",
          "TypeError: guard.headroom is not a function",
          " \u276f tests/routing/capacity-guard.test.ts:41:18",
          "",
          " Test Files  1 failed | 1 passed (2)",
          "      Tests  5 failed | 5 passed (10)",
          "",
        ].join("\n"),
        exitCode: 1,
      },
    ],
  },
  {
    id: "6a2fc4d70b198e35047ba6c1e2d3908f",
    command: "ls -1 src/routing",
    cwd: ROUTER,
    agoMs: 86 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "capacity-guard.ts",
          "depot-registry.ts",
          "legacy-balancer.ts",
          "planner.ts",
          "strategies",
          "types.ts",
        ].join("\n") + "\n",
        exitCode: 0,
      },
    ],
  },
  {
    id: "7c93e0b586af21d40c7e1b9a3652d80f",
    command: "npx tsc --noEmit -p tsconfig.json",
    cwd: ROUTER,
    agoMs: 80 * MINUTE,
    exitCode: 2,
    chunks: [
      {
        stderr: [
          "tests/routing/capacity-guard.test.ts(41,19): error TS2339: Property 'headroom' does not exist on type 'CapacityGuard'.",
          "tests/routing/capacity-guard.test.ts(42,45): error TS2339: Property 'headroom' does not exist on type 'CapacityGuard'.",
          "",
        ].join("\n"),
        exitCode: 2,
      },
    ],
  },
  {
    id: "8b40de17c25f93a6017cb4e820d95f31",
    command: "npx tsc --noEmit -p tsconfig.json",
    cwd: ROUTER,
    agoMs: 71 * MINUTE,
    exitCode: 0,
    chunks: [{ stdout: "", exitCode: 0 }],
  },
  {
    id: "9d17a0c48e6b3f2501ad7b9c4e360182",
    command: "npx vitest run tests/routing",
    cwd: ROUTER,
    agoMs: 69 * MINUTE,
    exitCode: 0,
    chunks: [
      { stdout: "\n RUN  v2.1.8 " + ROUTER + "\n\n" },
      {
        stdout: [
          " \u2713 tests/routing/capacity-guard.test.ts (5 tests) 6ms",
          " \u2713 tests/routing/planner.test.ts (5 tests) 12ms",
          "",
          " Test Files  2 passed (2)",
          "      Tests  10 passed (10)",
          "   Duration  0.94s",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "a5c1907b3e28df460ba7c1e539407d62",
    command: "npm run lint",
    cwd: ROUTER,
    agoMs: 66 * MINUTE,
    exitCode: 0,
    chunks: [
      { stdout: "\n> @harborlight/parcel-router@2.7.0 lint\n> eslint src tests\n\n", exitCode: 0 },
    ],
  },
  {
    id: "b70e42c9d15abf3607e2c418d30951ea",
    command: "git diff --stat",
    cwd: ROUTER,
    agoMs: 64 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          " src/routing/capacity-guard.ts        | 56 ++++++++++++++++++++++++++++++",
          " src/http/routes.ts                   |  2 ++",
          " tests/routing/capacity-guard.test.ts | 50 +++++++++++++++++++++++++",
          " 3 files changed, 108 insertions(+)",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "c81f5a067be2d39401ca7b6e5d29387f",
    command: "git add src/routing/capacity-guard.ts tests/routing/capacity-guard.test.ts",
    cwd: ROUTER,
    agoMs: 63 * MINUTE,
    exitCode: 0,
    chunks: [{ stdout: "", exitCode: 0 }],
  },
  {
    id: "d94b0e731ca5f28607be14d3a920c5f8",
    command: "git commit -m 'routing: add the per-batch capacity guard'",
    cwd: ROUTER,
    agoMs: 62 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "[work/capacity-guard 5e0937b] routing: add the per-batch capacity guard",
          " 1 file changed, 55 insertions(+)",
          " create mode 100644 src/routing/capacity-guard.ts",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "e37c90a5182bf6d40ea7c1b93d5024e6",
    command: "rg -n 'LegacyBalancer|legacyBalancer' src tests",
    cwd: ROUTER,
    agoMs: 58 * MINUTE,
    exitCode: 1,
    chunks: [{ stdout: "", exitCode: 1 }],
  },
  {
    id: "f28a3d0e94c157b6021ea7cb3d590f41",
    command: "rg -n 'legacy-balancer' . --glob '!node_modules'",
    cwd: ROUTER,
    agoMs: 57 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: "src/routing/legacy-balancer.ts:1:// src/routing/legacy-balancer.ts\n",
        exitCode: 0,
      },
    ],
  },
  {
    id: "0b6e4192c73da580f1ce2b7a4d0938e5",
    command: "git rm src/routing/legacy-balancer.ts",
    cwd: ROUTER,
    agoMs: 55 * MINUTE,
    exitCode: 0,
    chunks: [{ stdout: "rm 'src/routing/legacy-balancer.ts'\n", exitCode: 0 }],
  },
  {
    id: "1a9f0e57c2b6431da8907eb2c5d34061",
    command: "npx vitest run",
    cwd: ROUTER,
    agoMs: 52 * MINUTE,
    exitCode: 0,
    chunks: [
      { stdout: "\n RUN  v2.1.8 " + ROUTER + "\n\n" },
      {
        stdout: [
          " \u2713 tests/manifests/parser.test.ts (3 tests) 5ms",
          " \u2713 tests/routing/capacity-guard.test.ts (5 tests) 6ms",
          " \u2713 tests/routing/planner.test.ts (5 tests) 13ms",
          "",
          " Test Files  3 passed (3)",
          "      Tests  13 passed (13)",
          "   Duration  1.11s",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "2c05be174a938df60127eab5c3d94081",
    command: "git commit -am 'routing: reject parcels no depot can admit'",
    cwd: ROUTER,
    agoMs: 41 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "[work/capacity-guard b41c7de] routing: reject parcels no depot can admit",
          " 2 files changed, 12 insertions(+), 2 deletions(-)",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "3d6109ae52c7bf8401e5ba7c26d3095f",
    command: "node --version && npm --version",
    cwd: ROUTER,
    agoMs: 36 * MINUTE,
    exitCode: 0,
    chunks: [{ stdout: "v22.14.0\n10.9.2\n", exitCode: 0 }],
  },
  {
    id: "4e72c0b985af13d6014ceb2a7d503f18",
    command: "npm ls zod --depth=0",
    cwd: ROUTER,
    agoMs: 35 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "@harborlight/parcel-router@2.7.0 " + ROUTER,
          "└── zod@3.24.1",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "5f83a1c07be294d6013ea75c8b40219d",
    command: "npm install",
    cwd: CONSOLE,
    agoMs: 28 * MINUTE,
    exitCode: 0,
    chunks: [
      { stdout: "\nadded 214 packages, and audited 215 packages in 11s\n" },
      { stdout: "\n41 packages are looking for funding\n  run `npm fund` for details\n" },
      { stdout: "\nfound 0 vulnerabilities\n", exitCode: 0 },
    ],
  },
  {
    id: "6a04eb2c93df1758012bae7c4d539062",
    command: "npm run build",
    cwd: CONSOLE,
    agoMs: 26 * MINUTE,
    exitCode: 0,
    chunks: [
      { stdout: "\n> @harborlight/depot-console@1.4.2 build\n> tsc -b && vite build\n\n" },
      {
        stdout: [
          "vite v6.0.7 building for production...",
          "\u2713 38 modules transformed.",
          "dist/index.html                  0.44 kB \u2502 gzip:  0.29 kB",
          "dist/assets/index-C9f1ab20.css   1.12 kB \u2502 gzip:  0.58 kB",
          "dist/assets/index-B3d7c410.js  187.63 kB \u2502 gzip: 59.41 kB",
          "\u2713 built in 1.84s",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "7b15fc0a48e293d6015bea7c3d0941f2",
    command: "git status --short",
    cwd: CONSOLE,
    agoMs: 24 * MINUTE,
    exitCode: 0,
    chunks: [{ stdout: " M src/App.tsx\n M src/index.css\n", exitCode: 0 }],
  },
  {
    id: "8c2704be15af39d60127ea8c4b53d091",
    command: "df -h " + WORKSPACE_ROOT,
    cwd: WORKSPACE_ROOT,
    agoMs: 18 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          "Filesystem      Size  Used Avail Use% Mounted on",
          "/dev/vdb         64G   19G   43G  31% " + WORKSPACE_ROOT,
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "9d38c105ba7e24f60138ea7c5b209d4e",
    command: "du -sh */ | sort -h",
    cwd: WORKSPACE_ROOT,
    agoMs: 17 * MINUTE,
    exitCode: 0,
    chunks: [
      { stdout: ["612M\tsessions/", "2.1G\tlocal/", ""].join("\n"), exitCode: 0 },
    ],
  },
  {
    id: "a41eb072c95df3860124ae7c1b530d98",
    command: "git diff --stat",
    cwd: ROUTER,
    agoMs: 9 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          " docs/routing-design.md               | 12 ++++++++++++",
          " src/http/routes.ts                   |  1 +",
          " src/routing/capacity-guard.ts        |  8 ++++++++",
          " src/routing/legacy-balancer.ts       | 28 ----------------------------",
          " src/routing/planner.ts               | 12 +++++++-----",
          " tests/routing/planner.test.ts        |  6 ++++++",
          " 6 files changed, 39 insertions(+), 33 deletions(-)",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
  {
    id: "b520ce18a473df9601bea7c25d3f0418",
    command: "git status --short",
    cwd: ROUTER,
    agoMs: 4 * MINUTE,
    exitCode: 0,
    chunks: [
      {
        stdout: [
          " M docs/routing-design.md",
          " M src/http/routes.ts",
          " M src/routing/capacity-guard.ts",
          " D src/routing/legacy-balancer.ts",
          " M src/routing/planner.ts",
          " M tests/routing/planner.test.ts",
          "A  tests/routing/capacity-guard.test.ts",
          "?? notes/capacity-scratch.md",
          "",
        ].join("\n"),
        exitCode: 0,
      },
    ],
  },
];

/** Newest command first, matching `sort_order=TIMESTAMP_DESC` upstream. */
export const TERMINAL_COMMANDS: readonly CommandFixture[] = [...SESSION].reverse();

export function findCommand(id: string): CommandFixture | undefined {
  return TERMINAL_COMMANDS.find((command) => command.id === id);
}

/** ISO timestamp of a command, resolved against the demo clock. */
export function commandTimestamp(command: CommandFixture): string {
  return isoAt(-command.agoMs);
}

/**
 * Chunk timestamps trail the command by a second each, so the transcript reads
 * in order even though the page concatenates by `order`.
 */
export function chunkTimestamp(command: CommandFixture, order: number): string {
  return isoAt(-command.agoMs + (order + 1) * SECOND);
}
