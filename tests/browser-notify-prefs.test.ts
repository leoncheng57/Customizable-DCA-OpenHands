import { describe, expect, it } from "vitest";
import {
  conversationLabel,
  DEFAULT_PREFS,
  NOTIFY_EVENTS,
  normalizePrefs,
  notificationCopy,
} from "../client/lib/notify.js";

describe("normalizePrefs", () => {
  it("returns defaults for missing/garbage input", () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs("nonsense")).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(42)).toEqual(DEFAULT_PREFS);
  });

  it("migrates the legacy sound flag when no prefs blob exists", () => {
    expect(normalizePrefs(null, "1").sound).toBe(true);
    expect(normalizePrefs(null, "0").sound).toBe(false);
    expect(normalizePrefs(null, null).sound).toBe(false);
  });

  it("keeps valid fields and drops invalid ones", () => {
    const prefs = normalizePrefs({
      sound: true,
      desktop: true,
      volume: 0.25,
      events: { finished: false, idle: false, bogus: true },
    });
    expect(prefs).toEqual({
      sound: true,
      desktop: true,
      volume: 0.25,
      events: { finished: false, error: true, stuck: true, idle: false },
    });

    const mangled = normalizePrefs({ sound: "yes", volume: "loud", events: "all" });
    expect(mangled).toEqual(DEFAULT_PREFS);
  });

  it("clamps volume into 0..1 and rejects non-finite values", () => {
    expect(normalizePrefs({ volume: 5 }).volume).toBe(1);
    expect(normalizePrefs({ volume: -1 }).volume).toBe(0);
    expect(normalizePrefs({ volume: NaN }).volume).toBe(DEFAULT_PREFS.volume);
    expect(normalizePrefs({ volume: Infinity }).volume).toBe(DEFAULT_PREFS.volume);
  });

  it("does not mutate the exported defaults", () => {
    const prefs = normalizePrefs({ events: { finished: false } });
    prefs.events.error = false;
    prefs.volume = 0;
    expect(DEFAULT_PREFS.events).toEqual({ finished: true, error: true, stuck: true, idle: true });
    expect(DEFAULT_PREFS.volume).toBe(0.6);
  });
});

describe("conversationLabel", () => {
  it("uses a trimmed title when present", () => {
    expect(conversationLabel("  Fix the flaky test  ")).toBe("Fix the flaky test");
  });

  it("falls back to a short id label when the title is blank", () => {
    expect(conversationLabel("", "abcdef123456")).toBe("Conversation abcdef12");
    expect(conversationLabel(null, "abcdef123456")).toBe("Conversation abcdef12");
    expect(conversationLabel(undefined, "abcdef123456")).toBe("Conversation abcdef12");
  });

  it("falls back to a generic phrase with no title and no id", () => {
    expect(conversationLabel(null)).toBe("your conversation");
  });
});

describe("notificationCopy", () => {
  it("brands every event title with OpenHands and names the conversation", () => {
    for (const event of NOTIFY_EVENTS) {
      const copy = notificationCopy(event, "Refactor billing");
      expect(copy.title.startsWith("OpenHands")).toBe(true);
      expect(copy.body).toContain("Refactor billing");
      expect(copy.body).toContain("Click");
    }
  });

  it("uses distinct wording per event so the banner is self-explanatory", () => {
    const titles = NOTIFY_EVENTS.map((e) => notificationCopy(e, "x").title);
    expect(new Set(titles).size).toBe(NOTIFY_EVENTS.length);
  });

  it("substitutes the id fallback when a conversation has no title", () => {
    const copy = notificationCopy("finished", "", "abcdef123456");
    expect(copy.body).toContain("Conversation abcdef12");
  });
});
