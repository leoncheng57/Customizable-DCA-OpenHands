// Contract tests for the demo backend's settings group (client/mock/settings.ts).
//
// Three things are worth pinning here, and they are the three that would
// otherwise fail silently in a browser-only build:
//
//  1. COVERAGE. The group owns a fixed list of endpoints. A missing handler
//     does not throw — the registry answers 404 and the page shows an error
//     someone has to click to find. Asserting against the registry turns that
//     into a build failure.
//  2. ROUND-TRIPS. Every page on this surface replaces its form state with the
//     PATCH response and re-reads on the next mount. A write that is echoed
//     but not stored looks correct until you navigate away and back.
//  3. EFFECTIVE SKILL STATE. The Tools page does not render `entry.enabled`;
//     it re-derives the checkbox with `skillEffectiveEnabled`. So the fixtures
//     are fed through that REAL classifier here — if the seeded rows do not
//     classify the way this file claims, the page renders checkboxes that
//     disagree with their own labels.
import { beforeEach, describe, expect, it } from "vitest";

import { handlers as settings } from "../client/mock/settings.js";
import { matchRoute, registerGroup, resetRegistry } from "../client/mock/registry.js";
import { demoState } from "../client/mock/state.js";
import { MockHttpError, type MockRequest } from "../client/mock/types.js";
import { skillEffectiveEnabled } from "../client/lib/skills.js";
import {
  buildSkillsPayload,
  initialSkillsState,
} from "../client/mock/fixtures/settings-skills.js";
import type {
  AgentSettings,
  MrComment,
  MrInfo,
  MrPipelineProgress,
  NotificationSettings,
  RepoOption,
  SkillsSettings,
  SuggestedIssuesResponse,
  ToolsHealth,
} from "../client/lib/api.js";

/** Every route this group is the declared owner of. */
const OWNED_ROUTES = [
  "GET /repos",
  "GET /local-folders",
  "GET /suggested-issues",
  "GET /tools",
  "GET /skills",
  "PATCH /skills",
  "GET /notifications",
  "PATCH /notifications",
  "POST /notifications/test",
  "GET /agent-settings",
  "PATCH /agent-settings",
  "GET /mr",
  "GET /mr/comments",
  "GET /mr/pipeline",
  "POST /mr/merge",
] as const;

function request(method: string, path: string, init: { query?: string; body?: unknown } = {}): MockRequest {
  const url = new URL(`http://demo.test/api/openhands${path}${init.query ? `?${init.query}` : ""}`);
  return {
    method,
    path,
    params: {},
    query: url.searchParams,
    body: init.body,
    headers: new Headers(),
    url,
  };
}

/** Invoke a route through the registry, exactly as the fetch patch does. */
async function call<T>(method: string, path: string, init: { query?: string; body?: unknown } = {}): Promise<T> {
  const found = matchRoute(method, path);
  if (!found) throw new Error(`no handler for ${method} ${path}`);
  const req = request(method, path, init);
  return (await found.handler({ ...req, params: found.params })) as T;
}

/** Capture the MockHttpError a route throws, or fail if it resolves. */
async function expectError(method: string, path: string, init: { query?: string; body?: unknown } = {}): Promise<MockHttpError> {
  try {
    await call(method, path, init);
  } catch (err) {
    expect(err, `${method} ${path} should throw a MockHttpError`).toBeInstanceOf(MockHttpError);
    return err as MockHttpError;
  }
  throw new Error(`${method} ${path} resolved but should have thrown`);
}

beforeEach(() => {
  resetRegistry();
  registerGroup(settings);
  demoState.clear();
});

describe("route coverage", () => {
  it("declares a handler for every endpoint the group owns", () => {
    // Asserted against the registry rather than Object.keys(handlers.routes)
    // so a typo'd key ("GET /skill") fails here instead of at runtime.
    for (const key of OWNED_ROUTES) {
      const [method, path] = key.split(" ") as [string, string];
      const found = matchRoute(method, path);
      expect(found, `missing demo handler for ${key}`).not.toBeNull();
      expect(found?.group).toBe("settings");
    }
  });

  it("claims nothing outside its list", () => {
    expect(Object.keys(settings.routes).sort()).toEqual([...OWNED_ROUTES].sort());
    expect(settings.streams ?? {}).toEqual({});
  });
});

describe("project sources", () => {
  it("serves a repo list the namespace picker can actually drill", async () => {
    const { items } = await call<{ items: RepoOption[] }>("GET", "/repos");
    expect(items.length).toBeGreaterThan(8);
    // RepoSelect walks one segment at a time, so a flat list of single-segment
    // paths would render one dropdown and hide the whole feature.
    const topLevel = new Set(items.map((r) => r.path.split("/")[0]));
    expect(topLevel.size).toBeGreaterThan(1);
    expect(items.some((r) => r.path.split("/").length >= 3)).toBe(true);
    for (const repo of items) {
      expect(repo.name).toBe(repo.path.split("/").pop());
      expect(repo.url.endsWith(repo.path)).toBe(true);
      expect(repo.url.endsWith(".git")).toBe(false);
    }
  });

  it("resolves both pinned quick picks", async () => {
    // PINNED_REPO_HINTS matches by exact path or "/"-suffix; an unresolvable
    // hint silently drops the pin row, which is easy to not notice.
    const { items } = await call<{ items: RepoOption[] }>("GET", "/repos");
    const { PINNED_REPO_HINTS, resolvePin } = await import("../client/components/RepoSelect.js");
    for (const hint of PINNED_REPO_HINTS) {
      expect(resolvePin(items, hint), `pin "${hint}" does not resolve`).not.toBeNull();
    }
  });

  it("is stable across calls, because the client caches it in localStorage", async () => {
    const first = await call<{ items: RepoOption[] }>("GET", "/repos");
    const second = await call<{ items: RepoOption[] }>("GET", "/repos");
    expect(second).toEqual(first);
  });

  it("lists enough project folders to exercise the Hub's filter box", async () => {
    const { items } = await call<{ items: Array<{ name: string; path: string }> }>("GET", "/local-folders");
    // The filter input only renders above 12 entries.
    expect(items.length).toBeGreaterThan(12);
    for (const folder of items) {
      expect(folder.path).toBe(folder.name);
      expect(folder.path.startsWith("/")).toBe(false);
    }
  });

  it("answers suggested issues for any repo the picker can produce", async () => {
    const res = await call<SuggestedIssuesResponse>("GET", "/suggested-issues", {
      query: "repo=meridian/platform/checkout-service",
    });
    expect(res.repo).toBe("meridian/platform/checkout-service");
    expect(res.items.length).toBeGreaterThan(0);
    for (const issue of res.items) {
      expect(issue.webUrl).toContain(`/${res.repo}/-/issues/${issue.iid}`);
      expect(issue.reason.startsWith("Open and unassigned")).toBe(true);
      expect(Number.isNaN(Date.parse(issue.updatedAt))).toBe(false);
    }

    // A repo with no bespoke list still gets something rather than dead-ending.
    const fallback = await call<SuggestedIssuesResponse>("GET", "/suggested-issues", {
      query: "repo=meridian/infra/terraform-modules",
    });
    expect(fallback.items.length).toBeGreaterThan(0);
  });

  it("rejects a missing or traversing repo param", async () => {
    expect((await expectError("GET", "/suggested-issues")).status).toBe(400);
    expect((await expectError("GET", "/suggested-issues", { query: "repo=../etc" })).status).toBe(400);
  });
});

describe("tools health", () => {
  it("reports a mixed board so the page's problem states are reachable", async () => {
    const health = await call<ToolsHealth>("GET", "/tools");
    expect(health.server.health).toBe("ok");
    expect(health.tools.length).toBeGreaterThan(0);

    // At least one healthy and one broken MCP server: the healthy row proves
    // the happy path renders, the broken one is what mcpStall.ts reads.
    expect(health.mcp.some((m) => m.health === "ok")).toBe(true);
    expect(health.mcp.some((m) => m.health === "error")).toBe(true);
    expect(health.integrations.some((i) => i.health === "error")).toBe(true);
    expect(health.integrations.some((i) => i.health === "ok")).toBe(true);
  });

  it("feeds the MCP stall hint a real culprit", async () => {
    const health = await call<ToolsHealth>("GET", "/tools");
    const { mcpStallHint, unhealthyMcpNames } = await import("../client/lib/mcpStall.js");
    const names = unhealthyMcpNames(health);
    expect(names.length).toBeGreaterThan(0);
    expect(mcpStallHint(names)).toContain(names[0]);
  });

  it("caches like the real probe, and ?refresh=1 re-stamps probedAt", async () => {
    const first = await call<ToolsHealth>("GET", "/tools");
    const cached = await call<ToolsHealth>("GET", "/tools");
    expect(cached.probedAt).toBe(first.probedAt);

    const refreshed = await call<ToolsHealth>("GET", "/tools", { query: "refresh=1" });
    expect(Date.parse(refreshed.probedAt)).toBeGreaterThanOrEqual(Date.parse(first.probedAt));
  }, 10_000);

  it("takes visibly longer on a forced re-probe, so the button feels real", async () => {
    const started = Date.now();
    await call<ToolsHealth>("GET", "/tools", { query: "refresh=1" });
    expect(Date.now() - started).toBeGreaterThan(500);
  }, 10_000);

  it("mirrors a skill switched off on the same page", async () => {
    const before = await call<ToolsHealth>("GET", "/tools");
    expect(before.skills.find((s) => s.name === "changelog-writer")?.detail).toBe("installed");

    await call<SkillsSettings>("PATCH", "/skills", { body: { skills: { "changelog-writer": false } } });

    const after = await call<ToolsHealth>("GET", "/tools");
    // The install-level flag is mirrored, so the roll-up follows the toggle
    // instead of serving a cached board that contradicts it.
    expect(after.skills.find((s) => s.name === "changelog-writer")?.detail).toBe("installed, disabled");
  });

  it("reflects the configured ntfy target in the integrations row", async () => {
    const enabled = await call<ToolsHealth>("GET", "/tools");
    expect(enabled.integrations.find((i) => i.id === "ntfy")?.health).toBe("ok");

    await call<NotificationSettings>("PATCH", "/notifications", {
      body: { enabled: false, notifyIdle: true, mentionMe: true },
    });
    const off = await call<ToolsHealth>("GET", "/tools");
    expect(off.integrations.find((i) => i.id === "ntfy")).toMatchObject({
      health: "unknown",
      detail: "no topic configured — see the Notifications page",
    });
  });
});

describe("skills — effective state through the real classifier", () => {
  /**
   * The seeded rows, and what each one is there to prove. `skillEffectiveEnabled`
   * is the function the Tools page calls for the checkbox, so running the
   * fixtures through it is the closest a node test gets to rendering the card.
   */
  const EXPECTED: Array<[name: string, enabled: boolean, why: string]> = [
    ["changelog-writer", true, "installed, install-flag on, not denied"],
    ["api-contract-check", false, "installed and install-flag on, but deny-listed — the deny-list is the authority"],
    ["slide-deck", false, "installed with the install-level flag off, no deny-list entry needed"],
    ["dependency-audit", true, "auto-loaded only, nothing denies it"],
    ["web-scraper", false, "auto-loaded only and denied — the deny-list is its only lever"],
    ["legacy-migrator", false, "deny-list only: no install row at all, kept so it can be re-enabled"],
  ];

  it("classifies every seeded row the way the fixture intends", async () => {
    const payload = await call<SkillsSettings>("GET", "/skills");
    const byName = new Map(payload.skills.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(EXPECTED.map(([n]) => n).sort());

    for (const [name, expected, why] of EXPECTED) {
      const entry = byName.get(name);
      expect(entry, `${name} is missing from the demo skill list`).toBeDefined();
      if (!entry) continue;
      // Exactly what Tools.tsx computes for the checkbox.
      const derived = skillEffectiveEnabled({ name: entry.name, enabled: entry.installEnabled }, payload.disabledSkills);
      expect(derived, `${name}: ${why}`).toBe(expected);
      // …and the server-shaped `enabled` field must agree, or the row's label
      // and its checkbox tell different stories.
      expect(entry.enabled, `${name}: payload.enabled disagrees with the classifier`).toBe(expected);
    }
  });

  it("covers each origin the page has a distinct label for", async () => {
    const { skills } = await call<SkillsSettings>("GET", "/skills");
    expect(skills.some((s) => s.installed)).toBe(true);
    expect(skills.some((s) => !s.installed && s.autoLoaded)).toBe(true);
    expect(skills.some((s) => !s.installed && !s.autoLoaded && s.denied)).toBe(true);
  });

  it("is not in the loading-off state on first load", async () => {
    const payload = await call<SkillsSettings>("GET", "/skills");
    expect(payload.loadingDisabled).toBe(false);
    expect(payload.sources.user || payload.sources.public).toBe(true);
    expect(payload.loadedUnavailable).toBe(false);
  });
});

describe("skills — PATCH round-trips", () => {
  it("enabling a denied skill lifts the deny-list entry and sticks", async () => {
    const patched = await call<SkillsSettings>("PATCH", "/skills", {
      body: { skills: { "api-contract-check": true } },
    });
    expect(patched.disabledSkills).not.toContain("api-contract-check");
    expect(patched.skills.find((s) => s.name === "api-contract-check")?.enabled).toBe(true);

    const reread = await call<SkillsSettings>("GET", "/skills");
    expect(reread.skills.find((s) => s.name === "api-contract-check")?.enabled).toBe(true);
    expect(reread.disabledSkills).toEqual(patched.disabledSkills);
  });

  it("disabling appends to the deny-list without disturbing the existing order", async () => {
    const before = await call<SkillsSettings>("GET", "/skills");
    const after = await call<SkillsSettings>("PATCH", "/skills", {
      body: { skills: { "changelog-writer": false } },
    });
    // Read-modify-write: survivors keep their position, new denials append.
    expect(after.disabledSkills).toEqual([...before.disabledSkills, "changelog-writer"]);
    expect(after.skills.find((s) => s.name === "changelog-writer")?.enabled).toBe(false);
  });

  it("switching every source off reports loading-off rather than an empty install", async () => {
    const off = await call<SkillsSettings>("PATCH", "/skills", {
      body: { sources: { user: false, public: false, project: false } },
    });
    expect(off.sources).toEqual({ user: false, public: false, project: false });
    expect(off.loadingDisabled).toBe(true);
    // Auto-loaded rows come from actually loading them, so they disappear —
    // but installed rows and the deny-list survive, and the toggles persist.
    expect(off.skills.some((s) => s.name === "dependency-audit")).toBe(false);
    expect(off.skills.some((s) => s.name === "changelog-writer")).toBe(true);
    expect((await call<SkillsSettings>("GET", "/skills")).loadingDisabled).toBe(true);

    const back = await call<SkillsSettings>("PATCH", "/skills", { body: { sources: { public: true } } });
    expect(back.loadingDisabled).toBe(false);
    expect(back.skills.some((s) => s.name === "dependency-audit")).toBe(true);
  });

  it("rejects the bodies the real BFF rejects", async () => {
    expect((await expectError("PATCH", "/skills", { body: {} })).status).toBe(400);
    expect((await expectError("PATCH", "/skills", { body: { skills: [] } })).status).toBe(400);
    expect((await expectError("PATCH", "/skills", { body: { skills: { pdf: "yes" } } })).status).toBe(400);
    // A name that could escape into the upstream skills URL.
    expect((await expectError("PATCH", "/skills", { body: { skills: { "../../settings": false } } })).status).toBe(400);
    expect((await expectError("PATCH", "/skills", { body: { sources: { user: 1 } } })).status).toBe(400);
    // A rejected patch must not have half-applied.
    expect(await call<SkillsSettings>("GET", "/skills")).toEqual(buildSkillsPayload(initialSkillsState()));
  });
});

describe("agent settings — PATCH round-trip", () => {
  it("opens on the recommended condenser configuration", async () => {
    const settingsBody = await call<AgentSettings>("GET", "/agent-settings");
    expect(settingsBody.condenser.enabled).toBe(true);
    expect(settingsBody.condenser.maxTokens).toBe(80_000);
  });

  it("echoes the full object and the next GET agrees", async () => {
    const next = await call<AgentSettings>("PATCH", "/agent-settings", {
      body: { condenser: { enabled: true, maxTokens: 120_000, maxSize: 300, keepFirst: 4 } },
    });
    // The page replaces its whole form state with this, so a partial echo
    // would blank the inputs.
    expect(next.condenser).toEqual({ enabled: true, maxTokens: 120_000, maxSize: 300, keepFirst: 4 });
    expect(await call<AgentSettings>("GET", "/agent-settings")).toEqual(next);
  });

  it("accepts an empty token threshold as 'no token trigger'", async () => {
    const next = await call<AgentSettings>("PATCH", "/agent-settings", {
      body: { condenser: { enabled: true, maxTokens: null, maxSize: 240, keepFirst: 2 } },
    });
    expect(next.condenser.maxTokens).toBeNull();
  });

  it("enforces the same bounds a real save would hit", async () => {
    expect((await expectError("PATCH", "/agent-settings", { body: { condenser: { maxTokens: 5 } } })).status).toBe(400);
    expect((await expectError("PATCH", "/agent-settings", { body: { condenser: { maxSize: 5 } } })).status).toBe(400);
    // keepFirst must leave the condenser room to work.
    const err = await expectError("PATCH", "/agent-settings", {
      body: { condenser: { maxSize: 100, keepFirst: 60 } },
    });
    expect(err.message).toContain("keepFirst");
    expect((await call<AgentSettings>("GET", "/agent-settings")).condenser.maxSize).toBe(240);
  });
});

describe("notifications — PATCH round-trip and the test push", () => {
  it("round-trips the ntfy config", async () => {
    const next = await call<NotificationSettings>("PATCH", "/notifications", {
      body: { enabled: true, notifyIdle: false, mentionMe: false, ntfyTopic: "demo-topic-42" },
    });
    expect(next).toMatchObject({
      enabled: true,
      notifyIdle: false,
      mentionMe: false,
      mentionEmails: [],
      ntfyTopic: "demo-topic-42",
      ntfyConfigured: true,
    });
    expect(await call<NotificationSettings>("GET", "/notifications")).toEqual(next);
  });

  it("treats an empty topic as unconfigured", async () => {
    const next = await call<NotificationSettings>("PATCH", "/notifications", {
      body: { enabled: true, notifyIdle: true, mentionMe: true, ntfyTopic: "" },
    });
    expect(next.ntfyConfigured).toBe(false);
    // The page's test button is disabled without a topic; the route refuses too.
    expect((await expectError("POST", "/notifications/test")).status).toBe(400);
  });

  it("validates the fields the real route validates", async () => {
    expect((await expectError("PATCH", "/notifications", { body: { enabled: "yes" } })).status).toBe(400);
    expect(
      (await expectError("PATCH", "/notifications", {
        body: { enabled: true, notifyIdle: true, mentionMe: true, ntfyUrl: "not a url" },
      })).status,
    ).toBe(400);
    expect(
      (await expectError("PATCH", "/notifications", {
        body: { enabled: true, notifyIdle: true, mentionMe: true, ntfyTopic: "no spaces allowed" },
      })).status,
    ).toBe(400);
  });

  it("does not claim a push reached anyone", async () => {
    const res = await call<{ ok: boolean; url: string; topic: string }>("POST", "/notifications/test");
    expect(res.ok).toBe(true);
    // The page prints "Sent to {url}/{topic} — check your subscribed device."
    // Both halves have to make the absence of a device obvious: the host is
    // reserved-unresolvable and the topic says so in words.
    expect(res.url).toMatch(/\.invalid$/);
    expect(res.topic).toContain("nothing-was-actually-sent");
  });
});

describe("merge request panel", () => {
  const URL_UNDER_TEST = "https://gitlab.example.test/meridian/platform/checkout-service/-/merge_requests/128";

  it("serves a card with everything the panel draws", async () => {
    const info = await call<MrInfo>("GET", "/mr", { query: `url=${encodeURIComponent(URL_UNDER_TEST)}` });
    expect(info).toMatchObject({
      iid: 128,
      projectPath: "meridian/platform/checkout-service",
      state: "opened",
      // Not mergeable would disable the button and hide the confirm step.
      mergeStatus: "can_be_merged",
    });
    expect(info.title).not.toBe("");
    expect(info.description).not.toBe("");
    expect(info.pipeline).not.toBeNull();
  });

  it("answers for whatever URL the transcript produced, not one hardcoded string", async () => {
    // The conversations group owns the transcript, so the MR URL is not ours
    // to fix. A card stuck on "Loading…" is the failure this prevents.
    const other = "https://gitlab.example.test/northwind/data/etl-pipelines/-/merge_requests/9";
    const info = await call<MrInfo>("GET", "/mr", { query: `url=${encodeURIComponent(other)}` });
    expect(info).toMatchObject({ iid: 9, projectPath: "northwind/data/etl-pipelines" });

    const pr = "https://github.com/meridian-labs/storefront/pull/57";
    const ghInfo = await call<MrInfo>("GET", "/mr", { query: `url=${encodeURIComponent(pr)}` });
    expect(ghInfo).toMatchObject({ iid: 57, projectPath: "meridian-labs/storefront" });
  });

  it("has comments, including a resolved one", async () => {
    const { items } = await call<{ items: MrComment[] }>("GET", "/mr/comments", {
      query: `url=${encodeURIComponent(URL_UNDER_TEST)}`,
    });
    expect(items.length).toBeGreaterThan(1);
    expect(items.some((c) => c.resolved)).toBe(true);
    expect(items.some((c) => !c.resolved)).toBe(true);
    for (const comment of items) {
      expect(comment.author).not.toBe("");
      expect(Number.isNaN(Date.parse(comment.createdAt))).toBe(false);
    }
  });

  it("shows a pipeline mid-run, with a status the badge and glyphs both know", async () => {
    const progress = await call<MrPipelineProgress>("GET", "/mr/pipeline", {
      query: `url=${encodeURIComponent(URL_UNDER_TEST)}`,
    });
    // Statuses MrPanel has a glyph or tone for; anything else renders as a
    // grey circle with no explanation.
    const known = new Set(["success", "failed", "running", "pending", "created", "canceled"]);
    expect(known.has(progress.pipeline.status)).toBe(true);
    expect(progress.stages.length).toBeGreaterThan(1);
    for (const stage of progress.stages) {
      expect(known.has(stage.status), `stage ${stage.name}: ${stage.status}`).toBe(true);
      expect(stage.jobs.length).toBeGreaterThan(0);
      for (const job of stage.jobs) {
        expect(known.has(job.status), `job ${job.name}: ${job.status}`).toBe(true);
      }
    }
    // Mid-run means not everything is finished at page load.
    expect(progress.stages.some((s) => s.status !== "success")).toBe(true);
    // A job that has not run yet reports null rather than a fake duration.
    expect(progress.stages.flatMap((s) => s.jobs).some((j) => j.duration === null)).toBe(true);
  });

  it("refuses to merge, and says why", async () => {
    const err = await expectError("POST", "/mr/merge", { body: { url: URL_UNDER_TEST } });
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/simulation/i);
    expect(err.message).toMatch(/nothing was merged/i);
    // The card must stay exactly as it was — a refusal that also mutated
    // state would be the worst of both options.
    const after = await call<MrInfo>("GET", "/mr", { query: `url=${encodeURIComponent(URL_UNDER_TEST)}` });
    expect(after.state).toBe("opened");
  });

  it("rejects an MR request with no url, like the real route", async () => {
    for (const [method, path] of [
      ["GET", "/mr"],
      ["GET", "/mr/comments"],
      ["GET", "/mr/pipeline"],
      ["POST", "/mr/merge"],
    ] as const) {
      expect((await expectError(method, path)).status, `${method} ${path}`).toBe(400);
    }
  });
});
