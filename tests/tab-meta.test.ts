// Pure composition logic for the browser-tab identity (title + favicon).
// The DOM appliers are trivial (document.title / <link rel="icon"> swap) and
// guarded for non-DOM environments; the composition rules live here.
import { describe, expect, it } from "vitest";
import {
  composeFaviconTone,
  composeTabTitle,
  DEFAULT_TAB_TITLE,
  faviconDataUri,
  faviconSvg,
  truncateTitle,
} from "../client/lib/tabMeta.js";

describe("truncateTitle", () => {
  it("keeps short titles and collapses whitespace", () => {
    expect(truncateTitle("  Fix   login\nflake ")).toBe("Fix login flake");
  });

  it("truncates long titles with an ellipsis within the budget", () => {
    const long = "Make the browser tab actually useful for very long session names";
    const out = truncateTitle(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("Make the browser tab")).toBe(true);
  });
});

describe("composeTabTitle", () => {
  it("prefixes the conversation title with the status glyph", () => {
    expect(composeTabTitle({ conversation: { title: "Fix login flake", tone: "busy" }, attention: 0, page: null }))
      .toBe("🏃 Fix login flake · DCA");
    expect(composeTabTitle({ conversation: { title: "Fix login flake", tone: "warn" }, attention: 0, page: null }))
      .toBe("⚠️ Fix login flake · DCA");
    expect(composeTabTitle({ conversation: { title: "Fix login flake", tone: "error" }, attention: 0, page: null }))
      .toBe("🔴 Fix login flake · DCA");
    expect(composeTabTitle({ conversation: { title: "Fix login flake", tone: "ok" }, attention: 0, page: null }))
      .toBe("✅ Fix login flake · DCA");
  });

  it("omits the glyph while the conversation is loading", () => {
    expect(composeTabTitle({ conversation: { title: "Conversation ab12cd34", tone: null }, attention: 0, page: null }))
      .toBe("Conversation ab12cd34 · DCA");
  });

  it("conversation meta wins over attention count and page label", () => {
    expect(composeTabTitle({ conversation: { title: "T", tone: "ok" }, attention: 3, page: "Files" }))
      .toBe("✅ T · DCA");
  });

  it("shows the attention count on non-conversation pages", () => {
    expect(composeTabTitle({ conversation: null, attention: 2, page: null })).toBe(`(2) ${DEFAULT_TAB_TITLE}`);
    expect(composeTabTitle({ conversation: null, attention: 0, page: null })).toBe(DEFAULT_TAB_TITLE);
    expect(composeTabTitle({ conversation: null, attention: 1, page: "Manager runs" }))
      .toBe(`(1) Manager runs · ${DEFAULT_TAB_TITLE}`);
  });
});

describe("favicon", () => {
  it("maps tones to the requested badges", () => {
    expect(faviconSvg("ok")).toContain("✅");
    expect(faviconSvg("busy")).toContain("🏃");
    expect(faviconSvg("warn")).toContain("⚠️");
    expect(faviconSvg("error")).toContain('fill="#ef4444"');
    expect(faviconSvg(null)).not.toContain("<text");
    expect(faviconSvg(null)).not.toContain("#ef4444");
  });

  it("composes tone from state: conversation wins, attention falls back to warn", () => {
    expect(composeFaviconTone({ conversation: { title: "T", tone: "error" }, attention: 0, page: null })).toBe("error");
    expect(composeFaviconTone({ conversation: { title: "T", tone: null }, attention: 5, page: null })).toBe(null);
    expect(composeFaviconTone({ conversation: null, attention: 2, page: null })).toBe("warn");
    expect(composeFaviconTone({ conversation: null, attention: 0, page: "Files" })).toBe(null);
  });

  it("produces an svg data URI", () => {
    expect(faviconDataUri("busy").startsWith("data:image/svg+xml,")).toBe(true);
  });
});
