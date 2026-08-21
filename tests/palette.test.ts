// Command palette logic (client/lib/palette.ts). The palette's component is a
// keyboard/ARIA shell; everything that can be wrong about *which* rows show and
// *in what order* lives in these two pure functions, so this is where the
// coverage goes. vitest runs `environment: "node"` — nothing here renders.
import { describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../client/lib/api.js";
import type { DocMeta } from "../client/lib/docs.js";
import { buildCommands, conversationLabel, rankCommands, type Command } from "../client/lib/palette.js";

const NAV = [
  { to: "/openhands/native", label: "Conversations" },
  { to: "/openhands/terminal", label: "Terminal" },
  { to: "/openhands/tools", label: "Tools" },
];

const DOCS: DocMeta[] = [
  {
    slug: "testing",
    path: "docs/testing.md",
    title: "Testing",
    blurb: "Five tiers, cheapest first.",
    category: "guides",
  },
  {
    slug: "risk-map",
    path: "docs/risk-map.md",
    title: "Risk map",
    blurb: "Every area scored.",
    category: "architecture",
  },
];

const CONVERSATIONS: ConversationSummary[] = [
  { id: "abc12345-dead-beef", title: "Fix terminal flake", execution_status: "idle" },
  { id: "ffff0000-1111-2222", title: null, execution_status: "running" },
];

function fixture(overrides: Partial<Parameters<typeof buildCommands>[0]> = {}): Command[] {
  return buildCommands({
    nav: NAV,
    docs: DOCS,
    conversations: CONVERSATIONS,
    theme: "light",
    onToggleTheme: () => {},
    ...overrides,
  });
}

describe("conversationLabel", () => {
  it("falls back to a short id when the conversation has no title", () => {
    expect(conversationLabel(CONVERSATIONS[0])).toBe("Fix terminal flake");
    expect(conversationLabel(CONVERSATIONS[1])).toBe("Conversation ffff0000");
    expect(conversationLabel({ id: "0123456789", title: "   ", execution_status: "idle" })).toBe("Conversation 01234567");
  });
});

describe("buildCommands", () => {
  it("emits nav, then the theme action, then docs, then conversations", () => {
    expect(fixture().map((c) => c.kind)).toEqual([
      "nav",
      "nav",
      "nav",
      "action",
      "doc",
      "doc",
      "conversation",
      "conversation",
    ]);
  });

  it("gives every command a unique, DOM-id-safe id", () => {
    const ids = fixture().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/\s/);
  });

  it("routes nav, docs and conversations to their pages; the action runs instead", () => {
    const commands = fixture();
    const byId = (id: string) => commands.find((c) => c.id === id)!;
    expect(byId("nav:/openhands/terminal").to).toBe("/openhands/terminal");
    expect(byId("doc:risk-map").to).toBe("/openhands/contributing/risk-map");
    expect(byId("conversation:abc12345-dead-beef").to).toBe(
      "/openhands/native/conversations/abc12345-dead-beef",
    );
    expect(byId("action:toggle-theme").to).toBeUndefined();
    expect(typeof byId("action:toggle-theme").run).toBe("function");
  });

  it("words the theme command as the outcome and wires the callback", () => {
    const onToggleTheme = vi.fn();
    expect(fixture({ theme: "light" })[3].title).toBe("Switch to dark mode");
    expect(fixture({ theme: "dark" })[3].title).toBe("Switch to light mode");
    fixture({ onToggleTheme })[3].run!();
    expect(onToggleTheme).toHaveBeenCalledOnce();
  });

  it("survives an empty conversation list (fetch failed or none yet)", () => {
    const commands = fixture({ conversations: [] });
    expect(commands.some((c) => c.kind === "conversation")).toBe(false);
    expect(commands).toHaveLength(6);
  });
});

describe("rankCommands", () => {
  it("returns the natural order, uncapped by relevance, for a blank query", () => {
    const commands = fixture();
    expect(rankCommands(commands, "")).toEqual(commands);
    expect(rankCommands(commands, "   ")).toEqual(commands);
  });

  it("caps results at the limit", () => {
    const commands = fixture();
    expect(rankCommands(commands, "", 3)).toHaveLength(3);
    expect(rankCommands(commands, "e", 2)).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(rankCommands(fixture(), "zzzznope")).toEqual([]);
  });

  it("ranks title prefix above word prefix above bare substring", () => {
    const commands: Command[] = [
      { id: "c", kind: "nav", title: "Zebra term", group: "g" }, // substring only
      { id: "b", kind: "nav", title: "Agent terminal", group: "g" }, // word prefix
      { id: "a", kind: "nav", title: "Terminal", group: "g" }, // title prefix
    ];
    expect(rankCommands(commands, "term").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("treats path, dot, dash and space as word boundaries for the prefix rank", () => {
    const commands: Command[] = [
      { id: "sub", kind: "nav", title: "xxmapxx", group: "g" },
      { id: "dot", kind: "nav", title: "c.map", group: "g" },
      { id: "slash", kind: "nav", title: "b/map", group: "g" },
      { id: "dash", kind: "nav", title: "a-map", group: "g" },
    ];
    // All three boundary hits outrank the bare substring; they tie on score
    // and kind, so alphabetical title order decides between them.
    expect(rankCommands(commands, "map").map((c) => c.id)).toEqual(["dash", "slash", "dot", "sub"]);
  });

  it("matches hidden keywords (slug, id, synonyms) as well as titles", () => {
    const commands = fixture();
    expect(rankCommands(commands, "risk-map").map((c) => c.id)).toContain("doc:risk-map");
    expect(rankCommands(commands, "ffff0000").map((c) => c.id)).toEqual(["conversation:ffff0000-1111-2222"]);
    // "dark" only exists as a keyword on the theme action.
    expect(rankCommands(commands, "dark").map((c) => c.id)).toEqual(["action:toggle-theme"]);
  });

  it("does not match on the subtitle, which is display-only", () => {
    // "cheapest" appears in the Testing blurb but must not pull it in.
    expect(rankCommands(fixture(), "cheapest")).toEqual([]);
  });

  it("breaks equal scores by kind (nav, action, doc, conversation) then alphabetically", () => {
    const commands: Command[] = [
      { id: "conv", kind: "conversation", title: "Same", group: "g" },
      { id: "doc-b", kind: "doc", title: "Same b", group: "g" },
      { id: "doc-a", kind: "doc", title: "Same a", group: "g" },
      { id: "action", kind: "action", title: "Same", group: "g" },
      { id: "nav", kind: "nav", title: "Same", group: "g" },
    ];
    expect(rankCommands(commands, "same").map((c) => c.id)).toEqual([
      "nav",
      "action",
      "doc-a",
      "doc-b",
      "conv",
    ]);
  });

  it("is case-insensitive on both sides", () => {
    expect(rankCommands(fixture(), "TERMINAL").map((c) => c.id)).toContain("nav:/openhands/terminal");
  });

  it("is a total order — identical inputs rank identically", () => {
    const commands = fixture();
    expect(rankCommands(commands, "t")).toEqual(rankCommands(commands, "t"));
  });
});
