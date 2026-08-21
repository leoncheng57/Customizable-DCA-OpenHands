// client/lib/time.ts
//
// Timestamp parsing/formatting for the transcript.
//
// The agent-server emits *naive* ISO timestamps with no UTC offset and no
// "Z" (e.g. "2026-08-12T23:46:18.531414") — they are always UTC, but nothing
// in the string says so. Handing one straight to `new Date(...)` is wrong:
// per the ECMAScript date-time string spec, a date-time string with no
// offset is parsed as *local* time, which silently shifts a naive-UTC value
// by the viewer's UTC offset. Every parse in this module goes through
// `parseEventTimestamp`, which normalizes the string to UTC before parsing.

/** True when the timestamp already carries an explicit UTC offset or "Z". */
function hasOffset(timestamp: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp);
}

/** Parse an agent-server timestamp as UTC. Returns null for empty/invalid input. */
export function parseEventTimestamp(timestamp: string): Date | null {
  if (!timestamp) return null;
  const d = new Date(hasOffset(timestamp) ? timestamp : `${timestamp}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Built per call rather than cached at module scope: an `Intl.DateTimeFormat`
// resolves (and freezes) the viewer's timezone at construction time, so a
// module-level singleton would keep using whichever zone was active on first
// import instead of tracking the environment's current zone.
function clockFormat(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fullLocalFormat(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Short local clock time for inline display, e.g. "14:23:05". */
export function formatClockTime(timestamp: string): string {
  const d = parseEventTimestamp(timestamp);
  return d ? clockFormat().format(d) : "";
}

/**
 * Tooltip text pairing the full local date/time (with the viewer's zone
 * spelled out, since it's otherwise not discoverable) and the raw UTC value.
 */
export function formatTimestampTooltip(timestamp: string): string {
  const d = parseEventTimestamp(timestamp);
  if (!d) return "";
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utc = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `${fullLocalFormat().format(d)} (${zone}) · ${utc}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "2m ago"-style label for events from the last day; empty once an event is
 * old enough that a relative label stops being useful (callers should fall
 * back to `formatClockTime` in that case).
 */
export function formatRelativeTime(timestamp: string, now: number = Date.now()): string {
  const d = parseEventTimestamp(timestamp);
  if (!d) return "";
  const diff = now - d.getTime();
  if (diff < 0 || diff >= DAY_MS) return "";
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  return `${Math.floor(diff / HOUR_MS)}h ago`;
}

/**
 * Whole-second live elapsed label ("47s", "2m 13s", "1h 04m") for the running
 * indicator's 1s ticker. Empty when the timestamp is missing/unparseable.
 */
export function formatElapsedSince(timestamp: string | null | undefined, now: number = Date.now()): string {
  if (!timestamp) return "";
  const d = parseEventTimestamp(timestamp);
  if (!d) return "";
  const s = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "3.2s" / "1m 05s" duration between a tool call and its paired output. */
export function formatDuration(startTimestamp: string, endTimestamp?: string | null): string {
  if (!endTimestamp) return "";
  const start = parseEventTimestamp(startTimestamp);
  const end = parseEventTimestamp(endTimestamp);
  if (!start || !end) return "";
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(remSeconds).padStart(2, "0")}s`;
}
