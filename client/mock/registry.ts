// client/mock/registry.ts
//
// Route table for the demo backend: handler groups register here, and the
// fetch/EventSource patches in ./install.ts ask it to resolve a method+path.
//
// The matcher is deliberately tiny (no dependency, no regex compilation) but
// it is the piece four independent handler groups agree on, so its rules are
// spelled out in ./types.ts and pinned by tests/mock-fixtures.test.ts.
import {
  isMockResponse,
  MockHttpError,
  type HandlerGroup,
  type MockHandler,
  type MockRequest,
  type MockResult,
  type MockStreamHandler,
} from "./types.js";

const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

interface CompiledRoute<T> {
  key: string;
  group: string;
  method: string;
  segments: string[];
  /** Trailing `*`: the pattern absorbs the rest of the path. */
  wildcard: boolean;
  handler: T;
}

const routes: Array<CompiledRoute<MockHandler>> = [];
const streams: Array<CompiledRoute<MockStreamHandler>> = [];
const registered = new Set<string>();

function compile<T>(group: string, key: string, handler: T): CompiledRoute<T> {
  if (!ROUTE_KEY.test(key)) {
    throw new Error(
      `[mock] ${group}: invalid route key ${JSON.stringify(key)} — expected "<METHOD> /path", e.g. "GET /conversations/:id/events"`,
    );
  }
  const [method, pattern] = key.split(" ") as [string, string];
  const segments = splitPath(pattern);
  const wildcard = segments[segments.length - 1] === "*";
  if (segments.indexOf("*") !== -1 && !wildcard) {
    throw new Error(`[mock] ${group}: "*" is only allowed as the last segment of ${JSON.stringify(key)}`);
  }
  return { key, group, method, segments: wildcard ? segments.slice(0, -1) : segments, wildcard, handler };
}

/** Split a path into segments, dropping the leading/trailing empties. */
function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/**
 * Add a group's routes to the table. Idempotent per group name so a
 * double-install (React StrictMode, HMR) does not duplicate the table.
 */
export function registerGroup(group: HandlerGroup): void {
  if (registered.has(group.name)) return;
  registered.add(group.name);
  for (const [key, handler] of Object.entries(group.routes)) {
    const existing = routes.find((r) => r.key === key);
    if (existing) {
      throw new Error(`[mock] duplicate route ${JSON.stringify(key)} — owned by "${existing.group}", also declared by "${group.name}"`);
    }
    routes.push(compile(group.name, key, handler));
  }
  for (const [key, handler] of Object.entries(group.streams ?? {})) {
    const existing = streams.find((r) => r.key === key);
    if (existing) {
      throw new Error(`[mock] duplicate stream ${JSON.stringify(key)} — owned by "${existing.group}", also declared by "${group.name}"`);
    }
    streams.push(compile(group.name, key, handler));
  }
}

/** Drop every registration. Tests only. */
export function resetRegistry(): void {
  routes.length = 0;
  streams.length = 0;
  registered.clear();
}

/** Every registered route key, for diagnostics. */
export function registeredRoutes(): string[] {
  return [...routes.map((r) => r.key), ...streams.map((r) => r.key)].sort();
}

export interface RouteMatch<T> {
  key: string;
  group: string;
  params: Record<string, string>;
  handler: T;
}

function tryMatch<T>(route: CompiledRoute<T>, method: string, parts: string[]): Record<string, string> | null {
  if (route.method !== method) return null;
  if (route.wildcard ? parts.length < route.segments.length : parts.length !== route.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const seg = route.segments[i];
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = safeDecode(parts[i]);
      continue;
    }
    if (seg !== parts[i]) return null;
  }
  if (route.wildcard) params["*"] = parts.slice(route.segments.length).map(safeDecode).join("/");
  return params;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Most-specific-wins ranking: more literal segments beats fewer, then more
 * segments overall, then an exact pattern beats a wildcard one. So
 * `/preview/config` wins over `/preview/*`, and `/conversations/:id/events`
 * wins over `/conversations/:id/*`.
 */
function score<T>(route: CompiledRoute<T>): [number, number, number] {
  const literals = route.segments.filter((s) => !s.startsWith(":")).length;
  return [literals, route.segments.length, route.wildcard ? 0 : 1];
}

function pickBest<T>(candidates: Array<{ route: CompiledRoute<T>; params: Record<string, string> }>) {
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const a = score(candidate.route);
    const b = score(best.route);
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = candidate;
  }
  return best;
}

function match<T>(table: Array<CompiledRoute<T>>, method: string, path: string): RouteMatch<T> | null {
  const parts = splitPath(path);
  const candidates: Array<{ route: CompiledRoute<T>; params: Record<string, string> }> = [];
  for (const route of table) {
    const params = tryMatch(route, method, parts);
    if (params) candidates.push({ route, params });
  }
  if (candidates.length === 0) return null;
  const { route, params } = pickBest(candidates);
  return { key: route.key, group: route.group, params, handler: route.handler };
}

/** Resolve a request/response route, or null when nothing claims it. */
export function matchRoute(method: string, path: string): RouteMatch<MockHandler> | null {
  return match(routes, method, path);
}

/** Resolve an SSE route, or null when nothing claims it. */
export function matchStream(method: string, path: string): RouteMatch<MockStreamHandler> | null {
  return match(streams, method, path);
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Run the handler for a request and normalize whatever it did into a result
 * the fetch patch can turn into a `Response`.
 *
 * Nothing here throws: a 404 for an unclaimed route and a 500 for a broken
 * handler are both delivered as `{ error }` bodies, which is exactly what
 * `json<T>()` in `client/lib/api.ts` unpacks into the error the UI renders.
 */
export async function dispatch(request: MockRequest): Promise<MockResult> {
  const found = matchRoute(request.method, request.path);
  if (!found) {
    return {
      status: 404,
      headers: { ...JSON_HEADERS },
      text: JSON.stringify({ error: `No demo data for ${request.method} ${request.path}` }),
      unhandled: true,
    };
  }
  try {
    const value = await found.handler({ ...request, params: found.params });
    if (isMockResponse(value)) {
      return {
        status: value.status,
        headers: { ...JSON_HEADERS, ...value.headers },
        text: JSON.stringify(value.body ?? null),
        unhandled: false,
      };
    }
    return { status: 200, headers: { ...JSON_HEADERS }, text: JSON.stringify(value ?? null), unhandled: false };
  } catch (err) {
    const status = err instanceof MockHttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : `Demo handler ${found.key} failed`;
    if (status >= 500) console.error(`[mock] ${found.group} ${found.key} threw:`, err);
    return { status, headers: { ...JSON_HEADERS }, text: JSON.stringify({ error: message }), unhandled: false };
  }
}
