// client/lib/viewport.ts
//
// Viewport primitives for the responsive conversation layout (issue #28,
// mobile pass): media-query state as a React hook plus a visual-viewport
// height CSS variable so the layout can react to the mobile software
// keyboard, which shrinks the *visual* viewport but not `100dvh`.
//
// Breakpoints mirror Tailwind v4's defaults (sm = 40rem, lg = 64rem) so a
// JS-conditional render and a `sm:`/`lg:` utility on the same element can
// never disagree about which side of the breakpoint they are on.
import { useEffect, useState } from "react";

import { isCoarsePointer } from "./touch.js";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** ≥ sm (40rem / 640px) — full conversation header with inline actions. */
export function useIsSmUp(): boolean {
  return useMediaQuery("(min-width: 40rem)");
}

/** ≥ lg (64rem / 1024px) — in-flow sidebar columns instead of sheets. */
export function useIsLgUp(): boolean {
  return useMediaQuery("(min-width: 64rem)");
}

/**
 * Publishes the visual viewport height as `--app-vvh` on <html> so the shell
 * column (main.tsx) can track the software keyboard.
 *
 * `100dvh` follows the collapsing URL bar but NOT the keyboard: on iOS the
 * layout viewport keeps its size, so a bottom-anchored composer ends up
 * behind the keys. The visual viewport is the only thing that reports the
 * shrink.
 *
 * Coarse-pointer devices only: on desktop the visual viewport also shrinks on
 * pinch-zoom, where resizing the layout would be wrong.
 */
export function useVisualViewportVar(): void {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || !isCoarsePointer()) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--app-vvh", `${Math.round(vv.height)}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      root.style.removeProperty("--app-vvh");
    };
  }, []);
}

/** Visual viewport must drop below this fraction of the layout viewport to
 *  count as "keyboard". Above the collapsing URL bar (~10% of a phone
 *  screen), below every real software keyboard (≥25%). */
export const KEYBOARD_RATIO = 0.8;

/**
 * Is the software keyboard covering part of the viewport?
 *
 * There is no keyboard API on the web, so this infers it the standard way: a
 * visual viewport substantially shorter than the layout viewport. Pure so the
 * threshold is unit-testable without a DOM (`tests/viewport.test.ts`).
 */
export function isKeyboardOpen(visualHeight: number, layoutHeight: number): boolean {
  if (!(visualHeight > 0) || !(layoutHeight > 0)) return false;
  return visualHeight < layoutHeight * KEYBOARD_RATIO;
}

/**
 * React binding for {@link isKeyboardOpen}.
 *
 * Used to drop passive chrome (panel dock, status bar) while composing — on a
 * 390×664 phone the keyboard leaves the column ~250px, and without this the
 * transcript is squeezed to zero and Send falls behind the keys.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || !isCoarsePointer()) return;
    const apply = () => setOpen(isKeyboardOpen(vv.height, window.innerHeight));
    apply();
    vv.addEventListener("resize", apply);
    return () => vv.removeEventListener("resize", apply);
  }, []);
  return open;
}
