import { describe, expect, it } from "vitest";
import { loadStreamEnabled, saveStreamEnabled, STREAM_MAX_RETRIES, streamRetryDelay } from "../client/lib/streamPrefs.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("stream kill switch", () => {
  it("defaults to enabled", () => {
    expect(loadStreamEnabled(memoryStorage())).toBe(true);
  });

  it("round-trips off and on", () => {
    const storage = memoryStorage();
    saveStreamEnabled(false, storage);
    expect(loadStreamEnabled(storage)).toBe(false);
    saveStreamEnabled(true, storage);
    expect(loadStreamEnabled(storage)).toBe(true);
  });

  it("fails open when storage throws (private mode)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadStreamEnabled(throwing)).toBe(true);
  });
});

describe("streamRetryDelay", () => {
  it("backs off 2s/4s/8s then gives up", () => {
    expect(streamRetryDelay(0)).toBe(2_000);
    expect(streamRetryDelay(1)).toBe(4_000);
    expect(streamRetryDelay(2)).toBe(8_000);
    expect(streamRetryDelay(STREAM_MAX_RETRIES)).toBeNull();
    expect(streamRetryDelay(99)).toBeNull();
  });
});
