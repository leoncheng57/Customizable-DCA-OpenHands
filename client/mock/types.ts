// client/mock/types.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// THE MOCK BACKEND CONTRACT — read this file before writing a handler group.
// ═══════════════════════════════════════════════════════════════════════════
//
// In demo mode (`VITE_DEMO=1`, see ../main.tsx and ./install.ts) there is no
// BFF and no agent-server. `window.fetch` and `window.EventSource` are patched
// so that every same-origin request to `/api/openhands/*` is answered from
// this directory instead of the network. Everything else — Google Fonts, the
// app's own assets, third-party links — passes straight through.
//
// The surface is split into four HANDLER GROUPS, one file each, one owner
// each. A group is a plain object; it declares routes and (optionally) SSE
// streams. Nothing else in this directory needs to change when a group is
// filled in:
//
//   ./conversations.ts   status, conversation CRUD, events, run control, SSE
//   ./manager.ts         everything under /manager/*
//   ./workspace.ts       files, git, terminal, disk, preview
//   ./settings.ts        repos, tools, skills, notifications, MR
//
// ---------------------------------------------------------------------------
// Route keys
// ---------------------------------------------------------------------------
//
// A route key is `"<METHOD> <pattern>"`, e.g.
//
//   "GET /conversations"
//   "GET /conversations/:id/events"
//   "POST /conversations/:id/run"
//   "GET /git/commits/:sha/changes"
//   "GET /preview/*"
//
// The pattern is the request path with the deploy base path and the
// `/api/openhands` prefix already stripped, so it always starts with a single
// `/` and never contains a query string. Segments may be:
//
//   literal   matched verbatim, case-sensitively
//   :name     matches exactly one segment; the decoded value lands in
//             `req.params.name`
//   *         only valid as the LAST segment; matches the remaining path
//             (possibly empty) into `req.params["*"]`
//
// When several patterns match, the most specific one wins: more literal
// segments first, then more segments overall, then a non-wildcard pattern over
// a wildcard one. So `"GET /conversations/:id/events"` beats `"GET /*"`, and
// `"GET /preview/config"` beats `"GET /preview/*"`.
//
// ---------------------------------------------------------------------------
// Return values
// ---------------------------------------------------------------------------
//
// A handler returns the RESPONSE BODY. It is serialized with `JSON.stringify`
// and sent as `200 application/json`:
//
//   "GET /disk": () => ({ workspaceRoot: "/workspace", … }) satisfies DiskUsage
//
// Returning `undefined` sends `200 null` — which is what several real
// endpoints do (`GET /conversations/:id/agent_final_response` returns a bare
// `null` before the agent finishes).
//
// For anything else use the two escape hatches:
//
//   throw new MockHttpError(404, "Run not found")   → 404 {"error":"Run not found"}
//   return mockResponse(body, { status: 201 })      → full control
//
// `MockHttpError` matters because `json<T>()` in `client/lib/api.ts` reads
// `body.error` off a non-2xx response and turns it into the `Error` the page
// renders. A demo that wants to show an error state should throw one, not
// return an `{ error }` object with a 200.
//
// An unexpected throw becomes `500 {"error": <message>}` — the UI will show it
// rather than hang, which is the right failure mode for a demo.
//
// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------
//
// Every body must be typed against the interfaces the real client already
// declares. Import them directly — do not redeclare them here:
//
//   import type { ConversationSummary, DiskUsage } from "../lib/api.js";
//   import type { BoardState, RunRecord }           from "../lib/manager-api.js";
//   import type { RawOpenHandsEvent }               from "../lib/events.js";
//
// `satisfies` is the cheap way to get that checked without widening the
// handler's return type:
//
//   "GET /conversations": () => ({ items: [] satisfies ConversationSummary[] }),
//
// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------
//
// `GET /conversations/:id/stream` is an SSE endpoint, so it lives in `streams`
// rather than `routes`. The handler is handed a controller and may emit named
// frames for as long as it likes; return a cleanup function to stop timers
// when the page closes the stream.
//
//   streams: {
//     "GET /conversations/:id/stream": (req, ctrl) => {
//       const t = setInterval(() => ctrl.emit({ event: "delta", data: JSON.stringify({ content: "…" }) }), 400);
//       return () => clearInterval(t);
//     },
//   }
//
// The transcript is POLLED every 3s regardless, so a silent stream is a
// perfectly good stream: leaving `streams` empty costs nothing.
//
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
//
//   ./clock.ts   DEMO_START / elapsedMs() / isoAt() — reveal content by
//                wall-clock offset from page load instead of hardcoding dates
//   ./state.ts   a generic in-memory store for mutable demo state (a POST
//                that the following GET has to reflect)
//
// Fixtures (JSON or `.ts` modules) belong in ./fixtures/. `tests/mock-fixtures.test.ts`
// scans this whole directory and fails the build if a real-world project,
// company, host or user name leaks into it. Demo data is invented data.

/** One intercepted request, normalized for handlers. */
export interface MockRequest {
  /** Upper-case verb: `"GET"`, `"POST"`, `"PATCH"`, `"PUT"`, `"DELETE"`. */
  method: string;
  /**
   * Pathname with the deploy base path and the `/api/openhands` prefix
   * stripped. Always starts with `/`, never has a trailing slash (except for
   * the root `"/"`), never contains a query string.
   */
  path: string;
  /** Decoded `:param` captures from the matched route key. */
  params: Record<string, string>;
  /** Parsed query string. */
  query: URLSearchParams;
  /** Parsed JSON request body, or `undefined` when there was none. */
  body: unknown;
  /** Request headers as sent by the app. */
  headers: Headers;
  /** The absolute URL the app asked for — useful for logging. */
  url: URL;
}

/** A route handler. Return the response body; see the header comment. */
export type MockHandler = (req: MockRequest) => unknown | Promise<unknown>;

/** One server-sent-events frame. */
export interface MockStreamEvent {
  /** SSE event name. Defaults to `"message"`. */
  event?: string;
  /** Frame payload — already-serialized text, usually `JSON.stringify(…)`. */
  data?: string;
  /** Optional SSE id field. */
  id?: string;
}

/** Handle to a live SSE connection, handed to a stream handler. */
export interface MockStreamController {
  /** Deliver one frame to the page. No-op once the stream is closed. */
  emit(frame: MockStreamEvent): void;
  /** End the stream (fires `error` on the page's EventSource, as a real close does). */
  close(): void;
  /** True once the page called `close()` or the stream ended. */
  readonly closed: boolean;
}

/**
 * An SSE handler. Runs once per connection, after the page's `open` event.
 * Return a cleanup function to release timers when the connection ends.
 */
export type MockStreamHandler = (
  req: MockRequest,
  controller: MockStreamController,
) => void | (() => void) | Promise<void | (() => void)>;

/** One owned slice of the API surface. Exactly one per file in this directory. */
export interface HandlerGroup {
  /** Stable identifier, used in warnings and duplicate-route diagnostics. */
  name: string;
  /** Request/response routes, keyed `"<METHOD> <pattern>"`. */
  routes: Record<string, MockHandler>;
  /** SSE routes, keyed the same way. Optional. */
  streams?: Record<string, MockStreamHandler>;
}

/** Explicit non-2xx response. `json<T>()` in lib/api.ts surfaces `message`. */
export class MockHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MockHttpError";
    this.status = status;
  }
}

const MOCK_RESPONSE = Symbol.for("openhands.mock.response");

/** A handler return value carrying an explicit status / headers. */
export interface MockResponseBody {
  readonly [MOCK_RESPONSE]: true;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Wrap a body when the default `200 application/json` is not what you want. */
export function mockResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): MockResponseBody {
  return {
    [MOCK_RESPONSE]: true,
    status: init.status ?? 200,
    headers: init.headers ?? {},
    body,
  };
}

export function isMockResponse(value: unknown): value is MockResponseBody {
  return typeof value === "object" && value !== null && MOCK_RESPONSE in value;
}

/** What the registry hands back to the fetch patch. */
export interface MockResult {
  status: number;
  headers: Record<string, string>;
  /** Serialized response body. */
  text: string;
  /** True when no group claimed the route (install.ts warns once per route). */
  unhandled: boolean;
}
