// client/mock/clock.ts
//
// The demo's sense of time.
//
// Fixtures must not carry absolute dates: a conversation stamped "2024-03-11"
// reads as abandoned the moment anyone visits, and the relative-time labels in
// the UI ("3m ago", "2h") would render nonsense. Everything is expressed as an
// OFFSET from `DEMO_START` — the instant this browser tab loaded the app — so
// each visitor gets a demo that looks like it is happening now.
//
// Two ways to use it:
//
//   isoAt(-5 * MINUTE)   a fixed point in the demo's past ("created 5m ago")
//   elapsedMs()          how long the visitor has been here, for scripted
//                        timelines that reveal content as the page sits open
//                        (see `afterMs` / `phaseAt`)
//
// Pure functions, no side effects, safe to import from a unit test.

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Epoch (ms) of this demo session — captured once when the module first
 * loads, i.e. essentially page load. Every fixture timestamp is relative to it.
 */
export const DEMO_START: number = Date.now();

/** Milliseconds since the demo started. Never negative. */
export function elapsedMs(now: number = Date.now()): number {
  return Math.max(0, now - DEMO_START);
}

/** Seconds since the demo started, rounded down — the `ageSeconds` idiom. */
export function elapsedSeconds(now: number = Date.now()): number {
  return Math.floor(elapsedMs(now) / SECOND);
}

/**
 * ISO timestamp at `DEMO_START + offsetMs`. Pass a NEGATIVE offset for the
 * demo's backstory (`isoAt(-2 * HOUR)`), a positive one for the future.
 */
export function isoAt(offsetMs: number): string {
  return new Date(DEMO_START + offsetMs).toISOString();
}

/** ISO timestamp `ms` before *now* — for values that must keep drifting. */
export function isoAgo(ms: number, now: number = Date.now()): string {
  return new Date(now - ms).toISOString();
}

/** ISO timestamp of the current instant. */
export function isoNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** Has the demo been open for at least `offsetMs`? Gates scripted reveals. */
export function afterMs(offsetMs: number, now: number = Date.now()): boolean {
  return elapsedMs(now) >= offsetMs;
}

/**
 * Index of the current phase in a scripted timeline: given ascending offsets
 * from `DEMO_START`, returns how many have already elapsed (0 = before the
 * first). A handler can use it to serve a longer transcript the longer the
 * visitor watches.
 */
export function phaseAt(offsetsMs: readonly number[], now: number = Date.now()): number {
  const elapsed = elapsedMs(now);
  let phase = 0;
  for (const offset of offsetsMs) {
    if (elapsed < offset) break;
    phase += 1;
  }
  return phase;
}
