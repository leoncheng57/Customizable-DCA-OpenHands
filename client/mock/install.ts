// client/mock/install.ts
//
// Demo mode's only entry point: patches `window.fetch` and `window.EventSource`
// so the app talks to ./registry.ts instead of a BFF that does not exist on
// GitHub Pages.
//
// `installMockBackend()` is called from ../main.tsx behind
// `if (import.meta.env.VITE_DEMO)`. vite.config.ts inlines that flag as a
// literal in EVERY build, so the self-hosted build folds the branch away and
// Rollup drops this subtree — which is why nothing in this file runs, and no
// global is touched, at module-evaluation time. Keep it that way: a single
// impure top-level statement (a bare `new`, a `class … extends EventTarget`)
// pins the whole demo backend into the production bundle.
//
// Scope of the interception, deliberately narrow:
//   · same-origin only, and only paths under `/api/openhands` (with or without
//     the deploy base path in front). Fonts, images, the app's own chunks and
//     every cross-origin URL go to the real `fetch` untouched.
//   · unhandled-but-intercepted routes answer 404 `{error}` — the shape
//     `json<T>()` in lib/api.ts unpacks — and are logged ONCE each so the
//     handler-group owners can see exactly what is still missing.
import { dispatch, matchStream, registerGroup } from "./registry.js";
import type { MockRequest, MockStreamController, MockStreamEvent } from "./types.js";

import { handlers as conversations } from "./conversations.js";
import { handlers as manager } from "./manager.js";
import { handlers as settings } from "./settings.js";
import { handlers as workspace } from "./workspace.js";

const API_PREFIX = "/api/openhands";

/** Artificial round-trip so the UI's skeletons and spinners actually appear. */
const LATENCY_MIN_MS = 80;
const LATENCY_MAX_MS = 200;

const INSTALLED_FLAG = "__openhandsMockInstalled";

function latency(): number {
  return LATENCY_MIN_MS + Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Routes we intercepted but nobody claimed — reported once each, not per poll. */
let warned: Set<string> | null = null;

function warnOnce(route: string): void {
  warned ??= new Set<string>();
  if (warned.has(route)) return;
  warned.add(route);
  console.warn(`[demo] no mock handler for ${route} — the page will show an error or an empty state.`);
}

/**
 * Strip the deploy base path (`/Customizable-DCA-OpenHands/`) and the
 * `/api/openhands` prefix. Returns null when the URL is not ours.
 *
 * The client's fetch calls are ROOT-absolute (`fetch("/api/openhands/status")`),
 * so under a subpath deploy the base is not actually in front of them — but
 * the live-preview proxy serves this very app from
 * `/api/openhands/conversations/<id>/preview/<port>/`, where it would be.
 * Handling both keeps demo mode honest in either.
 */
export function apiPath(rawUrl: string, origin: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  let path = url.pathname;
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (trimmedBase && path.startsWith(`${trimmedBase}/`)) path = path.slice(trimmedBase.length);
  if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return null;
  const stripped = path.slice(API_PREFIX.length) || "/";
  // Normalize a trailing slash so "GET /conversations/" hits "GET /conversations".
  return stripped.length > 1 && stripped.endsWith("/") ? stripped.slice(0, -1) : stripped;
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") return undefined; // FormData/Blob: no demo route needs one
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFetch(base: string): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = requestUrl(input);
    const path = apiPath(raw, window.location.origin, base);
    if (path === null) return realFetch(input as RequestInfo, init);

    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = init?.headers
      ? new Headers(init.headers)
      : new Headers(input instanceof Request ? input.headers : undefined);
    const request: MockRequest = {
      method,
      path,
      params: {},
      query: url.searchParams,
      body: await readBody(input, init),
      headers,
      url,
    };

    await sleep(latency());
    const result = await dispatch(request);
    if (result.unhandled) warnOnce(`${method} ${path}`);
    return new Response(result.text, { status: result.status, headers: result.headers });
  };
}

// ---------------------------------------------------------------------------
// EventSource
//
// Conversation.tsx opens `GET /conversations/:id/stream` while a run is
// active. The real stream only paints an in-flight draft — the transcript is
// polled every 3s regardless — so a mock stream that opens and stays silent is
// already correct behaviour. A group that wants a typing effect declares the
// route in its `streams` map and emits `delta` frames.

function installEventSource(base: string): void {
  const RealEventSource = window.EventSource;

  // Declared inside the installer, not at module scope: `extends EventTarget`
  // is an impure global read that would otherwise keep this file alive in the
  // production bundle (see the header comment).
  class MockEventSource extends EventTarget {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;

    onopen: ((ev: Event) => unknown) | null = null;
    onmessage: ((ev: MessageEvent) => unknown) | null = null;
    onerror: ((ev: Event) => unknown) | null = null;

    #cleanup: (() => void) | null = null;

    constructor(url: string, request: MockRequest) {
      super();
      this.url = url;
      // Deferred so the caller can attach listeners first — a real EventSource
      // never resolves synchronously either.
      setTimeout(() => void this.#start(request), latency());
    }

    async #start(request: MockRequest): Promise<void> {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.OPEN;
      this.#fire(new Event("open"), this.onopen);

      const found = matchStream(request.method, request.path);
      if (!found) {
        // Silence, not an error: the page falls back to polling, which is the
        // path the real app takes whenever streaming is switched off.
        warnOnce(`SSE ${request.method} ${request.path}`);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the controller closes over the connection
      const connection = this;
      const controller: MockStreamController = {
        get closed() {
          return connection.readyState === connection.CLOSED;
        },
        emit(frame: MockStreamEvent) {
          if (connection.readyState === connection.CLOSED) return;
          const name = frame.event ?? "message";
          const event = new MessageEvent(name, {
            data: frame.data ?? "",
            lastEventId: frame.id ?? "",
            origin: window.location.origin,
          });
          connection.dispatchEvent(event);
          if (name === "message") connection.onmessage?.(event);
        },
        close() {
          connection.close();
          connection.#fire(new Event("error"), connection.onerror);
        },
      };

      try {
        const cleanup = await found.handler({ ...request, params: found.params }, controller);
        if (typeof cleanup !== "function") return;
        if (this.readyState === this.CLOSED) cleanup();
        else this.#cleanup = cleanup;
      } catch (err) {
        console.error(`[demo] stream handler ${found.key} threw:`, err);
        this.#fire(new Event("error"), this.onerror);
      }
    }

    #fire(event: Event, handler: ((ev: Event) => unknown) | null): void {
      this.dispatchEvent(event);
      handler?.call(this, event);
    }

    close(): void {
      this.readyState = this.CLOSED;
      this.#cleanup?.();
      this.#cleanup = null;
    }
  }

  const Patched = function (url: string | URL, init?: EventSourceInit) {
    const raw = typeof url === "string" ? url : url.toString();
    const path = apiPath(raw, window.location.origin, base);
    if (path === null) return new RealEventSource(url, init);
    const parsed = new URL(raw, window.location.origin);
    return new MockEventSource(raw, {
      method: "GET",
      path,
      params: {},
      query: parsed.searchParams,
      body: undefined,
      headers: new Headers(),
      url: parsed,
    });
  } as unknown as typeof EventSource;
  // The interface constants callers may read off the constructor itself.
  Object.defineProperties(Patched, {
    CONNECTING: { value: 0 },
    OPEN: { value: 1 },
    CLOSED: { value: 2 },
  });
  window.EventSource = Patched;
}

// ---------------------------------------------------------------------------

/**
 * A public demo must never beg for OS notification access, and the desktop
 * toggle on the Notifications page calls `Notification.requestPermission()`
 * directly. Swapping the constructor for an inert shim reports a settled
 * "denied" — so that page renders its honest "not allowed for this site"
 * state — without the browser ever showing a prompt, and without demo
 * concerns leaking into client/lib/notify.ts, which other work is editing.
 */
function suppressNotificationPrompt(): void {
  if (typeof window.Notification === "undefined") return;
  class InertNotification extends EventTarget {
    static readonly permission: NotificationPermission = "denied";
    static readonly maxActions = 0;
    static requestPermission(): Promise<NotificationPermission> {
      return Promise.resolve("denied");
    }
    close(): void {
      /* nothing was ever shown */
    }
  }
  try {
    window.Notification = InertNotification as unknown as typeof Notification;
  } catch {
    /* locked-down environment — nothing to suppress, then */
  }
}

export interface InstallOptions {
  /** Deploy base path; defaults to Vite's `import.meta.env.BASE_URL`. */
  base?: string;
  /** Set false to leave the Notification API alone (tests). */
  suppressNotifications?: boolean;
}

/**
 * Install the demo backend. Idempotent — a second call is a no-op, so HMR and
 * React StrictMode cannot stack two layers of patched `fetch`.
 */
export function installMockBackend(options: InstallOptions = {}): void {
  const scope = window as unknown as Record<string, unknown>;
  if (scope[INSTALLED_FLAG]) return;
  scope[INSTALLED_FLAG] = true;

  registerGroup(conversations);
  registerGroup(manager);
  registerGroup(workspace);
  registerGroup(settings);

  const base = options.base ?? import.meta.env.BASE_URL ?? "/";
  installFetch(base);
  installEventSource(base);
  if (options.suppressNotifications !== false) suppressNotificationPrompt();

  console.info(
    "%c[demo]%c simulated backend active — every /api/openhands call is answered from client/mock/. No agent is running.",
    "font-weight:bold",
    "font-weight:normal",
  );
}
