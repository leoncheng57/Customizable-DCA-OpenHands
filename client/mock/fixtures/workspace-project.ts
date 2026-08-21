// client/mock/fixtures/workspace-project.ts
//
// The invented project the whole workspace surface is built from.
//
// ─────────────────────────────────────────────────────────────────────────────
// Harborlight — a fictional parcel-logistics platform
// ─────────────────────────────────────────────────────────────────────────────
//
// Three checkouts share one demo workspace volume, and one work session is in
// flight across them: "stop the router over-assigning parcels to depots that
// are already at capacity". Every other fixture in this directory (the git
// changes, the commit history, the diffs, the bash history) tells that same
// story, so the Files / Changes / Terminal pages agree with each other.
//
//   local/parcel-router      TypeScript HTTP service — where the work happens
//   local/depot-console      Vite + React operator UI — the preview candidate
//   sessions/<uuid>/manifest-schema
//                            shared zod schemas, cloned into a session dir
//
// `WORKSPACE_FILES` is the single source of truth: it maps an absolute
// workspace path to the file's CURRENT (working-tree) content. The directory
// tree is derived from those keys, so `GET /files/tree` can never advertise a
// file that `GET /files/content` cannot open, and `git-history.ts` reuses the
// same strings as the `modified` side of every working-tree diff.
//
// Nothing here is real: the org, the repos, the authors and the paths are all
// invented. See tests/mock-fixtures.test.ts.

/** Shared workspace volume mount — mirrors WORKSPACE_ROOT in the real BFF. */
export const WORKSPACE_ROOT = "/home/openhands/workspace";
/** Bind-mounted project folders (the "local" workspace mode). */
export const LOCAL_ROOT = `${WORKSPACE_ROOT}/local`;
/** Throwaway per-conversation clones (the "session" workspace mode). */
export const SESSIONS_ROOT = `${WORKSPACE_ROOT}/sessions`;

/** The session directory the third checkout lives in. */
export const SESSION_DIR = `${SESSIONS_ROOT}/7c41e0b8-3d92-4a17-b6f5-9e2140ac5db3`;

export const ROUTER_REPO = `${LOCAL_ROOT}/parcel-router`;
export const CONSOLE_REPO = `${LOCAL_ROOT}/depot-console`;
export const SCHEMA_REPO = `${SESSION_DIR}/manifest-schema`;

// ─── parcel-router ───────────────────────────────────────────────────────────

const ROUTER_README = `# parcel-router

Assigns inbound parcels to Harborlight depots.

The service consumes manifests from the intake queue, scores every depot that
can legally accept the parcel, and writes an assignment back to the queue. It
holds no state of its own: the depot registry is refreshed on a timer and the
planner is a pure function over that snapshot.

## Layout

| Path                  | What lives there                                  |
| --------------------- | ------------------------------------------------- |
| \`src/http\`            | the HTTP surface (health, assign, admin)          |
| \`src/routing\`         | planner, capacity guard, scoring strategies       |
| \`src/depots\`          | depot registry client and its cache               |
| \`src/manifests\`       | manifest parsing and validation                   |
| \`src/queue\`           | intake/outbound queue adapters                    |
| \`src/telemetry\`       | metrics and structured logging                    |

## Running it

    npm install
    npm run dev

The dev server listens on \`PARCEL_ROUTER_PORT\` (default 8420) and expects a
depot registry at \`DEPOT_REGISTRY_URL\`. Both are read once at boot; see
\`src/config.ts\`.

## Tests

    npm test            # everything
    npm test -- routing # just the planner and the capacity guard
`;

const ROUTER_PACKAGE_JSON = `{
  "name": "@harborlight/parcel-router",
  "version": "2.7.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "@harborlight/manifest-schema": "workspace:*",
    "fastify": "^5.2.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
`;

const ROUTER_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
`;

const ROUTER_INDEX = `// src/index.ts
//
// Process entry point. Everything interesting is wired here and nowhere else:
// the rest of the service takes its collaborators as arguments so the tests
// never have to boot a server.
import { loadConfig } from "./config.js";
import { DepotClient } from "./depots/client.js";
import { createServer } from "./http/server.js";
import { createLogger } from "./telemetry/logger.js";
import { createMetrics } from "./telemetry/metrics.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const metrics = createMetrics();

const depots = new DepotClient({
  registryUrl: config.depotRegistryUrl,
  refreshMs: config.depotRefreshMs,
  logger,
});

const server = createServer({ config, depots, logger, metrics });

async function main(): Promise<void> {
  await depots.start();
  await server.listen({ host: "0.0.0.0", port: config.port });
  logger.info({ port: config.port }, "parcel-router listening");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    void Promise.allSettled([server.close(), depots.stop()]).then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  logger.error({ error }, "failed to start");
  process.exit(1);
});
`;

const ROUTER_CONFIG = `// src/config.ts
//
// One place where environment variables turn into a typed value. Reading
// process.env anywhere else is a lint error — the planner and the strategies
// must stay pure so they can be unit tested without a fixture environment.
export interface Config {
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  depotRegistryUrl: string;
  depotRefreshMs: number;
  /** Refuse to assign a parcel to a depot above this share of its capacity. */
  capacityCeiling: number;
  /** Depots this far below the ceiling are preferred even if further away. */
  capacityHeadroomBonus: number;
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function number(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(label + " must be numeric, got " + raw);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const logLevel = env.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.has(logLevel)) throw new Error("LOG_LEVEL must be one of debug|info|warn|error");

  const registryUrl = env.DEPOT_REGISTRY_URL;
  if (!registryUrl) throw new Error("DEPOT_REGISTRY_URL is required");

  return {
    port: number(env.PARCEL_ROUTER_PORT, 8420, "PARCEL_ROUTER_PORT"),
    logLevel: logLevel as Config["logLevel"],
    depotRegistryUrl: registryUrl,
    depotRefreshMs: number(env.DEPOT_REFRESH_MS, 30_000, "DEPOT_REFRESH_MS"),
    capacityCeiling: number(env.DEPOT_CAPACITY_CEILING, 0.92, "DEPOT_CAPACITY_CEILING"),
    capacityHeadroomBonus: number(env.DEPOT_HEADROOM_BONUS, 0.15, "DEPOT_HEADROOM_BONUS"),
  };
}
`;

// The "large-ish file" the Files page is meant to show off. Also the `modified`
// side of the headline working-tree diff in git-history.ts.
export const ROUTER_PLANNER = `// src/routing/planner.ts
//
// Turns one inbound manifest into a depot assignment plan.
//
// The planner is deliberately pure: it is handed a snapshot of the depot
// registry plus a scoring strategy and returns a plan. It never touches the
// network — DepotClient refreshes the registry on its own cadence, and the
// planner only ever sees the snapshot it was given. That is what lets
// tests/routing/planner.test.ts run a hundred scenarios in a millisecond.
import { CapacityGuard } from "./capacity-guard.js";
import { DepotRegistry } from "./depot-registry.js";
import type {
  Assignment,
  DepotSnapshot,
  Parcel,
  PlanOptions,
  RoutingStrategy,
  ScoredDepot,
} from "./types.js";

/** A parcel nobody can take, plus the reason, so the queue can dead-letter it. */
export interface Rejection {
  parcelId: string;
  reason: "no-eligible-depot" | "all-depots-at-capacity" | "manifest-out-of-region";
  /** Depots that were considered but filtered out, for the operator console. */
  considered: string[];
}

export interface Plan {
  assignments: Assignment[];
  rejections: Rejection[];
  /** Wall-clock cost of the plan, in milliseconds, for the latency histogram. */
  elapsedMs: number;
}

const DEFAULT_OPTIONS: Required<PlanOptions> = {
  capacityCeiling: 0.92,
  capacityHeadroomBonus: 0.15,
  maxCandidates: 12,
  allowOverflowDepots: false,
};

export class Planner {
  readonly #registry: DepotRegistry;
  readonly #strategy: RoutingStrategy;
  readonly #options: Required<PlanOptions>;

  constructor(registry: DepotRegistry, strategy: RoutingStrategy, options: PlanOptions = {}) {
    this.#registry = registry;
    this.#strategy = strategy;
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Plan a whole batch. Depot load is tracked across the batch, so two parcels
   * in the same call cannot both be sent to the last free slot in a depot.
   */
  plan(parcels: readonly Parcel[], snapshot: DepotSnapshot): Plan {
    const startedAt = performance.now();
    const guard = new CapacityGuard(snapshot, {
      ceiling: this.#options.capacityCeiling,
      allowOverflow: this.#options.allowOverflowDepots,
    });

    const assignments: Assignment[] = [];
    const rejections: Rejection[] = [];

    for (const parcel of this.#ordered(parcels)) {
      const eligible = this.#eligibleDepots(parcel, snapshot);
      if (eligible.length === 0) {
        rejections.push({ parcelId: parcel.id, reason: "no-eligible-depot", considered: [] });
        continue;
      }

      const admissible = eligible.filter((depot) => guard.admits(depot.id, parcel.volumeUnits));
      if (admissible.length === 0) {
        rejections.push({
          parcelId: parcel.id,
          reason: "all-depots-at-capacity",
          considered: eligible.map((depot) => depot.id),
        });
        continue;
      }

      const scored = this.#score(parcel, admissible, guard);
      const winner = scored[0];
      if (winner === undefined) {
        rejections.push({
          parcelId: parcel.id,
          reason: "no-eligible-depot",
          considered: admissible.map((depot) => depot.id),
        });
        continue;
      }

      guard.reserve(winner.depotId, parcel.volumeUnits);
      assignments.push({
        parcelId: parcel.id,
        depotId: winner.depotId,
        score: winner.score,
        headroomAfter: guard.headroom(winner.depotId),
      });
    }

    return { assignments, rejections, elapsedMs: performance.now() - startedAt };
  }

  /**
   * Heaviest parcels first. Packing the awkward items while there is still
   * headroom everywhere leaves the small ones to fill the gaps, which measured
   * ~4% fewer rejections than arrival order on the replayed October manifests.
   */
  #ordered(parcels: readonly Parcel[]): Parcel[] {
    return [...parcels].sort((left, right) => right.volumeUnits - left.volumeUnits);
  }

  #eligibleDepots(parcel: Parcel, snapshot: DepotSnapshot): DepotSnapshot["depots"] {
    return snapshot.depots.filter((depot) => {
      if (!depot.online) return false;
      if (depot.region !== parcel.region) return false;
      if (parcel.hazardClass !== null && !depot.hazardClasses.includes(parcel.hazardClass)) return false;
      return depot.maxParcelVolumeUnits >= parcel.volumeUnits;
    });
  }

  /**
   * Strategy score, nudged by how much room the depot has left. Without the
   * bonus the nearest depot wins every time and the network drains unevenly:
   * one depot hits the ceiling by mid-afternoon while its neighbour idles.
   */
  #score(parcel: Parcel, depots: DepotSnapshot["depots"], guard: CapacityGuard): ScoredDepot[] {
    const scored = depots.slice(0, this.#options.maxCandidates).map((depot) => {
      const base = this.#strategy.score(parcel, depot);
      const bonus = guard.headroom(depot.id) * this.#options.capacityHeadroomBonus;
      return { depotId: depot.id, score: base + bonus };
    });
    return scored.sort((left, right) => right.score - left.score);
  }
}
`;

const ROUTER_CAPACITY_GUARD = `// src/routing/capacity-guard.ts
//
// Tracks how full each depot is DURING a planning pass.
//
// The registry snapshot only tells us where every depot stood when it was
// fetched. Within one batch we hand out slots ourselves, so the guard keeps a
// running reservation per depot and refuses anything that would push it past
// the ceiling. Reservations are discarded with the guard: it is scoped to a
// single Planner.plan() call and never outlives it.
import type { DepotSnapshot } from "./types.js";

export interface CapacityGuardOptions {
  /** Share of capacity (0–1) a depot may reach before it stops accepting. */
  ceiling: number;
  /** Ignore the ceiling — the manual override the on-call operator can set. */
  allowOverflow: boolean;
}

interface DepotCapacity {
  capacityUnits: number;
  usedUnits: number;
}

export class CapacityGuard {
  readonly #depots = new Map<string, DepotCapacity>();
  readonly #options: CapacityGuardOptions;

  constructor(snapshot: DepotSnapshot, options: CapacityGuardOptions) {
    this.#options = options;
    for (const depot of snapshot.depots) {
      this.#depots.set(depot.id, {
        capacityUnits: depot.capacityUnits,
        usedUnits: depot.usedUnits,
      });
    }
  }

  /** Would this depot still be under the ceiling after taking the parcel? */
  admits(depotId: string, volumeUnits: number): boolean {
    if (this.#options.allowOverflow) return true;
    const depot = this.#depots.get(depotId);
    if (depot === undefined) return false;
    if (depot.capacityUnits <= 0) return false;
    return (depot.usedUnits + volumeUnits) / depot.capacityUnits <= this.#options.ceiling;
  }

  /** Book the space. Callers must have checked admits() first. */
  reserve(depotId: string, volumeUnits: number): void {
    const depot = this.#depots.get(depotId);
    if (depot === undefined) throw new Error("unknown depot " + depotId);
    depot.usedUnits += volumeUnits;
  }

  /** Remaining share of capacity, 0–1. Unknown depots report no headroom. */
  headroom(depotId: string): number {
    const depot = this.#depots.get(depotId);
    if (depot === undefined || depot.capacityUnits <= 0) return 0;
    const free = (depot.capacityUnits - depot.usedUnits) / depot.capacityUnits;
    return Math.min(1, Math.max(0, free));
  }
}
`;

const ROUTER_DEPOT_REGISTRY = `// src/routing/depot-registry.ts
//
// Read-only view over the depot snapshot the planner was handed. It exists so
// the planner never indexes into a raw array and so lookups stay O(1) when a
// region has a few hundred depots.
import type { Depot, DepotSnapshot } from "./types.js";

export class DepotRegistry {
  readonly #byId: Map<string, Depot>;
  readonly #byRegion: Map<string, Depot[]>;
  readonly snapshotAt: string;

  constructor(snapshot: DepotSnapshot) {
    this.snapshotAt = snapshot.fetchedAt;
    this.#byId = new Map(snapshot.depots.map((depot) => [depot.id, depot]));
    this.#byRegion = new Map();
    for (const depot of snapshot.depots) {
      const bucket = this.#byRegion.get(depot.region) ?? [];
      bucket.push(depot);
      this.#byRegion.set(depot.region, bucket);
    }
  }

  get(depotId: string): Depot | undefined {
    return this.#byId.get(depotId);
  }

  inRegion(region: string): readonly Depot[] {
    return this.#byRegion.get(region) ?? [];
  }

  get size(): number {
    return this.#byId.size;
  }
}
`;

const ROUTER_TYPES = `// src/routing/types.ts
export interface Depot {
  id: string;
  name: string;
  region: string;
  online: boolean;
  capacityUnits: number;
  usedUnits: number;
  maxParcelVolumeUnits: number;
  hazardClasses: string[];
  /** Great-circle distance is computed against this, in decimal degrees. */
  location: { lat: number; lon: number };
}

export interface DepotSnapshot {
  fetchedAt: string;
  depots: Depot[];
}

export interface Parcel {
  id: string;
  region: string;
  volumeUnits: number;
  hazardClass: string | null;
  destination: { lat: number; lon: number };
  /** Manifest-declared service level; strategies may weight it. */
  service: "standard" | "express" | "freight";
}

export interface Assignment {
  parcelId: string;
  depotId: string;
  score: number;
  headroomAfter: number;
}

export interface ScoredDepot {
  depotId: string;
  score: number;
}

export interface PlanOptions {
  capacityCeiling?: number;
  capacityHeadroomBonus?: number;
  maxCandidates?: number;
  allowOverflowDepots?: boolean;
}

export interface RoutingStrategy {
  readonly name: string;
  score(parcel: Parcel, depot: Depot): number;
}
`;

const ROUTER_WEIGHTED = `// src/routing/strategies/weighted-depot.ts
import type { Depot, Parcel, RoutingStrategy } from "../types.js";
import { haversineKm } from "./nearest-depot.js";

const SERVICE_WEIGHT: Record<Parcel["service"], number> = {
  express: 1.4,
  standard: 1,
  freight: 0.7,
};

/**
 * Distance, weighted by service level. Express parcels care about proximity
 * far more than freight does, so the distance penalty is scaled rather than
 * the score being clamped — a clamp made every express depot tie at 1.0.
 */
export class WeightedDepotStrategy implements RoutingStrategy {
  readonly name = "weighted-depot";

  readonly #maxKm: number;

  constructor(maxKm = 400) {
    this.#maxKm = maxKm;
  }

  score(parcel: Parcel, depot: Depot): number {
    const km = haversineKm(parcel.destination, depot.location);
    const proximity = Math.max(0, 1 - km / this.#maxKm);
    return proximity * SERVICE_WEIGHT[parcel.service];
  }
}
`;

const ROUTER_NEAREST = `// src/routing/strategies/nearest-depot.ts
import type { Depot, Parcel, RoutingStrategy } from "../types.js";

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineKm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The baseline everything else is measured against. */
export class NearestDepotStrategy implements RoutingStrategy {
  readonly name = "nearest-depot";

  score(parcel: Parcel, depot: Depot): number {
    return 1 / (1 + haversineKm(parcel.destination, depot.location));
  }
}
`;

const ROUTER_ROUND_ROBIN = `// src/routing/strategies/round-robin.ts
import type { Depot, Parcel, RoutingStrategy } from "../types.js";

/**
 * Ignores geography entirely and cycles through depots. Only used by the
 * soak test, where the point is to keep every depot warm rather than to
 * produce a sensible plan.
 */
export class RoundRobinStrategy implements RoutingStrategy {
  readonly name = "round-robin";

  #cursor = 0;

  score(_parcel: Parcel, depot: Depot): number {
    const bucket = this.#cursor % Math.max(1, depot.capacityUnits);
    this.#cursor += 1;
    return 1 - bucket / Math.max(1, depot.capacityUnits);
  }
}
`;

const ROUTER_DEPOT_CLIENT = `// src/depots/client.ts
//
// Polls the depot registry and hands the planner an immutable snapshot. A
// failed refresh keeps the previous snapshot and increments a counter: routing
// against slightly stale capacity is much better than routing against none.
import { SnapshotCache } from "./cache.js";
import type { DepotSnapshot } from "../routing/types.js";
import type { Logger } from "../telemetry/logger.js";

export interface DepotClientOptions {
  registryUrl: string;
  refreshMs: number;
  logger: Logger;
}

export class DepotClient {
  readonly #cache = new SnapshotCache();
  readonly #options: DepotClientOptions;
  #timer: NodeJS.Timeout | null = null;
  #consecutiveFailures = 0;

  constructor(options: DepotClientOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#options.refreshMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  snapshot(): DepotSnapshot {
    return this.#cache.current();
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch(this.#options.registryUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("registry responded " + response.status);
      this.#cache.replace((await response.json()) as DepotSnapshot);
      this.#consecutiveFailures = 0;
    } catch (error: unknown) {
      this.#consecutiveFailures += 1;
      this.#options.logger.warn(
        { error, failures: this.#consecutiveFailures },
        "depot registry refresh failed; serving the previous snapshot",
      );
    }
  }
}
`;

const ROUTER_DEPOT_CACHE = `// src/depots/cache.ts
import type { DepotSnapshot } from "../routing/types.js";

const EMPTY: DepotSnapshot = { fetchedAt: "1970-01-01T00:00:00.000Z", depots: [] };

/** Holds exactly one snapshot. Readers never see a half-written registry. */
export class SnapshotCache {
  #snapshot: DepotSnapshot = EMPTY;

  current(): DepotSnapshot {
    return this.#snapshot;
  }

  replace(next: DepotSnapshot): void {
    this.#snapshot = { fetchedAt: next.fetchedAt, depots: [...next.depots] };
  }

  get isEmpty(): boolean {
    return this.#snapshot.depots.length === 0;
  }
}
`;

const ROUTER_MANIFEST_PARSER = `// src/manifests/parser.ts
import { manifestSchema } from "@harborlight/manifest-schema";
import type { Parcel } from "../routing/types.js";

export interface ParseResult {
  parcels: Parcel[];
  /** Line numbers that failed validation, with the reason, for the DLQ. */
  errors: Array<{ line: number; message: string }>;
}

/**
 * Newline-delimited JSON in, parcels out. One bad line must never lose the
 * rest of the batch, so every line is validated independently.
 */
export function parseManifest(body: string): ParseResult {
  const parcels: Parcel[] = [];
  const errors: Array<{ line: number; message: string }> = [];

  body.split("\\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    try {
      const parsed = manifestSchema.parse(JSON.parse(trimmed));
      parcels.push({
        id: parsed.parcel_id,
        region: parsed.region,
        volumeUnits: parsed.volume_units,
        hazardClass: parsed.hazard_class ?? null,
        destination: { lat: parsed.destination.lat, lon: parsed.destination.lon },
        service: parsed.service,
      });
    } catch (error: unknown) {
      errors.push({ line: index + 1, message: error instanceof Error ? error.message : "invalid line" });
    }
  });

  return { parcels, errors };
}
`;

const ROUTER_MANIFEST_VALIDATE = `// src/manifests/validate.ts
import type { Parcel } from "../routing/types.js";

const REGIONS = new Set(["north", "midlands", "coast", "islands"]);

/** Cheap sanity checks the schema cannot express. Returns the failures. */
export function validateParcel(parcel: Parcel): string[] {
  const problems: string[] = [];
  if (!REGIONS.has(parcel.region)) problems.push("unknown region " + parcel.region);
  if (parcel.volumeUnits <= 0) problems.push("volumeUnits must be positive");
  if (parcel.volumeUnits > 2_400) problems.push("volumeUnits exceeds the freight ceiling");
  if (Math.abs(parcel.destination.lat) > 90) problems.push("destination.lat out of range");
  if (Math.abs(parcel.destination.lon) > 180) problems.push("destination.lon out of range");
  return problems;
}
`;

const ROUTER_QUEUE_INTAKE = `// src/queue/intake.ts
//
// Pulls manifest batches off the intake stream. The adapter is intentionally
// dumb: it hands raw bodies to the caller and acknowledges only once the
// caller says the batch was planned.
export interface IntakeBatch {
  id: string;
  body: string;
  receivedAt: string;
}

export interface IntakeAdapter {
  poll(max: number): Promise<IntakeBatch[]>;
  ack(batchId: string): Promise<void>;
  nack(batchId: string, reason: string): Promise<void>;
}

export function createMemoryIntake(batches: IntakeBatch[]): IntakeAdapter {
  const pending = [...batches];
  const inflight = new Map<string, IntakeBatch>();
  return {
    async poll(max) {
      const taken = pending.splice(0, max);
      for (const batch of taken) inflight.set(batch.id, batch);
      return taken;
    },
    async ack(batchId) {
      inflight.delete(batchId);
    },
    async nack(batchId) {
      const batch = inflight.get(batchId);
      if (batch !== undefined) pending.push(batch);
      inflight.delete(batchId);
    },
  };
}
`;

const ROUTER_QUEUE_OUTBOUND = `// src/queue/outbound.ts
import type { Assignment } from "../routing/types.js";

export interface OutboundAdapter {
  publish(assignments: readonly Assignment[]): Promise<void>;
}

/** Collects everything in memory. The soak test asserts against it. */
export function createMemoryOutbound(): OutboundAdapter & { published: Assignment[] } {
  const published: Assignment[] = [];
  return {
    published,
    async publish(assignments) {
      published.push(...assignments);
    },
  };
}
`;

const ROUTER_HTTP_SERVER = `// src/http/server.ts
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import type { Config } from "../config.js";
import type { DepotClient } from "../depots/client.js";
import type { Logger } from "../telemetry/logger.js";
import type { Metrics } from "../telemetry/metrics.js";

export interface ServerDeps {
  config: Config;
  depots: DepotClient;
  logger: Logger;
  metrics: Metrics;
}

export function createServer(deps: ServerDeps) {
  const app = Fastify({ loggerInstance: deps.logger, disableRequestLogging: true });
  app.addHook("onResponse", (request, reply, done) => {
    deps.metrics.observeRequest(request.method, reply.statusCode, reply.elapsedTime);
    done();
  });
  registerRoutes(app, deps);
  return app;
}
`;

const ROUTER_HTTP_ROUTES = `// src/http/routes.ts
import { badRequest } from "./errors.js";
import { parseManifest } from "../manifests/parser.js";
import { DepotRegistry } from "../routing/depot-registry.js";
import { Planner } from "../routing/planner.js";
import { WeightedDepotStrategy } from "../routing/strategies/weighted-depot.js";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "./server.js";

export function registerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    const snapshot = deps.depots.snapshot();
    if (snapshot.depots.length === 0) return reply.code(503).send({ ok: false, reason: "no-depots" });
    return { ok: true, depots: snapshot.depots.length, fetchedAt: snapshot.fetchedAt };
  });

  app.post("/v2/assign", async (request, reply) => {
    if (typeof request.body !== "string") return badRequest(reply, "expected an NDJSON body");
    const { parcels, errors } = parseManifest(request.body);
    if (parcels.length === 0) return badRequest(reply, "no valid parcels in the manifest");

    const snapshot = deps.depots.snapshot();
    const planner = new Planner(new DepotRegistry(snapshot), new WeightedDepotStrategy(), {
      capacityCeiling: deps.config.capacityCeiling,
      capacityHeadroomBonus: deps.config.capacityHeadroomBonus,
    });
    const plan = planner.plan(parcels, snapshot);
    deps.metrics.observePlan(plan.assignments.length, plan.rejections.length, plan.elapsedMs);
    return reply.code(200).send({ ...plan, manifestErrors: errors });
  });
}
`;

const ROUTER_HTTP_ERRORS = `// src/http/errors.ts
import type { FastifyReply } from "fastify";

export function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

export function conflict(reply: FastifyReply, message: string) {
  return reply.code(409).send({ error: message });
}
`;

const ROUTER_METRICS = `// src/telemetry/metrics.ts
export interface Metrics {
  observeRequest(method: string, status: number, elapsedMs: number): void;
  observePlan(assigned: number, rejected: number, elapsedMs: number): void;
  snapshot(): Record<string, number>;
}

/**
 * A counter bag rather than a real client: the scrape endpoint lives in the
 * platform sidecar, so all this service has to do is keep the numbers.
 */
export function createMetrics(): Metrics {
  const counters: Record<string, number> = {
    requests_total: 0,
    requests_failed_total: 0,
    parcels_assigned_total: 0,
    parcels_rejected_total: 0,
    plan_duration_ms_sum: 0,
    plan_duration_ms_count: 0,
  };
  return {
    observeRequest(_method, status) {
      counters.requests_total += 1;
      if (status >= 500) counters.requests_failed_total += 1;
    },
    observePlan(assigned, rejected, elapsedMs) {
      counters.parcels_assigned_total += assigned;
      counters.parcels_rejected_total += rejected;
      counters.plan_duration_ms_sum += elapsedMs;
      counters.plan_duration_ms_count += 1;
    },
    snapshot: () => ({ ...counters }),
  };
}
`;

const ROUTER_LOGGER = `// src/telemetry/logger.ts
export interface Logger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
  child(fields: object): Logger;
}

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** Line-delimited JSON on stdout. The platform collector does the rest. */
export function createLogger(level: keyof typeof ORDER, base: object = {}): Logger {
  const emit = (severity: keyof typeof ORDER, fields: object, message: string): void => {
    if (ORDER[severity] < ORDER[level]) return;
    process.stdout.write(
      JSON.stringify({ severity, time: new Date().toISOString(), ...base, ...fields, message }) + "\\n",
    );
  };
  return {
    debug: (fields, message) => emit("debug", fields, message),
    info: (fields, message) => emit("info", fields, message),
    warn: (fields, message) => emit("warn", fields, message),
    error: (fields, message) => emit("error", fields, message),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
`;

export const ROUTER_PLANNER_TEST = `// tests/routing/planner.test.ts
import { describe, expect, it } from "vitest";
import { DepotRegistry } from "../../src/routing/depot-registry.js";
import { Planner } from "../../src/routing/planner.js";
import { NearestDepotStrategy } from "../../src/routing/strategies/nearest-depot.js";
import type { Depot, DepotSnapshot, Parcel } from "../../src/routing/types.js";

function depot(overrides: Partial<Depot> = {}): Depot {
  return {
    id: "depot-north-1",
    name: "North 1",
    region: "north",
    online: true,
    capacityUnits: 100,
    usedUnits: 0,
    maxParcelVolumeUnits: 500,
    hazardClasses: [],
    location: { lat: 54.1, lon: -2.4 },
    ...overrides,
  };
}

function parcel(overrides: Partial<Parcel> = {}): Parcel {
  return {
    id: "parcel-1",
    region: "north",
    volumeUnits: 10,
    hazardClass: null,
    destination: { lat: 54, lon: -2.5 },
    service: "standard",
    ...overrides,
  };
}

function snapshotOf(depots: Depot[]): DepotSnapshot {
  return { fetchedAt: "2031-02-02T09:00:00.000Z", depots };
}

function plannerFor(snapshot: DepotSnapshot): Planner {
  return new Planner(new DepotRegistry(snapshot), new NearestDepotStrategy());
}

describe("Planner", () => {
  it("assigns a parcel to the only eligible depot", () => {
    const snapshot = snapshotOf([depot()]);
    const plan = plannerFor(snapshot).plan([parcel()], snapshot);
    expect(plan.assignments).toEqual([
      expect.objectContaining({ parcelId: "parcel-1", depotId: "depot-north-1" }),
    ]);
    expect(plan.rejections).toEqual([]);
  });

  it("skips offline depots and depots in another region", () => {
    const snapshot = snapshotOf([
      depot({ id: "offline", online: false }),
      depot({ id: "elsewhere", region: "coast" }),
      depot({ id: "keeper" }),
    ]);
    const plan = plannerFor(snapshot).plan([parcel()], snapshot);
    expect(plan.assignments[0]?.depotId).toBe("keeper");
  });

  it("rejects a parcel when every depot is already at the ceiling", () => {
    const snapshot = snapshotOf([depot({ capacityUnits: 100, usedUnits: 95 })]);
    const plan = plannerFor(snapshot).plan([parcel({ volumeUnits: 20 })], snapshot);
    expect(plan.assignments).toEqual([]);
    expect(plan.rejections[0]).toMatchObject({
      parcelId: "parcel-1",
      reason: "all-depots-at-capacity",
      considered: ["depot-north-1"],
    });
  });

  it("does not hand the same slot to two parcels in one batch", () => {
    const snapshot = snapshotOf([depot({ capacityUnits: 100, usedUnits: 80 })]);
    const plan = plannerFor(snapshot).plan(
      [parcel({ id: "a", volumeUnits: 10 }), parcel({ id: "b", volumeUnits: 10 })],
      snapshot,
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.rejections[0]?.reason).toBe("all-depots-at-capacity");
  });

  it("plans the heaviest parcel first", () => {
    const snapshot = snapshotOf([depot({ capacityUnits: 100, usedUnits: 0 })]);
    const plan = plannerFor(snapshot).plan(
      [parcel({ id: "small", volumeUnits: 5 }), parcel({ id: "large", volumeUnits: 60 })],
      snapshot,
    );
    expect(plan.assignments.map((assignment) => assignment.parcelId)).toEqual(["large", "small"]);
  });

  it("reports headroom left after the assignment", () => {
    const snapshot = snapshotOf([depot({ capacityUnits: 200, usedUnits: 0 })]);
    const plan = plannerFor(snapshot).plan([parcel({ volumeUnits: 50 })], snapshot);
    expect(plan.assignments[0]?.headroomAfter).toBeCloseTo(0.75, 5);
  });
});
`;

const ROUTER_GUARD_TEST = `// tests/routing/capacity-guard.test.ts
import { describe, expect, it } from "vitest";
import { CapacityGuard } from "../../src/routing/capacity-guard.js";
import type { DepotSnapshot } from "../../src/routing/types.js";

const snapshot: DepotSnapshot = {
  fetchedAt: "2031-02-02T09:00:00.000Z",
  depots: [
    {
      id: "depot-coast-2",
      name: "Coast 2",
      region: "coast",
      online: true,
      capacityUnits: 100,
      usedUnits: 40,
      maxParcelVolumeUnits: 400,
      hazardClasses: [],
      location: { lat: 50.7, lon: -1.9 },
    },
  ],
};

const options = { ceiling: 0.9, allowOverflow: false };

describe("CapacityGuard", () => {
  it("admits a parcel that stays under the ceiling", () => {
    expect(new CapacityGuard(snapshot, options).admits("depot-coast-2", 40)).toBe(true);
  });

  it("refuses a parcel that would cross the ceiling", () => {
    expect(new CapacityGuard(snapshot, options).admits("depot-coast-2", 60)).toBe(false);
  });

  it("refuses an unknown depot", () => {
    expect(new CapacityGuard(snapshot, options).admits("depot-nowhere", 1)).toBe(false);
  });

  it("accumulates reservations", () => {
    const guard = new CapacityGuard(snapshot, options);
    guard.reserve("depot-coast-2", 40);
    expect(guard.admits("depot-coast-2", 20)).toBe(false);
    expect(guard.headroom("depot-coast-2")).toBeCloseTo(0.2, 5);
  });

  it("ignores the ceiling when overflow is allowed", () => {
    const guard = new CapacityGuard(snapshot, { ceiling: 0.9, allowOverflow: true });
    expect(guard.admits("depot-coast-2", 5_000)).toBe(true);
  });
});
`;

const ROUTER_PARSER_TEST = `// tests/manifests/parser.test.ts
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/manifests/parser.js";

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    parcel_id: "p-1",
    region: "north",
    volume_units: 12,
    service: "standard",
    destination: { lat: 54, lon: -2.5 },
    ...overrides,
  });

describe("parseManifest", () => {
  it("parses every valid line", () => {
    const result = parseManifest([line(), line({ parcel_id: "p-2" })].join("\\n"));
    expect(result.parcels.map((parcel) => parcel.id)).toEqual(["p-1", "p-2"]);
    expect(result.errors).toEqual([]);
  });

  it("keeps the good lines when one is malformed", () => {
    const result = parseManifest([line(), "{not json", line({ parcel_id: "p-3" })].join("\\n"));
    expect(result.parcels).toHaveLength(2);
    expect(result.errors[0]?.line).toBe(2);
  });

  it("ignores blank lines", () => {
    expect(parseManifest("\\n\\n" + line() + "\\n\\n").parcels).toHaveLength(1);
  });
});
`;

const ROUTER_DESIGN_DOC = `# Routing design

## Why the planner is pure

Routing decisions are replayed constantly: an operator wants to know why a
parcel went where it did, and the on-call engineer wants to run yesterday's
manifests against a proposed change. Both are trivial when the planner is a
function of \`(parcels, snapshot, options)\` and impossible when it reaches for
the registry itself. The one rule the module has is therefore: no I/O below
\`src/http\`.

## Scoring

Every eligible depot is scored by the configured strategy, then nudged by the
capacity headroom bonus:

    score = strategy.score(parcel, depot) + headroom(depot) * headroomBonus

The bonus exists because pure proximity drains the network unevenly. With the
nearest-depot strategy alone, the depot closest to the dense part of a region
reaches the ceiling by early afternoon while its neighbour sits half empty, and
everything that arrives after that is rejected outright.

## The capacity ceiling

A depot stops accepting at \`DEPOT_CAPACITY_CEILING\` (default 0.92) rather than
at 1.0. The last few percent are reserved for parcels that are already in
transit toward the depot and are not visible in the registry snapshot. The
override — \`allowOverflowDepots\` — exists for the recovery case where a region
has lost a depot and the alternative to overflowing is rejecting everything.

## Batch ordering

Parcels are planned heaviest-first. Packing the awkward items while headroom is
still plentiful leaves the small ones to fill the gaps; replaying the October
manifests showed about 4% fewer rejections than arrival order.

## What is deliberately not here

* No re-planning. A rejected parcel goes back to the queue with a reason and is
  re-planned on the next pass against a fresh snapshot.
* No cross-region fallback. Moving a parcel between regions is a commercial
  decision, not a routing one.
`;

const ROUTER_RUNBOOK = `# Runbook: parcel-router

## Symptom: rejection rate spikes

1. Check \`parcels_rejected_total\` against \`parcels_assigned_total\`. A ratio
   above 0.05 sustained for ten minutes is the alert threshold.
2. Look at the rejection reasons in the plan responses. \`all-depots-at-capacity\`
   means the network is genuinely full; \`no-eligible-depot\` almost always means
   a registry problem.
3. If the reason is \`no-eligible-depot\`, hit \`/readyz\`. A stale \`fetchedAt\`
   means the registry refresh is failing and the service is planning against an
   old snapshot.

## Symptom: /readyz returns 503 with no-depots

The registry has never answered since boot. Confirm \`DEPOT_REGISTRY_URL\`
resolves from inside the pod, then restart. The service intentionally does not
serve traffic with an empty registry — routing everything to a default depot
was worse than rejecting.

## Symptom: one depot is over its ceiling

Someone has set \`DEPOT_CAPACITY_CEILING\` above 1, or \`allowOverflowDepots\` is
still on from a recovery. Both are visible in the boot log line.

## Scheduled work

* Registry snapshots are kept for 14 days for replay.
* The soak test runs nightly against the previous day's manifests.
`;

const ROUTER_ALERTS = `# Alerts

| Alert                     | Condition                                   | Page? |
| ------------------------- | ------------------------------------------- | ----- |
| RouterRejectionRateHigh   | rejected / assigned > 0.05 for 10m          | yes   |
| RouterRegistryStale       | now - fetchedAt > 5m                        | yes   |
| RouterPlanLatencyHigh     | p99 plan duration > 250ms for 15m           | no    |
| RouterNotReady            | /readyz non-200 for 3m                      | yes   |

Every alert links back to \`docs/operations/runbook.md\`. An alert without a
runbook entry is not allowed to page.
`;

const ROUTER_SCRATCH = `# capacity scratch

Working notes while the guard was going in. Not committed on purpose — this is
the untracked file the Changes page shows with a "?".

- ceiling at 0.92 comes from the incident review, not from measurement. Worth
  replaying a week of manifests at 0.88 / 0.92 / 0.96 and comparing rejection
  counts before we treat it as settled.
- headroom bonus interacts with the express service weight: an express parcel
  can still be pulled to a fuller-but-closer depot. That is probably correct
  but it is not written down anywhere.
- reserve() throws on an unknown depot. The planner only ever calls it after
  admits() returned true, so the throw is unreachable today. Keep it — the
  alternative is a silent miscount if the two ever drift apart.
- open question: should the guard know about parcels already in transit rather
  than approximating them with the ceiling? Needs a registry change.
`;

// ─── depot-console ───────────────────────────────────────────────────────────

const CONSOLE_README = `# depot-console

The operator view of the parcel network: which depots are online, how full each
one is, and which parcels were rejected in the last hour.

    npm install
    npm run dev

The dev server proxies \`/v2\` to a local parcel-router (see \`vite.config.ts\`),
so run that first or set \`VITE_ROUTER_ORIGIN\` at a staging deployment.
`;

const CONSOLE_PACKAGE_JSON = `{
  "name": "@harborlight/depot-console",
  "version": "1.4.2",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
`;

const CONSOLE_VITE_CONFIG = `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const routerOrigin = process.env.VITE_ROUTER_ORIGIN ?? "http://127.0.0.1:8420";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: process.env.VITE_ALLOWED_HOSTS === "all" ? true : undefined,
    proxy: { "/v2": { target: routerOrigin, changeOrigin: true } },
  },
});
`;

const CONSOLE_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Depot console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const CONSOLE_MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const CONSOLE_APP = `import { useEffect, useState } from "react";
import { DepotTable } from "./components/DepotTable.js";
import { fetchDepots, type DepotRow } from "./api/client.js";

const REFRESH_MS = 15_000;

export function App() {
  const [rows, setRows] = useState<DepotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchDepots()
        .then((next) => {
          if (cancelled) return;
          setRows(next);
          setError(null);
        })
        .catch((cause: Error) => {
          if (!cancelled) setError(cause.message);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <main className="console">
      <h1>Depot network</h1>
      {error !== null && <p role="alert">{error}</p>}
      {rows === null ? <p>Loading depots…</p> : <DepotTable rows={rows} />}
    </main>
  );
}
`;

const CONSOLE_API_CLIENT = `export interface DepotRow {
  id: string;
  name: string;
  region: string;
  online: boolean;
  usedUnits: number;
  capacityUnits: number;
}

export async function fetchDepots(): Promise<DepotRow[]> {
  const response = await fetch("/v2/depots", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Depot registry responded " + response.status);
  const body = (await response.json()) as { depots: DepotRow[] };
  return body.depots;
}
`;

const CONSOLE_DEPOT_TABLE = `import { CapacityBadge } from "./CapacityBadge.js";
import type { DepotRow } from "../api/client.js";

export function DepotTable({ rows }: { rows: DepotRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Depot</th>
          <th>Region</th>
          <th>State</th>
          <th>Load</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{row.region}</td>
            <td>{row.online ? "online" : "offline"}</td>
            <td>
              <CapacityBadge used={row.usedUnits} capacity={row.capacityUnits} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
`;

const CONSOLE_CAPACITY_BADGE = `const CEILING = 0.92;

export function CapacityBadge({ used, capacity }: { used: number; capacity: number }) {
  const share = capacity <= 0 ? 1 : used / capacity;
  const tone = share >= CEILING ? "full" : share >= 0.75 ? "busy" : "ok";
  return (
    <span className={"badge badge-" + tone} title={used + " of " + capacity + " units"}>
      {Math.round(share * 100)}%
    </span>
  );
}
`;

const CONSOLE_CSS = `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}

.console {
  margin: 0 auto;
  max-width: 60rem;
  padding: 2rem 1rem;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th,
td {
  border-bottom: 1px solid rgba(127, 127, 127, 0.3);
  padding: 0.5rem 0.75rem;
  text-align: left;
}

.badge {
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
  padding: 0.1rem 0.5rem;
}

.badge-ok {
  background: rgba(16, 185, 129, 0.15);
}

.badge-busy {
  background: rgba(245, 158, 11, 0.18);
}

.badge-full {
  background: rgba(239, 68, 68, 0.18);
}
`;

// ─── manifest-schema ─────────────────────────────────────────────────────────

const SCHEMA_README = `# manifest-schema

The one definition of an inbound parcel manifest, shared by the router and the
console. Publishing it as a package rather than copying the shape around is the
only reason the two stay in step.

    npm install
    npm test
`;

const SCHEMA_PACKAGE_JSON = `{
  "name": "@harborlight/manifest-schema",
  "version": "0.9.3",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.24.1"
  }
}
`;

const SCHEMA_INDEX = `export { manifestSchema, type Manifest } from "./manifest.js";
export { depotSchema, type Depot } from "./depot.js";
`;

const SCHEMA_MANIFEST = `import { z } from "zod";

export const manifestSchema = z.object({
  parcel_id: z.string().min(1),
  region: z.enum(["north", "midlands", "coast", "islands"]),
  volume_units: z.number().positive().max(2_400),
  hazard_class: z.string().min(1).optional(),
  service: z.enum(["standard", "express", "freight"]),
  destination: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;
`;

const SCHEMA_DEPOT = `import { z } from "zod";

export const depotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.enum(["north", "midlands", "coast", "islands"]),
  online: z.boolean(),
  capacity_units: z.number().nonnegative(),
  used_units: z.number().nonnegative(),
  max_parcel_volume_units: z.number().positive(),
  hazard_classes: z.array(z.string()).default([]),
  location: z.object({ lat: z.number(), lon: z.number() }),
});

export type Depot = z.infer<typeof depotSchema>;
`;

/**
 * Every readable file in the demo workspace, keyed by absolute path. The
 * directory tree is derived from these keys — add a file here and it shows up
 * in `GET /files/tree` automatically.
 */
export const WORKSPACE_FILES: Readonly<Record<string, string>> = {
  // parcel-router
  [`${ROUTER_REPO}/README.md`]: ROUTER_README,
  [`${ROUTER_REPO}/package.json`]: ROUTER_PACKAGE_JSON,
  [`${ROUTER_REPO}/tsconfig.json`]: ROUTER_TSCONFIG,
  [`${ROUTER_REPO}/src/index.ts`]: ROUTER_INDEX,
  [`${ROUTER_REPO}/src/config.ts`]: ROUTER_CONFIG,
  [`${ROUTER_REPO}/src/routing/planner.ts`]: ROUTER_PLANNER,
  [`${ROUTER_REPO}/src/routing/capacity-guard.ts`]: ROUTER_CAPACITY_GUARD,
  [`${ROUTER_REPO}/src/routing/depot-registry.ts`]: ROUTER_DEPOT_REGISTRY,
  [`${ROUTER_REPO}/src/routing/types.ts`]: ROUTER_TYPES,
  [`${ROUTER_REPO}/src/routing/strategies/weighted-depot.ts`]: ROUTER_WEIGHTED,
  [`${ROUTER_REPO}/src/routing/strategies/nearest-depot.ts`]: ROUTER_NEAREST,
  [`${ROUTER_REPO}/src/routing/strategies/round-robin.ts`]: ROUTER_ROUND_ROBIN,
  [`${ROUTER_REPO}/src/depots/client.ts`]: ROUTER_DEPOT_CLIENT,
  [`${ROUTER_REPO}/src/depots/cache.ts`]: ROUTER_DEPOT_CACHE,
  [`${ROUTER_REPO}/src/manifests/parser.ts`]: ROUTER_MANIFEST_PARSER,
  [`${ROUTER_REPO}/src/manifests/validate.ts`]: ROUTER_MANIFEST_VALIDATE,
  [`${ROUTER_REPO}/src/queue/intake.ts`]: ROUTER_QUEUE_INTAKE,
  [`${ROUTER_REPO}/src/queue/outbound.ts`]: ROUTER_QUEUE_OUTBOUND,
  [`${ROUTER_REPO}/src/http/server.ts`]: ROUTER_HTTP_SERVER,
  [`${ROUTER_REPO}/src/http/routes.ts`]: ROUTER_HTTP_ROUTES,
  [`${ROUTER_REPO}/src/http/errors.ts`]: ROUTER_HTTP_ERRORS,
  [`${ROUTER_REPO}/src/telemetry/metrics.ts`]: ROUTER_METRICS,
  [`${ROUTER_REPO}/src/telemetry/logger.ts`]: ROUTER_LOGGER,
  [`${ROUTER_REPO}/tests/routing/planner.test.ts`]: ROUTER_PLANNER_TEST,
  [`${ROUTER_REPO}/tests/routing/capacity-guard.test.ts`]: ROUTER_GUARD_TEST,
  [`${ROUTER_REPO}/tests/manifests/parser.test.ts`]: ROUTER_PARSER_TEST,
  [`${ROUTER_REPO}/docs/routing-design.md`]: ROUTER_DESIGN_DOC,
  [`${ROUTER_REPO}/docs/operations/runbook.md`]: ROUTER_RUNBOOK,
  [`${ROUTER_REPO}/docs/operations/alerts.md`]: ROUTER_ALERTS,
  [`${ROUTER_REPO}/notes/capacity-scratch.md`]: ROUTER_SCRATCH,

  // depot-console
  [`${CONSOLE_REPO}/README.md`]: CONSOLE_README,
  [`${CONSOLE_REPO}/package.json`]: CONSOLE_PACKAGE_JSON,
  [`${CONSOLE_REPO}/vite.config.ts`]: CONSOLE_VITE_CONFIG,
  [`${CONSOLE_REPO}/index.html`]: CONSOLE_INDEX_HTML,
  [`${CONSOLE_REPO}/src/main.tsx`]: CONSOLE_MAIN,
  [`${CONSOLE_REPO}/src/App.tsx`]: CONSOLE_APP,
  [`${CONSOLE_REPO}/src/index.css`]: CONSOLE_CSS,
  [`${CONSOLE_REPO}/src/api/client.ts`]: CONSOLE_API_CLIENT,
  [`${CONSOLE_REPO}/src/components/DepotTable.tsx`]: CONSOLE_DEPOT_TABLE,
  [`${CONSOLE_REPO}/src/components/CapacityBadge.tsx`]: CONSOLE_CAPACITY_BADGE,

  // manifest-schema
  [`${SCHEMA_REPO}/README.md`]: SCHEMA_README,
  [`${SCHEMA_REPO}/package.json`]: SCHEMA_PACKAGE_JSON,
  [`${SCHEMA_REPO}/src/index.ts`]: SCHEMA_INDEX,
  [`${SCHEMA_REPO}/src/manifest.ts`]: SCHEMA_MANIFEST,
  [`${SCHEMA_REPO}/src/depot.ts`]: SCHEMA_DEPOT,
};

const ALL_PATHS = Object.keys(WORKSPACE_FILES);

export interface DirectoryListing {
  dirs: string[];
  files: string[];
}

/**
 * path → { immediate subdirectories, immediate files }, built once from
 * `WORKSPACE_FILES`. Both lists are sorted by name, matching the real BFF
 * (which sorts its `find` output) and keeping pagination deterministic.
 */
const LISTINGS: Map<string, DirectoryListing> = (() => {
  const listings = new Map<string, DirectoryListing>();
  const ensure = (dir: string): DirectoryListing => {
    let entry = listings.get(dir);
    if (entry === undefined) {
      entry = { dirs: [], files: [] };
      listings.set(dir, entry);
    }
    return entry;
  };

  ensure(WORKSPACE_ROOT);
  for (const filePath of ALL_PATHS) {
    const relative = filePath.slice(WORKSPACE_ROOT.length + 1).split("/");
    let dir = WORKSPACE_ROOT;
    for (let i = 0; i < relative.length - 1; i += 1) {
      const child = `${dir}/${relative[i]}`;
      const parent = ensure(dir);
      if (!parent.dirs.includes(child)) parent.dirs.push(child);
      dir = child;
      ensure(dir);
    }
    ensure(dir).files.push(filePath);
  }

  const byBasename = (a: string, b: string): number =>
    basename(a).localeCompare(basename(b));
  for (const listing of listings.values()) {
    listing.dirs.sort(byBasename);
    listing.files.sort(byBasename);
  }
  return listings;
})();

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Immediate children of a directory, or null when it is not a directory. */
export function listDirectory(path: string): DirectoryListing | null {
  return LISTINGS.get(path) ?? null;
}

export function isDirectory(path: string): boolean {
  return LISTINGS.has(path);
}

export function readFile(path: string): string | null {
  return Object.prototype.hasOwnProperty.call(WORKSPACE_FILES, path)
    ? WORKSPACE_FILES[path]
    : null;
}
