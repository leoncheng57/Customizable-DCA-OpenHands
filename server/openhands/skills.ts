// Skill toggles: which agent skills are actually in play, and the shaping /
// validation for the BFF's /skills routes. Pure module (no fetch) so vitest
// can exercise the merge and diff logic without an agent-server.
//
// TWO upstream mechanisms decide whether a skill reaches the prompt, and both
// have to be read to answer "is this on?":
//
//   1. Install-level flag — `GET /api/skills/installed` returns an `enabled`
//      boolean per installed skill, flipped by
//      `PATCH /api/skills/installed/{name} {"enabled": bool}`. It only exists
//      for skills that were explicitly installed, so it cannot express
//      "off" for an auto-loaded public/user/project skill.
//   2. Deny-list — `agent_context.disabled_skills: string[]` on the default
//      profile, which upstream documents as "the single, drift-tolerant skill
//      selection mechanism — a deny-list applied after every skill source is
//      loaded (auto-loaded user/public, explicit, and lazily-loaded project
//      skills). A listed name absent from the loaded set is a harmless no-op."
//
// EFFECTIVE = install-level enabled AND not on the deny-list. `skillsResponse`
// merges both into that one boolean; `skillEffectiveEnabled` is the classifier
// (deliberately mirrored in client/lib/skills.ts — see that file's header).
//
// Listing needs a THIRD upstream call. `GET /api/skills/installed` only knows
// about explicitly installed skills, so a public/user skill that was
// auto-loaded is invisible there — and an invisible skill cannot be switched
// off, which is exactly the case the deny-list exists for. `POST /api/skills`
// returns the merged effective set across every source, so the union of the
// three reads is what the user can actually act on:
//
//   installed  ∪  auto-loaded  ∪  already-denied names
//
// The last term keeps a toggle undoable after the skill stops being loaded.
// `POST /api/skills` is asked only for the sources the profile actually has
// switched on (a public load git-pulls the extensions repo, so an all-off
// profile skips the call entirely), and it is best-effort: if it fails the
// page still renders installed + denied rows with `loadedUnavailable` set,
// rather than the whole card erroring out.
//
// Project skills cannot be enumerated here at all: upstream resolves them
// lazily per conversation from the workspace path, which does not exist at
// global scope. The flag is still togglable — it just cannot be previewed.
//
// Writes therefore fan out: the deny-list is the authority (it covers names
// that are not installed at all), and the install-level flag is kept in
// lockstep for the names that DO exist upstream so the agent-server's own
// Canvas UI never disagrees with ours.
//
// Scope is GLOBAL — the default profile, applying to new conversations only
// (decision #17). The upstream API has no way to mutate a running
// conversation's `agent_context`, so a per-conversation toggle would be a
// half-feature; this mirrors decision #11 (condenser is a global setting).
//
// `agent_settings_diff` deep-merges objects but REPLACES LISTS WHOLESALE, so
// `disabled_skills` is strictly read-modify-write: we recompute the entire
// array from the current one plus the patch, never send a partial list.

/** Upstream path-param contract for PATCH /api/skills/installed/{skill_name}. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 255;

/** The three `load_*_skills` flags, camelCased. */
export interface SkillSources {
  /** ~/.openhands/skills/ + ~/.openhands/microagents/ inside the container. */
  user: boolean;
  /** The public OpenHands skills repository (github.com/OpenHands/extensions). */
  public: boolean;
  /** .openhands/skills/ + AGENTS.md in the conversation workspace. */
  project: boolean;
}

/** One row in the client's skills list. */
export interface SkillEntry {
  name: string;
  description: string;
  version: string;
  source: string;
  /** Present in GET /api/skills/installed (i.e. explicitly installed). */
  installed: boolean;
  /** Present in the POST /api/skills merged set (loaded from some source). */
  autoLoaded: boolean;
  /** The install-level `enabled` flag; always true for non-installed names. */
  installEnabled: boolean;
  /** Name appears in agent_context.disabled_skills. */
  denied: boolean;
  /** EFFECTIVE state — what the agent will actually see. */
  enabled: boolean;
}

export interface SkillsPayload {
  skills: SkillEntry[];
  /** The raw deny-list, drift included, so the client can re-derive `enabled`. */
  disabledSkills: string[];
  sources: SkillSources;
  /**
   * True when every skill source is off. Toggles still persist, but nothing
   * will be loaded for them to act on — the UI must say so rather than
   * showing a bare "no skills installed".
   */
  loadingDisabled: boolean;
  /**
   * The effective-set probe (POST /api/skills) did not answer, so auto-loaded
   * skills are missing from the list. Distinct from "there are none".
   */
  loadedUnavailable: boolean;
}

/** Subset of GET /api/skills/installed we read. */
export interface UpstreamInstalledSkills {
  skills?: Array<{
    name?: string;
    version?: string;
    description?: string;
    enabled?: boolean;
    source?: string;
  }> | null;
}

/**
 * Subset of the POST /api/skills merged set we read. `content` is the entire
 * skill body and is deliberately NOT carried into the client payload.
 */
export interface UpstreamLoadedSkills {
  skills?: Array<{
    name?: string;
    description?: string | null;
    source?: string | null;
    type?: string;
  }> | null;
}

/** Body for POST /api/skills — only ask for the sources that are switched on. */
export function loadedSkillsRequest(sources: SkillSources): Record<string, unknown> {
  return {
    load_public: sources.public,
    load_user: sources.user,
    // Project skills resolve from a conversation workspace that does not exist
    // at global scope, and org skills need configs we do not manage — asking
    // for either would cost a round-trip and always return nothing.
    load_project: false,
    load_org: false,
  };
}

/** Subset of GET /api/settings → agent_settings.agent_context we read. */
export interface UpstreamAgentContext {
  agent_settings?: {
    agent_context?: {
      disabled_skills?: string[] | null;
      load_user_skills?: boolean | null;
      load_public_skills?: boolean | null;
      load_project_skills?: boolean | null;
    } | null;
  } | null;
}

/** Snake_case diff for `agent_settings_diff.agent_context` in PATCH /api/settings. */
export interface AgentContextDiff {
  /** Always the COMPLETE next list — lists are replaced, not merged. */
  disabled_skills?: string[];
  load_user_skills?: boolean;
  load_public_skills?: boolean;
  load_project_skills?: boolean;
  /** See RESET_RESOLVED_SKILLS — always sent, always empty. */
  skills?: never[];
}

/**
 * Every agent_context write clears `skills`, and it must.
 *
 * Upstream's AgentContext *resolves* `load_user_skills` / `load_public_skills`
 * at model-construction time: the moment one is true, the matching source is
 * expanded and every skill is materialized — body text and all — into
 * `agent_context.skills`, which then gets persisted with the rest of the
 * profile. Measured against the live agent-server: flipping
 * `load_public_skills` on inlined 59 skills into settings.json.
 *
 * That is survivable while the flag is on (it merely mirrors reality), but it
 * makes the toggle ONE-WAY. Turning the source back off leaves the 59 resolved
 * skills sitting in `skills`, where they are now *explicit* skills — still
 * loaded, no longer governed by the flag that put them there. Verified:
 * `{load_public_skills: false}` alone left 58 behind, while
 * `{load_public_skills: false, skills: []}` left 0.
 *
 * So the flags stay the source of truth and the materialized copy is wiped on
 * every write. Lists are replaced wholesale by `agent_settings_diff`, which is
 * what makes a bare `[]` sufficient. When a source is on upstream immediately
 * re-resolves it, so this costs nothing there; when a source goes off, off
 * finally means off.
 */
export const RESET_RESOLVED_SKILLS: never[] = [];

export interface SkillsPatchPlan {
  /** Per-name PATCH /api/skills/installed/{name} calls to make (may be empty). */
  installedToggles: Array<{ name: string; enabled: boolean }>;
  /** agent_context diff to PATCH, or null when nothing there changed. */
  agentContextDiff: AgentContextDiff | null;
}

/**
 * THE classifier: is this skill effectively on? Install-level `enabled`
 * defaults to true upstream (the field is optional), and the deny-list wins
 * over it because it is applied after every source has loaded.
 *
 * Kept byte-for-byte in sync with `skillEffectiveEnabled` in
 * client/lib/skills.ts; tests/skills.test.ts asserts one shared case table
 * against both.
 */
export function skillEffectiveEnabled(
  skill: { name?: string | null; enabled?: boolean | null } | null | undefined,
  disabledSkills: readonly string[] | null | undefined,
): boolean {
  const name = typeof skill?.name === "string" ? skill.name : "";
  if (name === "") return false;
  const installEnabled = skill?.enabled !== false;
  const denied = (disabledSkills ?? []).includes(name);
  return installEnabled && !denied;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

/**
 * Merge the three reads into one client payload: installed skills, the
 * auto-loaded effective set, and deny-listed names that match neither.
 *
 * Installed wins on a name collision — an installed skill is also loaded (it
 * lives under ~/.openhands/skills/), but only the installed record carries the
 * install-level `enabled` flag we need to render and mirror.
 *
 * `loaded` is null when the probe was skipped (every source off — nothing to
 * enumerate) or failed; `loadedUnavailable` distinguishes the failure, because
 * "we could not look" must not read as "there are none".
 */
export function skillsResponse(
  installed: UpstreamInstalledSkills,
  settings: UpstreamAgentContext,
  loaded?: UpstreamLoadedSkills | null,
  loadedUnavailable = false,
): SkillsPayload {
  const ctx = settings.agent_settings?.agent_context ?? {};
  const disabledSkills = strings(ctx.disabled_skills);

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const s of installed.skills ?? []) {
    const name = typeof s?.name === "string" ? s.name : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    skills.push({
      name,
      description: typeof s.description === "string" ? s.description : "",
      version: typeof s.version === "string" ? s.version : "",
      source: typeof s.source === "string" ? s.source : "",
      installed: true,
      autoLoaded: false,
      installEnabled: s.enabled !== false,
      denied: disabledSkills.includes(name),
      enabled: skillEffectiveEnabled(s, disabledSkills),
    });
  }
  for (const s of loaded?.skills ?? []) {
    const name = typeof s?.name === "string" ? s.name : "";
    if (name === "") continue;
    const existing = skills.find((e) => e.name === name);
    if (existing) {
      // Same skill seen from both angles: keep the installed record (it owns
      // the install-level flag) and just record that it is in play.
      existing.autoLoaded = true;
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const denied = disabledSkills.includes(name);
    skills.push({
      name,
      description: typeof s.description === "string" ? s.description : "",
      version: "",
      source: typeof s.source === "string" ? s.source : "",
      installed: false,
      autoLoaded: true,
      // Nothing to disable at install level for an auto-loaded skill — the
      // deny-list is the only lever, so it alone decides.
      installEnabled: true,
      denied,
      enabled: !denied,
    });
  }
  for (const name of disabledSkills) {
    if (seen.has(name)) continue;
    seen.add(name);
    skills.push({
      name,
      description: "",
      version: "",
      source: "",
      installed: false,
      autoLoaded: false,
      installEnabled: true,
      denied: true,
      enabled: false,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const sources: SkillSources = {
    user: ctx.load_user_skills === true,
    public: ctx.load_public_skills === true,
    project: ctx.load_project_skills === true,
  };
  return {
    skills,
    disabledSkills,
    sources,
    loadingDisabled: !sources.user && !sources.public && !sources.project,
    loadedUnavailable,
  };
}

/** A skill name we are willing to put in an upstream URL path. */
export function isValidSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(name);
}

/**
 * Validate a client PATCH body and turn it into an upstream call plan.
 *
 * Body shape (both keys optional, at least one required):
 *   { skills: { "<name>": boolean, … }, sources: { user?, public?, project? } }
 *
 * `disabled_skills` is recomputed in full from `current` because
 * `agent_settings_diff` replaces lists wholesale; existing order is preserved
 * and newly denied names are appended, so repeated saves are stable. Names are
 * validated against the upstream path pattern BEFORE any request is made — an
 * unvalidated name would be interpolated into the skills URL.
 */
export function validateSkillsPatch(
  body: unknown,
  current: SkillsPayload,
): { error: string } | SkillsPatchPlan {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be an object" };
  }
  const b = body as Record<string, unknown>;

  const toggles: Array<[string, boolean]> = [];
  if (b.skills !== undefined) {
    if (typeof b.skills !== "object" || b.skills === null || Array.isArray(b.skills)) {
      return { error: "skills must be an object mapping skill name to a boolean" };
    }
    for (const [name, value] of Object.entries(b.skills as Record<string, unknown>)) {
      if (!isValidSkillName(name)) {
        return { error: `invalid skill name "${name}" (lowercase alphanumeric and hyphens, max ${SKILL_NAME_MAX})` };
      }
      if (typeof value !== "boolean") return { error: `skills.${name} must be a boolean` };
      toggles.push([name, value]);
    }
  }

  const diff: AgentContextDiff = {};
  if (b.sources !== undefined) {
    if (typeof b.sources !== "object" || b.sources === null || Array.isArray(b.sources)) {
      return { error: "sources must be an object" };
    }
    const src = b.sources as Record<string, unknown>;
    const map = [
      ["user", "load_user_skills"],
      ["public", "load_public_skills"],
      ["project", "load_project_skills"],
    ] as const;
    for (const [key, upstreamKey] of map) {
      if (src[key] === undefined) continue;
      if (typeof src[key] !== "boolean") return { error: `sources.${key} must be a boolean` };
      if (src[key] !== current.sources[key]) diff[upstreamKey] = src[key] as boolean;
    }
  }

  if (b.skills === undefined && b.sources === undefined) {
    return { error: "no recognized fields in patch (skills, sources)" };
  }

  // Deny-list: read-modify-write over the CURRENT list, order-stable.
  const requested = new Map(toggles);
  const nextDenied = current.disabledSkills.filter((name) => requested.get(name) !== true);
  for (const [name, enabled] of toggles) {
    if (!enabled && !nextDenied.includes(name)) nextDenied.push(name);
  }
  const denyChanged =
    nextDenied.length !== current.disabledSkills.length ||
    nextDenied.some((name, i) => name !== current.disabledSkills[i]);
  if (denyChanged) diff.disabled_skills = nextDenied;

  // Install-level flag only exists for installed skills; PATCHing an unknown
  // name 404s, so mirror the toggle exactly where there is something to mirror.
  const installedByName = new Map(current.skills.filter((s) => s.installed).map((s) => [s.name, s]));
  const installedToggles = toggles
    .filter(([name, enabled]) => {
      const entry = installedByName.get(name);
      return entry !== undefined && entry.installEnabled !== enabled;
    })
    .map(([name, enabled]) => ({ name, enabled }));

  if (Object.keys(diff).length === 0) return { installedToggles, agentContextDiff: null };
  // Never persist upstream's materialized copy of the resolved sources — it
  // would make a source toggle one-way. See RESET_RESOLVED_SKILLS.
  diff.skills = RESET_RESOLVED_SKILLS;
  return { installedToggles, agentContextDiff: diff };
}
