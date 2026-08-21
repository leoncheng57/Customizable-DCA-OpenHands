import { describe, expect, it } from "vitest";

import { isKeyboardOpen, KEYBOARD_RATIO } from "../client/lib/viewport.js";

// The software keyboard has no web API — the conversation layout infers it
// from the visual viewport shrinking relative to the layout viewport, and
// uses that to drop passive chrome so Send stays reachable (issue #28).
describe("isKeyboardOpen", () => {
  it("is false when the viewports agree", () => {
    expect(isKeyboardOpen(664, 664)).toBe(false);
  });

  it("ignores the collapsing mobile URL bar", () => {
    // Safari/Chrome reclaim ~60px of a ~750px screen when the bar hides —
    // roughly 8%, well inside the threshold.
    expect(isKeyboardOpen(690, 750)).toBe(false);
  });

  it("detects a real keyboard", () => {
    // iPhone 13 portrait: 664 layout, ~336 of keyboard.
    expect(isKeyboardOpen(328, 664)).toBe(true);
    // A short landscape keyboard still clears the bar.
    expect(isKeyboardOpen(200, 375)).toBe(true);
  });

  it("switches exactly at the ratio", () => {
    const layout = 1000;
    expect(isKeyboardOpen(layout * KEYBOARD_RATIO, layout)).toBe(false);
    expect(isKeyboardOpen(layout * KEYBOARD_RATIO - 1, layout)).toBe(true);
  });

  it("treats missing or nonsensical measurements as no keyboard", () => {
    // Desktop SSR / a browser without visualViewport must never hide chrome.
    expect(isKeyboardOpen(0, 664)).toBe(false);
    expect(isKeyboardOpen(664, 0)).toBe(false);
    expect(isKeyboardOpen(Number.NaN, 664)).toBe(false);
  });
});
