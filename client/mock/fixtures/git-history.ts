// client/mock/fixtures/git-history.ts
//
// Git state for the three invented checkouts in ./workspace-project.ts: the
// dirty working tree, the commit log, and the two file snapshots behind every
// diff.
//
// ─── How the diffs are built ─────────────────────────────────────────────────
//
// `GET /git/diff` returns only `{ original, modified }`; the BROWSER computes
// the unified diff (`client/lib/diff.ts`). `buildDiff` trims the common prefix
// and suffix and emits ONE hunk with three lines of context, so a fixture
// looks like a real review exactly when its two snapshots differ in a single
// CONTIGUOUS region — an edit at the top plus an edit at the bottom of the
// same file would render as "delete the whole file, add the whole file".
//
// Rather than hand-maintaining two near-identical copies of a 160-line source
// file (and drifting), every "before" snapshot is derived from the "after" one
// by a single `swap()`: one contiguous block of text replaced by another.
// `swap()` throws when its needle is missing, so a fixture that has drifted
// fails loudly in tests/mock-workspace.test.ts instead of quietly rendering an
// empty diff.
//
// ─── How the revisions line up ───────────────────────────────────────────────
//
//   WORKSPACE_FILES[path]   what `GET /files/content` serves — the WORKING TREE
//   headContent(path)       what HEAD holds: the working-tree "before" for a
//                           dirty file, otherwise the working-tree content
//   commit.changes[].modified
//                           the file as of that commit
//
// Each file is touched by at most one commit, so "content at commit N" and
// "content at HEAD" coincide for every file a commit lists — which is what
// keeps the commit view and the working-tree view telling the same story.
import { DAY, HOUR, MINUTE, isoAt } from "../clock.js";
import {
  CONSOLE_REPO,
  ROUTER_PLANNER,
  ROUTER_PLANNER_TEST,
  ROUTER_REPO,
  SCHEMA_REPO,
  WORKSPACE_FILES,
} from "./workspace-project.js";
import type { GitCommit, WorkspaceRepo } from "../../lib/api.js";

/**
 * Replace one contiguous block. Throws when the needle no longer matches, so a
 * fixture that drifted out of sync with ./workspace-project.ts is a test
 * failure rather than an empty diff.
 */
function swap(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at === -1) {
    throw new Error(`[mock] git fixture: needle not found:\n${from.slice(0, 120)}…`);
  }
  return source.slice(0, at) + to + source.slice(at + from.length);
}

function file(path: string): string {
  const content = WORKSPACE_FILES[path];
  if (content === undefined) throw new Error(`[mock] git fixture: unknown workspace file ${path}`);
  return content;
}

/** Git's own status vocabulary, as the real changes endpoint reports it. */
export type ChangeStatus = "ADDED" | "DELETED" | "UPDATED" | "RENAMED" | "UNTRACKED";

export interface FileRevision {
  status: ChangeStatus;
  /** Absolute workspace path. */
  path: string;
  /** null for a file that did not exist yet (added / untracked). */
  original: string | null;
  /** null for a file that no longer exists (deleted). */
  modified: string | null;
}

export interface CommitFixture {
  sha: string;
  subject: string;
  author: string;
  /** Milliseconds before the demo started — never an absolute date. */
  agoMs: number;
  changes: FileRevision[];
}

export interface RepoFixture extends WorkspaceRepo {
  /** Uncommitted working-tree changes, in `git status` order. */
  changes: FileRevision[];
  /** Newest first. */
  commits: CommitFixture[];
}

// ═════════════════════════════════════════════════════════════════════════════
// parcel-router — working tree
// ═════════════════════════════════════════════════════════════════════════════
//
// The session in flight: "stop the router over-assigning parcels to depots
// that are already at capacity". The guard landed in the last two commits;
// what is still uncommitted is the scoring nudge that keeps the network
// draining evenly, its test, and the design note that explains it.

/** planner.ts at HEAD: scores on the strategy alone, no headroom bonus. */
const PLANNER_AT_HEAD = swap(
  ROUTER_PLANNER,
  `  /**
   * Strategy score, nudged by how much room the depot has left. Without the
   * bonus the nearest depot wins every time and the network drains unevenly:
   * one depot hits the ceiling by mid-afternoon while its neighbour idles.
   */
  #score(parcel: Parcel, depots: DepotSnapshot["depots"], guard: CapacityGuard): ScoredDepot[] {
    const scored = depots.slice(0, this.#options.maxCandidates).map((depot) => {
      const base = this.#strategy.score(parcel, depot);
      const bonus = guard.headroom(depot.id) * this.#options.capacityHeadroomBonus;
      return { depotId: depot.id, score: base + bonus };
    });`,
  `  /** Raw strategy score, best first. */
  #score(parcel: Parcel, depots: DepotSnapshot["depots"], guard: CapacityGuard): ScoredDepot[] {
    const scored = depots.slice(0, this.#options.maxCandidates).map((depot) => ({
      depotId: depot.id,
      score: this.#strategy.score(parcel, depot),
    }));`,
);

/** capacity-guard.ts at HEAD: admits/reserves, but cannot report headroom. */
const GUARD_AT_HEAD = swap(
  file(`${ROUTER_REPO}/src/routing/capacity-guard.ts`),
  `  }

  /** Remaining share of capacity, 0–1. Unknown depots report no headroom. */
  headroom(depotId: string): number {
    const depot = this.#depots.get(depotId);
    if (depot === undefined || depot.capacityUnits <= 0) return 0;
    const free = (depot.capacityUnits - depot.usedUnits) / depot.capacityUnits;
    return Math.min(1, Math.max(0, free));
  }
}`,
  `  }
}`,
);

/** routes.ts at HEAD: passes the ceiling but not the headroom bonus. */
const ROUTES_AT_HEAD = swap(
  file(`${ROUTER_REPO}/src/http/routes.ts`),
  `      capacityCeiling: deps.config.capacityCeiling,
      capacityHeadroomBonus: deps.config.capacityHeadroomBonus,
    });`,
  `      capacityCeiling: deps.config.capacityCeiling,
    });`,
);

/** routing-design.md at HEAD: no "## Scoring" section yet. */
const DESIGN_AT_HEAD = swap(
  file(`${ROUTER_REPO}/docs/routing-design.md`),
  `## Scoring

Every eligible depot is scored by the configured strategy, then nudged by the
capacity headroom bonus:

    score = strategy.score(parcel, depot) + headroom(depot) * headroomBonus

The bonus exists because pure proximity drains the network unevenly. With the
nearest-depot strategy alone, the depot closest to the dense part of a region
reaches the ceiling by early afternoon while its neighbour sits half empty, and
everything that arrives after that is rejected outright.

## The capacity ceiling`,
  `## The capacity ceiling`,
);

/** planner.test.ts at HEAD: no headroom assertion yet. */
const PLANNER_TEST_AT_HEAD = swap(
  ROUTER_PLANNER_TEST,
  `
  it("reports headroom left after the assignment", () => {
    const snapshot = snapshotOf([depot({ capacityUnits: 200, usedUnits: 0 })]);
    const plan = plannerFor(snapshot).plan([parcel({ volumeUnits: 50 })], snapshot);
    expect(plan.assignments[0]?.headroomAfter).toBeCloseTo(0.75, 5);
  });
`,
  ``,
);

/** Deleted in the working tree, so it exists nowhere else in the fixture. */
const LEGACY_BALANCER = `// src/routing/legacy-balancer.ts
//
// DEPRECATED. The pre-2.0 balancer: round-robins parcels across every online
// depot in the region and ignores capacity entirely. Kept behind
// ROUTING_USE_LEGACY_BALANCER while the planner was proven out; nothing has
// set that flag since the 2.4 rollout.
import type { Assignment, DepotSnapshot, Parcel } from "./types.js";

export class LegacyBalancer {
  #cursor = 0;

  balance(parcels: readonly Parcel[], snapshot: DepotSnapshot): Assignment[] {
    const online = snapshot.depots.filter((depot) => depot.online);
    if (online.length === 0) return [];

    return parcels.map((parcel) => {
      const depot = online[this.#cursor % online.length];
      this.#cursor += 1;
      return {
        parcelId: parcel.id,
        depotId: depot === undefined ? "unknown" : depot.id,
        score: 0,
        headroomAfter: 0,
      };
    });
  }
}
`;

const ROUTER_WORKING_TREE: FileRevision[] = [
  {
    status: "UPDATED",
    path: `${ROUTER_REPO}/src/routing/planner.ts`,
    original: PLANNER_AT_HEAD,
    modified: ROUTER_PLANNER,
  },
  {
    status: "UPDATED",
    path: `${ROUTER_REPO}/src/routing/capacity-guard.ts`,
    original: GUARD_AT_HEAD,
    modified: file(`${ROUTER_REPO}/src/routing/capacity-guard.ts`),
  },
  {
    status: "UPDATED",
    path: `${ROUTER_REPO}/src/http/routes.ts`,
    original: ROUTES_AT_HEAD,
    modified: file(`${ROUTER_REPO}/src/http/routes.ts`),
  },
  {
    status: "ADDED",
    path: `${ROUTER_REPO}/tests/routing/capacity-guard.test.ts`,
    original: null,
    modified: file(`${ROUTER_REPO}/tests/routing/capacity-guard.test.ts`),
  },
  {
    status: "UPDATED",
    path: `${ROUTER_REPO}/tests/routing/planner.test.ts`,
    original: PLANNER_TEST_AT_HEAD,
    modified: ROUTER_PLANNER_TEST,
  },
  {
    status: "UPDATED",
    path: `${ROUTER_REPO}/docs/routing-design.md`,
    original: DESIGN_AT_HEAD,
    modified: file(`${ROUTER_REPO}/docs/routing-design.md`),
  },
  {
    status: "DELETED",
    path: `${ROUTER_REPO}/src/routing/legacy-balancer.ts`,
    original: LEGACY_BALANCER,
    modified: null,
  },
  {
    status: "UNTRACKED",
    path: `${ROUTER_REPO}/notes/capacity-scratch.md`,
    original: null,
    modified: file(`${ROUTER_REPO}/notes/capacity-scratch.md`),
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// parcel-router — history
// ═════════════════════════════════════════════════════════════════════════════

const ROUTER_COMMITS: CommitFixture[] = [
  {
    sha: "b41c7de2905af6183cd4e77a0b3e5f9128d6a4c0",
    subject: "routing: reject parcels no depot can admit",
    author: "avery.stone",
    agoMs: 41 * MINUTE,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/routing/planner.ts`,
        original: swap(
          PLANNER_AT_HEAD,
          `      const admissible = eligible.filter((depot) => guard.admits(depot.id, parcel.volumeUnits));
      if (admissible.length === 0) {
        rejections.push({
          parcelId: parcel.id,
          reason: "all-depots-at-capacity",
          considered: eligible.map((depot) => depot.id),
        });
        continue;
      }

      const scored = this.#score(parcel, admissible, guard);`,
          `      const scored = this.#score(parcel, eligible, guard);`,
        ),
        modified: PLANNER_AT_HEAD,
      },
    ],
  },
  {
    sha: "5e0937bc1a4d82f60c5b1e93a7d4826fb0e15c37",
    subject: "routing: add the per-batch capacity guard",
    author: "avery.stone",
    agoMs: 1 * HOUR + 24 * MINUTE,
    changes: [
      {
        status: "ADDED",
        path: `${ROUTER_REPO}/src/routing/capacity-guard.ts`,
        original: null,
        modified: GUARD_AT_HEAD,
      },
    ],
  },
  {
    sha: "9a2f45c8e73b0d61825fa4907cbe3d15046f8b29",
    subject: "http: pass the configured ceiling into the planner",
    author: "avery.stone",
    agoMs: 2 * HOUR + 8 * MINUTE,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/http/routes.ts`,
        original: swap(
          ROUTES_AT_HEAD,
          `    const planner = new Planner(new DepotRegistry(snapshot), new WeightedDepotStrategy(), {
      capacityCeiling: deps.config.capacityCeiling,
    });`,
          `    const planner = new Planner(new DepotRegistry(snapshot), new WeightedDepotStrategy());`,
        ),
        modified: ROUTES_AT_HEAD,
      },
    ],
  },
  {
    sha: "c7d81b0a63e2945081bd7ca3e6094f27b1d8ae30",
    subject: "config: raise the depot capacity ceiling to 0.92",
    author: "remy.okafor",
    agoMs: 5 * HOUR + 12 * MINUTE,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/config.ts`,
        original: swap(
          file(`${ROUTER_REPO}/src/config.ts`),
          `    capacityCeiling: number(env.DEPOT_CAPACITY_CEILING, 0.92, "DEPOT_CAPACITY_CEILING"),`,
          `    capacityCeiling: number(env.DEPOT_CAPACITY_CEILING, 0.85, "DEPOT_CAPACITY_CEILING"),`,
        ),
        modified: file(`${ROUTER_REPO}/src/config.ts`),
      },
    ],
  },
  {
    sha: "2fb6094e8c17a35d0be4712f9a8c63d5107ea4bb",
    subject: "docs: explain the batch ordering choice",
    author: "avery.stone",
    agoMs: 9 * HOUR + 35 * MINUTE,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/docs/routing-design.md`,
        original: swap(
          DESIGN_AT_HEAD,
          `## Batch ordering

Parcels are planned heaviest-first. Packing the awkward items while headroom is
still plentiful leaves the small ones to fill the gaps; replaying the October
manifests showed about 4% fewer rejections than arrival order.

## What is deliberately not here`,
          `## What is deliberately not here`,
        ),
        modified: DESIGN_AT_HEAD,
      },
    ],
  },
  {
    sha: "70e5c1a94d3b28f6015ea7c8309bd42f7610c8e5",
    subject: "tests: cover the heaviest-first batch order",
    author: "dana.vance",
    agoMs: 1 * DAY + 2 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/tests/routing/planner.test.ts`,
        original: swap(
          PLANNER_TEST_AT_HEAD,
          `
  it("plans the heaviest parcel first", () => {
    const snapshot = snapshotOf([depot({ capacityUnits: 100, usedUnits: 0 })]);
    const plan = plannerFor(snapshot).plan(
      [parcel({ id: "small", volumeUnits: 5 }), parcel({ id: "large", volumeUnits: 60 })],
      snapshot,
    );
    expect(plan.assignments.map((assignment) => assignment.parcelId)).toEqual(["large", "small"]);
  });
`,
          ``,
        ),
        modified: PLANNER_TEST_AT_HEAD,
      },
    ],
  },
  {
    sha: "1d93a057ce846b2f0a7e59db31c40e8f26b7ad14",
    subject: "strategies: weight proximity by service level",
    author: "kit.marlow",
    agoMs: 1 * DAY + 21 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/routing/strategies/weighted-depot.ts`,
        original: swap(
          file(`${ROUTER_REPO}/src/routing/strategies/weighted-depot.ts`),
          `    const proximity = Math.max(0, 1 - km / this.#maxKm);
    return proximity * SERVICE_WEIGHT[parcel.service];`,
          `    const proximity = Math.min(1, 1 - km / this.#maxKm);
    return proximity;`,
        ),
        modified: file(`${ROUTER_REPO}/src/routing/strategies/weighted-depot.ts`),
      },
    ],
  },
  {
    sha: "e58b2c6017df94a3b0512e7c8da964301fb7e26d",
    subject: "depots: keep serving the last snapshot when a refresh fails",
    author: "remy.okafor",
    agoMs: 2 * DAY + 6 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/depots/client.ts`,
        original: swap(
          file(`${ROUTER_REPO}/src/depots/client.ts`),
          `    } catch (error: unknown) {
      this.#consecutiveFailures += 1;
      this.#options.logger.warn(
        { error, failures: this.#consecutiveFailures },
        "depot registry refresh failed; serving the previous snapshot",
      );
    }`,
          `    } catch (error: unknown) {
      this.#cache.replace({ fetchedAt: new Date().toISOString(), depots: [] });
      this.#options.logger.error({ error }, "depot registry refresh failed");
    }`,
        ),
        modified: file(`${ROUTER_REPO}/src/depots/client.ts`),
      },
    ],
  },
  {
    sha: "846ad0f5931c2be70d418a6c95e2f37b0164cd9a",
    subject: "manifests: keep the good lines when one is malformed",
    author: "dana.vance",
    agoMs: 3 * DAY + 4 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/manifests/parser.ts`,
        original: swap(
          file(`${ROUTER_REPO}/src/manifests/parser.ts`),
          `    } catch (error: unknown) {
      errors.push({ line: index + 1, message: error instanceof Error ? error.message : "invalid line" });
    }`,
          `    } catch (error: unknown) {
      throw new Error("manifest line " + (index + 1) + " is invalid");
    }`,
        ),
        modified: file(`${ROUTER_REPO}/src/manifests/parser.ts`),
      },
    ],
  },
  {
    sha: "3c07e14b8d5290af6b1c73e05248da9f6017bc38",
    subject: "telemetry: record plan duration for the latency histogram",
    author: "kit.marlow",
    agoMs: 4 * DAY + 11 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/src/telemetry/metrics.ts`,
        original: swap(
          file(`${ROUTER_REPO}/src/telemetry/metrics.ts`),
          `    observePlan(assigned, rejected, elapsedMs) {
      counters.parcels_assigned_total += assigned;
      counters.parcels_rejected_total += rejected;
      counters.plan_duration_ms_sum += elapsedMs;
      counters.plan_duration_ms_count += 1;
    },`,
          `    observePlan(assigned, rejected) {
      counters.parcels_assigned_total += assigned;
      counters.parcels_rejected_total += rejected;
    },`,
        ),
        modified: file(`${ROUTER_REPO}/src/telemetry/metrics.ts`),
      },
    ],
  },
  {
    sha: "a20fd67c94e3b158027ea4c61d3958bf70e2c481",
    subject: "ops: give every alert a runbook entry",
    author: "nia.brandt",
    agoMs: 6 * DAY + 3 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${ROUTER_REPO}/docs/operations/alerts.md`,
        original: swap(
          file(`${ROUTER_REPO}/docs/operations/alerts.md`),
          `| RouterPlanLatencyHigh     | p99 plan duration > 250ms for 15m           | no    |
| RouterNotReady            | /readyz non-200 for 3m                      | yes   |

Every alert links back to \`docs/operations/runbook.md\`. An alert without a
runbook entry is not allowed to page.`,
          `| RouterPlanLatencyHigh     | p99 plan duration > 250ms for 15m           | no    |`,
        ),
        modified: file(`${ROUTER_REPO}/docs/operations/alerts.md`),
      },
    ],
  },
  {
    sha: "f19b3a0e57c2d846105bf39ea7c608d24b0157fe",
    subject: "queue: add the in-memory intake adapter for tests",
    author: "nia.brandt",
    agoMs: 8 * DAY + 19 * HOUR,
    changes: [
      {
        status: "ADDED",
        path: `${ROUTER_REPO}/src/queue/intake.ts`,
        original: null,
        modified: file(`${ROUTER_REPO}/src/queue/intake.ts`),
      },
    ],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// depot-console
// ═════════════════════════════════════════════════════════════════════════════

const CONSOLE_WORKING_TREE: FileRevision[] = [
  {
    status: "UPDATED",
    path: `${CONSOLE_REPO}/src/App.tsx`,
    original: swap(
      file(`${CONSOLE_REPO}/src/App.tsx`),
      `      {error !== null && <p role="alert">{error}</p>}
      {rows === null ? <p>Loading depots…</p> : <DepotTable rows={rows} />}`,
      `      {rows === null ? <p>Loading depots…</p> : <DepotTable rows={rows} />}`,
    ),
    modified: file(`${CONSOLE_REPO}/src/App.tsx`),
  },
  {
    status: "UPDATED",
    path: `${CONSOLE_REPO}/src/index.css`,
    original: swap(
      file(`${CONSOLE_REPO}/src/index.css`),
      `.badge-full {
  background: rgba(239, 68, 68, 0.18);
}
`,
      ``,
    ),
    modified: file(`${CONSOLE_REPO}/src/index.css`),
  },
];

const CONSOLE_COMMITS: CommitFixture[] = [
  {
    sha: "6b0e28c1a94df357028ce6b1470d9a3f85126ec7",
    subject: "console: colour the capacity badge at the ceiling",
    author: "kit.marlow",
    agoMs: 3 * HOUR + 47 * MINUTE,
    changes: [
      {
        status: "UPDATED",
        path: `${CONSOLE_REPO}/src/components/CapacityBadge.tsx`,
        original: swap(
          file(`${CONSOLE_REPO}/src/components/CapacityBadge.tsx`),
          `const CEILING = 0.92;

export function CapacityBadge({ used, capacity }: { used: number; capacity: number }) {
  const share = capacity <= 0 ? 1 : used / capacity;
  const tone = share >= CEILING ? "full" : share >= 0.75 ? "busy" : "ok";`,
          `export function CapacityBadge({ used, capacity }: { used: number; capacity: number }) {
  const share = capacity <= 0 ? 1 : used / capacity;
  const tone = share >= 0.75 ? "busy" : "ok";`,
        ),
        modified: file(`${CONSOLE_REPO}/src/components/CapacityBadge.tsx`),
      },
    ],
  },
  {
    sha: "0d47f9b2e6531ca80b19d7e4f2a3c6580917bd4e",
    subject: "console: surface offline depots in the table",
    author: "dana.vance",
    agoMs: 1 * DAY + 7 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${CONSOLE_REPO}/src/components/DepotTable.tsx`,
        original: swap(
          file(`${CONSOLE_REPO}/src/components/DepotTable.tsx`),
          `            <td>{row.region}</td>
            <td>{row.online ? "online" : "offline"}</td>`,
          `            <td>{row.region}</td>`,
        ),
        modified: file(`${CONSOLE_REPO}/src/components/DepotTable.tsx`),
      },
    ],
  },
  {
    sha: "b83c05de2914a7f60d5b1c8320ea9476d10ab35c",
    subject: "console: fail loudly when the registry is unreachable",
    author: "kit.marlow",
    agoMs: 2 * DAY + 15 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${CONSOLE_REPO}/src/api/client.ts`,
        original: swap(
          file(`${CONSOLE_REPO}/src/api/client.ts`),
          `  if (!response.ok) throw new Error("Depot registry responded " + response.status);
  const body = (await response.json()) as { depots: DepotRow[] };
  return body.depots;`,
          `  const body = (await response.json()) as { depots: DepotRow[] };
  return body.depots;`,
        ),
        modified: file(`${CONSOLE_REPO}/src/api/client.ts`),
      },
    ],
  },
  {
    sha: "4a1e70bd6c92f38014ae5b7d206c1f39ba57c802",
    subject: "console: let the dev server run behind a reverse proxy",
    author: "avery.stone",
    agoMs: 5 * DAY + 9 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${CONSOLE_REPO}/vite.config.ts`,
        original: swap(
          file(`${CONSOLE_REPO}/vite.config.ts`),
          `  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: process.env.VITE_ALLOWED_HOSTS === "all" ? true : undefined,
    proxy: { "/v2": { target: routerOrigin, changeOrigin: true } },
  },`,
          `  plugins: [react()],
  server: {
    proxy: { "/v2": { target: routerOrigin, changeOrigin: true } },
  },`,
        ),
        modified: file(`${CONSOLE_REPO}/vite.config.ts`),
      },
    ],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// manifest-schema
// ═════════════════════════════════════════════════════════════════════════════

const SCHEMA_WORKING_TREE: FileRevision[] = [
  {
    status: "UPDATED",
    path: `${SCHEMA_REPO}/README.md`,
    original: swap(
      file(`${SCHEMA_REPO}/README.md`),
      `The one definition of an inbound parcel manifest, shared by the router and the
console. Publishing it as a package rather than copying the shape around is the
only reason the two stay in step.`,
      `The one definition of an inbound parcel manifest.`,
    ),
    modified: file(`${SCHEMA_REPO}/README.md`),
  },
];

const SCHEMA_COMMITS: CommitFixture[] = [
  {
    sha: "ce9147a0b3d82f65014e7ac9b26d5308f1470bd2",
    subject: "schema: cap volume_units at the freight ceiling",
    author: "remy.okafor",
    agoMs: 6 * HOUR + 51 * MINUTE,
    changes: [
      {
        status: "UPDATED",
        path: `${SCHEMA_REPO}/src/manifest.ts`,
        original: swap(
          file(`${SCHEMA_REPO}/src/manifest.ts`),
          `  volume_units: z.number().positive().max(2_400),`,
          `  volume_units: z.number().positive(),`,
        ),
        modified: file(`${SCHEMA_REPO}/src/manifest.ts`),
      },
    ],
  },
  {
    sha: "7f2b6d15083ace94b7160d3f5a82c04e91b7d6a3",
    subject: "schema: default hazard_classes to an empty list",
    author: "nia.brandt",
    agoMs: 2 * DAY + 2 * HOUR,
    changes: [
      {
        status: "UPDATED",
        path: `${SCHEMA_REPO}/src/depot.ts`,
        original: swap(
          file(`${SCHEMA_REPO}/src/depot.ts`),
          `  hazard_classes: z.array(z.string()).default([]),`,
          `  hazard_classes: z.array(z.string()),`,
        ),
        modified: file(`${SCHEMA_REPO}/src/depot.ts`),
      },
    ],
  },
  {
    sha: "d3608b7fe14a29c50b8d1673ea409c25f8b1470d",
    subject: "schema: publish the depot shape alongside the manifest",
    author: "remy.okafor",
    agoMs: 7 * DAY + 13 * HOUR,
    changes: [
      {
        status: "ADDED",
        path: `${SCHEMA_REPO}/src/index.ts`,
        original: null,
        modified: file(`${SCHEMA_REPO}/src/index.ts`),
      },
    ],
  },
];

/** Every checkout the demo workspace holds, in `git/repos` order. */
export const REPO_FIXTURES: readonly RepoFixture[] = [
  { name: "parcel-router", path: ROUTER_REPO, changes: ROUTER_WORKING_TREE, commits: ROUTER_COMMITS },
  { name: "depot-console", path: CONSOLE_REPO, changes: CONSOLE_WORKING_TREE, commits: CONSOLE_COMMITS },
  { name: "manifest-schema", path: SCHEMA_REPO, changes: SCHEMA_WORKING_TREE, commits: SCHEMA_COMMITS },
];

/** The checkout a conversation-scoped Files/Changes panel is pointed at. */
export const PRIMARY_REPO: RepoFixture = REPO_FIXTURES[0] as RepoFixture;

export function findRepo(path: string): RepoFixture | undefined {
  return REPO_FIXTURES.find((repo) => repo.path === path);
}

/** A commit's list entry, with its timestamp resolved against the demo clock. */
export function commitSummary(commit: CommitFixture): GitCommit {
  return {
    sha: commit.sha,
    short_sha: commit.sha.slice(0, 7),
    subject: commit.subject,
    author: commit.author,
    timestamp: isoAt(-commit.agoMs),
  };
}
