import { describe, expect, it } from "vitest";
import {
  isValidSkillName,
  loadedSkillsRequest,
  skillEffectiveEnabled,
  skillsResponse,
  validateSkillsPatch,
  type SkillsPayload,
  type UpstreamAgentContext,
  type UpstreamInstalledSkills,
} from "../server/openhands/skills.js";
import { skillEffectiveEnabled as clientSkillEffectiveEnabled } from "../client/lib/skills.js";

const installed: UpstreamInstalledSkills = {
  skills: [
    { name: "code-review", version: "1.0.0", description: "Reviews diffs", enabled: true, source: "github:OpenHands/extensions" },
    { name: "pdf", version: "0.2.0", description: "Reads PDFs", enabled: false, source: "github:OpenHands/extensions" },
  ],
};

const settings = (ctx: Record<string, unknown>): UpstreamAgentContext => ({
  agent_settings: { agent_context: ctx },
});

/** Current state used by the validate* cases: pdf off at install level. */
const current: SkillsPayload = skillsResponse(
  installed,
  settings({ disabled_skills: ["legacy-skill"], load_user_skills: true, load_public_skills: false, load_project_skills: false }),
);

describe("skillsResponse", () => {
  it("merges install-level enabled with the deny-list into one effective boolean", () => {
    const payload = skillsResponse(installed, settings({ disabled_skills: ["code-review"] }));
    const byName = Object.fromEntries(payload.skills.map((s) => [s.name, s]));
    // installed+enabled but deny-listed -> off
    expect(byName["code-review"]).toMatchObject({ installed: true, installEnabled: true, denied: true, enabled: false });
    // installed but disabled at install level, not deny-listed -> off
    expect(byName.pdf).toMatchObject({ installed: true, installEnabled: false, denied: false, enabled: false });
  });

  it("keeps effective-enabled true only when both mechanisms agree", () => {
    const payload = skillsResponse({ skills: [{ name: "code-review", enabled: true }] }, settings({ disabled_skills: [] }));
    expect(payload.skills[0]).toMatchObject({ enabled: true, denied: false, installEnabled: true });
  });

  it("treats a missing install-level enabled as true (upstream default)", () => {
    const payload = skillsResponse({ skills: [{ name: "pdf" }] }, settings({}));
    expect(payload.skills[0].installEnabled).toBe(true);
    expect(payload.skills[0].enabled).toBe(true);
  });

  it("surfaces deny-listed names that are not installed so they stay re-enableable", () => {
    const payload = skillsResponse(installed, settings({ disabled_skills: ["ghost-skill"] }));
    const ghost = payload.skills.find((s) => s.name === "ghost-skill");
    expect(ghost).toMatchObject({ installed: false, denied: true, enabled: false, installEnabled: true });
    expect(payload.disabledSkills).toEqual(["ghost-skill"]);
  });

  it("sorts by name and drops nameless/duplicate rows", () => {
    const payload = skillsResponse(
      { skills: [{ name: "zeta" }, { name: "" }, { name: "alpha" }, { name: "alpha" }, {}] },
      settings({}),
    );
    expect(payload.skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("maps the three load_*_skills flags and flags the all-off case explicitly", () => {
    // The live default profile ships with every source false, which is NOT the
    // same as "no skills installed" — the UI has to be able to tell them apart.
    const off = skillsResponse({ skills: [] }, settings({ load_user_skills: false, load_public_skills: false, load_project_skills: false }));
    expect(off.sources).toEqual({ user: false, public: false, project: false });
    expect(off.loadingDisabled).toBe(true);

    const on = skillsResponse({ skills: [] }, settings({ load_public_skills: true }));
    expect(on.sources).toEqual({ user: false, public: true, project: false });
    expect(on.loadingDisabled).toBe(false);
  });

  it("survives an empty / absent upstream body", () => {
    expect(skillsResponse({}, {})).toEqual({
      skills: [],
      disabledSkills: [],
      sources: { user: false, public: false, project: false },
      loadingDisabled: true,
      loadedUnavailable: false,
    });
    expect(skillsResponse({ skills: null }, { agent_settings: null })).toMatchObject({ skills: [] });
    expect(skillsResponse({}, settings({ disabled_skills: null })).disabledSkills).toEqual([]);
  });
});

// An auto-loaded skill never appears in GET /api/skills/installed, so without
// the POST /api/skills merge it would have no row — and a skill with no row
// cannot be denied, which is the whole point of the deny-list.
describe("skillsResponse — auto-loaded skills", () => {
  const loaded = {
    skills: [
      { name: "code-review", description: "from the repo", source: "public", type: "knowledge", content: "…" },
      { name: "browser", description: "Drives a browser", source: "public", type: "knowledge", content: "…" },
    ],
  };

  it("gives auto-loaded skills a row so they can be toggled at all", () => {
    const payload = skillsResponse(installed, settings({ load_public_skills: true }), loaded);
    const browser = payload.skills.find((s) => s.name === "browser");
    expect(browser).toMatchObject({
      installed: false,
      autoLoaded: true,
      installEnabled: true,
      denied: false,
      enabled: true,
      description: "Drives a browser",
      source: "public",
    });
  });

  it("lets the deny-list switch off an auto-loaded skill (its only lever)", () => {
    const payload = skillsResponse(installed, settings({ load_public_skills: true, disabled_skills: ["browser"] }), loaded);
    expect(payload.skills.find((s) => s.name === "browser")).toMatchObject({ denied: true, enabled: false });
  });

  it("keeps the installed record on a name collision but marks it in play", () => {
    // code-review is both installed and loaded; only the installed record
    // carries the install-level flag we render and mirror.
    const payload = skillsResponse(installed, settings({ load_public_skills: true }), loaded);
    const entries = payload.skills.filter((s) => s.name === "code-review");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ installed: true, autoLoaded: true, installEnabled: true, enabled: true });
  });

  it("never carries the skill body into the client payload", () => {
    const payload = skillsResponse({ skills: [] }, settings({ load_public_skills: true }), loaded);
    expect(JSON.stringify(payload)).not.toContain("…");
    expect(Object.keys(payload.skills[0])).not.toContain("content");
  });

  it("distinguishes a failed probe from an empty result", () => {
    // "we could not look" must not render as "there are none".
    expect(skillsResponse(installed, settings({ load_public_skills: true }), null, true).loadedUnavailable).toBe(true);
    expect(skillsResponse(installed, settings({ load_public_skills: true }), { skills: [] }).loadedUnavailable).toBe(false);
    expect(skillsResponse(installed, settings({ load_public_skills: true }), null).loadedUnavailable).toBe(false);
  });

  it("still lists deny-list-only ghosts alongside loaded ones", () => {
    const payload = skillsResponse({ skills: [] }, settings({ load_public_skills: true, disabled_skills: ["ghost-skill"] }), loaded);
    expect(payload.skills.map((s) => s.name)).toEqual(["browser", "code-review", "ghost-skill"]);
    expect(payload.skills.find((s) => s.name === "ghost-skill")).toMatchObject({ installed: false, autoLoaded: false, denied: true });
  });

  it("ignores nameless entries in the loaded set", () => {
    const payload = skillsResponse({ skills: [] }, settings({ load_public_skills: true }), { skills: [{ name: "" }, {}, { name: "ok-one" }] });
    expect(payload.skills.map((s) => s.name)).toEqual(["ok-one"]);
  });
});

describe("loadedSkillsRequest", () => {
  it("asks only for the sources that are switched on", () => {
    expect(loadedSkillsRequest({ user: true, public: false, project: true })).toEqual({
      load_public: false,
      load_user: true,
      // Project skills resolve per conversation and org skills need configs we
      // do not manage — asking for either costs a round-trip for nothing.
      load_project: false,
      load_org: false,
    });
  });
});

describe("isValidSkillName", () => {
  it("accepts the upstream path-param pattern", () => {
    expect(isValidSkillName("pdf")).toBe(true);
    expect(isValidSkillName("code-review")).toBe(true);
    expect(isValidSkillName("a1-b2-c3")).toBe(true);
  });

  it("rejects anything that could escape or break the skills URL", () => {
    expect(isValidSkillName("Code-Review")).toBe(false);
    expect(isValidSkillName("code_review")).toBe(false);
    expect(isValidSkillName("code--review")).toBe(false);
    expect(isValidSkillName("-code")).toBe(false);
    expect(isValidSkillName("code-")).toBe(false);
    expect(isValidSkillName("../../settings")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName("a".repeat(256))).toBe(false);
    expect(isValidSkillName(42)).toBe(false);
  });
});

describe("validateSkillsPatch", () => {
  it("disabling an installed skill denies it and mirrors the install-level flag", () => {
    const plan = validateSkillsPatch({ skills: { "code-review": false } }, current);
    expect(plan).toEqual({
      installedToggles: [{ name: "code-review", enabled: false }],
      agentContextDiff: { disabled_skills: ["legacy-skill", "code-review"], skills: [] },
    });
  });

  it("enabling an installed skill lifts the deny-list entry and the install flag together", () => {
    const denied = skillsResponse(installed, settings({ disabled_skills: ["code-review"] }));
    const plan = validateSkillsPatch({ skills: { "code-review": true } }, denied);
    expect(plan).toEqual({ installedToggles: [], agentContextDiff: { disabled_skills: [], skills: [] } });

    // pdf is install-disabled but not denied: enabling only touches the install flag.
    const plan2 = validateSkillsPatch({ skills: { pdf: true } }, current);
    expect(plan2).toEqual({ installedToggles: [{ name: "pdf", enabled: true }], agentContextDiff: null });
  });

  it("never PATCHes an install-level flag for a name that is not installed (would 404)", () => {
    const plan = validateSkillsPatch({ skills: { "ghost-skill": true } }, skillsResponse(installed, settings({ disabled_skills: ["ghost-skill"] })));
    expect(plan).toEqual({ installedToggles: [], agentContextDiff: { disabled_skills: [], skills: [] } });
  });

  it("omits a no-op toggle from installedToggles", () => {
    // code-review is already install-enabled; only the deny-list moves.
    const plan = validateSkillsPatch({ skills: { "code-review": true } }, current);
    expect(plan).toEqual({ installedToggles: [], agentContextDiff: null });
  });

  it("sends the COMPLETE next deny-list because agent_settings_diff replaces lists wholesale", () => {
    // Deep-merge applies to objects only; a partial `disabled_skills` array
    // would silently drop every name we did not resend.
    const many = skillsResponse(installed, settings({ disabled_skills: ["a-one", "b-two", "c-three"] }));
    const plan = validateSkillsPatch({ skills: { "b-two": true, pdf: false } }, many);
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    expect(plan.agentContextDiff?.disabled_skills).toEqual(["a-one", "c-three", "pdf"]);
    // Order is stable: survivors keep their position, new denials append.
    expect(plan.agentContextDiff?.disabled_skills).not.toContain("b-two");
  });

  it("leaves disabled_skills out of the diff when the list is unchanged", () => {
    const plan = validateSkillsPatch({ sources: { public: true } }, current);
    expect(plan).toEqual({ installedToggles: [], agentContextDiff: { load_public_skills: true, skills: [] } });
  });

  it("maps the source flags and skips ones already at the requested value", () => {
    const plan = validateSkillsPatch({ sources: { user: true, public: true, project: true } }, current);
    // user is already true upstream, so only the two changes are sent.
    expect(plan).toEqual({
      installedToggles: [],
      agentContextDiff: { load_public_skills: true, load_project_skills: true, skills: [] },
    });
  });

  it("rejects non-object bodies, empty patches and unknown fields", () => {
    expect(validateSkillsPatch(null, current)).toHaveProperty("error");
    expect(validateSkillsPatch("x", current)).toHaveProperty("error");
    expect(validateSkillsPatch([], current)).toHaveProperty("error");
    expect(validateSkillsPatch({}, current)).toHaveProperty("error");
    expect(validateSkillsPatch({ unknownField: 1 }, current)).toHaveProperty("error");
    expect(validateSkillsPatch({ skills: [] }, current)).toHaveProperty("error");
    expect(validateSkillsPatch({ sources: "all" }, current)).toHaveProperty("error");
  });

  it("rejects invalid skill names before they can reach the upstream URL", () => {
    expect(validateSkillsPatch({ skills: { "../../settings": false } }, current)).toHaveProperty("error");
    expect(validateSkillsPatch({ skills: { "Code-Review": false } }, current)).toHaveProperty("error");
    expect(validateSkillsPatch({ skills: { "": false } }, current)).toHaveProperty("error");
  });

  it("rejects non-boolean toggle and source values", () => {
    expect(validateSkillsPatch({ skills: { pdf: "yes" } }, current)).toHaveProperty("error");
    expect(validateSkillsPatch({ sources: { user: 1 } }, current)).toHaveProperty("error");
  });

  // Upstream resolves load_user/load_public at model-construction time and
  // PERSISTS every materialized skill into agent_context.skills. Measured
  // live: flipping load_public_skills on inlined 59 skills into settings.json,
  // and turning it back off left 58 of them behind as explicit skills — the
  // source toggle was one-way until we started clearing the list.
  it("clears the resolved skill list on every agent_context write (or toggles are one-way)", () => {
    const publicOn = skillsResponse(installed, settings({ load_public_skills: true }));
    for (const [body, state] of [
      [{ sources: { public: true } }, current],
      // The reversal is the case that was actually broken.
      [{ sources: { public: false } }, publicOn],
      [{ skills: { "code-review": false } }, current],
      [{ skills: { pdf: false }, sources: { project: true } }, current],
    ] as Array<[unknown, SkillsPayload]>) {
      const plan = validateSkillsPatch(body, state);
      expect("error" in plan).toBe(false);
      if ("error" in plan) continue;
      expect(plan.agentContextDiff).not.toBeNull();
      expect(plan.agentContextDiff?.skills).toEqual([]);
    }
  });

  it("does not send an agent_context diff at all when nothing there changed", () => {
    // No spurious skills:[] write when the patch is install-level only.
    expect(validateSkillsPatch({ skills: { pdf: true } }, current)).toEqual({
      installedToggles: [{ name: "pdf", enabled: true }],
      agentContextDiff: null,
    });
  });

  it("accepts an empty skills object as long as sources is present", () => {
    expect(validateSkillsPatch({ skills: {}, sources: { project: true } }, current)).toEqual({
      installedToggles: [],
      agentContextDiff: { load_project_skills: true, skills: [] },
    });
  });
});

// Server- and client-side classification of "is this skill on?" must agree:
// client/lib/skills.ts is a deliberate duplicate (no shared module, no client
// state), so this one case table pins both copies and fails CI on any drift.
describe("effective-enabled classification", () => {
  const cases: Array<[{ name?: string | null; enabled?: boolean | null } | null | undefined, string[], boolean]> = [
    [{ name: "pdf", enabled: true }, [], true],
    [{ name: "pdf" }, [], true], // missing flag defaults to enabled upstream
    [{ name: "pdf", enabled: false }, [], false],
    [{ name: "pdf", enabled: true }, ["pdf"], false], // deny-list wins
    [{ name: "pdf", enabled: false }, ["pdf"], false],
    [{ name: "pdf", enabled: true }, ["other"], true],
    [{ name: "pdf", enabled: null }, [], true],
    [{ name: "" }, [], false],
    [{ enabled: true }, [], false],
    [null, [], false],
    [undefined, ["pdf"], false],
  ];

  it("server classification", () => {
    for (const [skill, disabled, expected] of cases) {
      expect(skillEffectiveEnabled(skill, disabled)).toBe(expected);
    }
  });

  it("client classification matches the server", () => {
    for (const [skill, disabled, expected] of cases) {
      expect(clientSkillEffectiveEnabled(skill, disabled)).toBe(expected);
    }
  });

  it("both tolerate a null/undefined deny-list", () => {
    expect(skillEffectiveEnabled({ name: "pdf" }, null)).toBe(true);
    expect(clientSkillEffectiveEnabled({ name: "pdf" }, null)).toBe(true);
    expect(skillEffectiveEnabled({ name: "pdf" }, undefined)).toBe(true);
    expect(clientSkillEffectiveEnabled({ name: "pdf" }, undefined)).toBe(true);
  });

  it("agrees with the `enabled` field skillsResponse ships to the client", () => {
    const payload = skillsResponse(installed, settings({ disabled_skills: ["code-review"] }));
    for (const s of payload.skills) {
      expect(clientSkillEffectiveEnabled({ name: s.name, enabled: s.installEnabled }, payload.disabledSkills)).toBe(s.enabled);
    }
  });
});
