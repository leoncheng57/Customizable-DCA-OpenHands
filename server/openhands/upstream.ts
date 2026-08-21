// server/openhands/upstream.ts
//
// Authenticated fetch against the agent-canvas (OpenHands agent-server) API,
// shared by the BFF router and the auto-resume watcher. The agent-server key
// never leaves the server side.
import { readFileSync } from "node:fs";

const UPSTREAM_TIMEOUT_MS = 30_000;

export interface UpstreamConfig {
  /** Agent-server base URL, no trailing slash. */
  internalUrl: string;
  /** Static API key (wins over the key file when set). */
  apiKey: string;
  /**
   * Fallback key file on the shared volume: the agent-canvas container writes
   * it at first boot, which can race the hub's startup, so it is polled until
   * it appears and then cached for the client's lifetime.
   */
  apiKeyFile?: string;
}

export type UpstreamFetch = (
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<globalThis.Response>;

/**
 * Lazy agent-server API key resolver: static key wins, otherwise the key file
 * is polled until it appears and then cached. Shared by the fetch wrapper
 * below and the SSE/websocket bridge (which authenticates with a first
 * message rather than a header).
 */
export function createApiKeyResolver(cfg: Pick<UpstreamConfig, "apiKey" | "apiKeyFile">): () => string {
  let cachedApiKey = cfg.apiKey;
  return function apiKey(): string {
    if (cachedApiKey) return cachedApiKey;
    try {
      cachedApiKey = readFileSync(cfg.apiKeyFile!, "utf8").trim();
    } catch {
      /* not written yet — callers surface the failure until it exists */
    }
    return cachedApiKey;
  };
}

export function createUpstream(cfg: UpstreamConfig): UpstreamFetch {
  const apiKey = createApiKeyResolver(cfg);

  return async function upstream(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
  ): Promise<globalThis.Response> {
    const key = apiKey();
    if (!key) throw new Error(`OpenHands API key file not readable yet (${cfg.apiKeyFile})`);
    return fetch(`${cfg.internalUrl}${path}`, {
      ...init,
      headers: {
        "X-Session-API-Key": key,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
}
