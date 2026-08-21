import { describe, expect, it } from "vitest";
import { loadNewSessionWorktree, saveNewSessionWorktree } from "../client/lib/worktreePrefs.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("new-session worktree preference", () => {
  it("defaults to enabled", () => {
    expect(loadNewSessionWorktree(memoryStorage())).toBe(true);
  });

  it("round-trips off and on", () => {
    const storage = memoryStorage();
    saveNewSessionWorktree(false, storage);
    expect(loadNewSessionWorktree(storage)).toBe(false);
    saveNewSessionWorktree(true, storage);
    expect(loadNewSessionWorktree(storage)).toBe(true);
  });

  it("fails open when storage is unavailable", () => {
    expect(loadNewSessionWorktree({ getItem: () => { throw new Error("denied"); } })).toBe(true);
  });
});
