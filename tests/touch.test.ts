import { afterEach, describe, expect, it, vi } from "vitest";
import { isCoarsePointer } from "../client/lib/touch.js";

// Node environment — `window` doesn't exist unless we stub it.
declare global {
  // eslint-disable-next-line no-var
  var window: unknown;
}

function stubMatchMedia(impl: ((query: string) => { matches: boolean }) | undefined) {
  vi.stubGlobal("window", impl ? { matchMedia: impl } : {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isCoarsePointer", () => {
  it("is false when window is missing (SSR/tests)", () => {
    expect(isCoarsePointer()).toBe(false);
  });

  it("is false when matchMedia is unavailable", () => {
    stubMatchMedia(undefined);
    expect(isCoarsePointer()).toBe(false);
  });

  it("reflects the (pointer: coarse) media query", () => {
    const seen: string[] = [];
    stubMatchMedia((query) => {
      seen.push(query);
      return { matches: true };
    });
    expect(isCoarsePointer()).toBe(true);
    expect(seen).toEqual(["(pointer: coarse)"]);

    stubMatchMedia(() => ({ matches: false }));
    expect(isCoarsePointer()).toBe(false);
  });

  it("is false when matchMedia throws", () => {
    stubMatchMedia(() => {
      throw new Error("unsupported");
    });
    expect(isCoarsePointer()).toBe(false);
  });
});
