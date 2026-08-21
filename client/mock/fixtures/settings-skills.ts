// client/mock/fixtures/settings-skills.ts
//
// Skill state for the demo, modelled the way the agent-server actually stores
// it rather than as a list of pre-computed checkboxes — because the whole
// point of decision #17 is that "is this skill on?" is DERIVED from two
// independent upstream facts:
//
//   1. the install-level `enabled` flag, which only exists for skills that
//      were explicitly installed, and
//   2. `agent_context.disabled_skills`, the deny-list, which is the authority
//      because it also covers auto-loaded skills that have no install row.
//
// So the state below is (installed records) + (auto-loaded records) +
// (deny-list) + (the three `load_*_skills` source flags), and the payload the
// route returns is assembled from them by `buildSkillsPayload`, which mirrors
// `skillsResponse` in server/openhands/skills.ts: the list is
// `installed ∪ auto-loaded ∪ already-denied`, sorted by name, and the
// effective boolean comes from the REAL classifier in client/lib/skills.ts.
// A demo that hardcoded `enabled` would let the checkbox and the row's own
// origin label disagree, which is exactly the bug the split exists to catch.
//
// The seeded rows cover every interesting case the Tools page can render:
//
//   changelog-writer    installed, enabled, not denied      → on
//   api-contract-check  installed, enabled, DENIED          → off (deny-list wins)
//   slide-deck          installed, install-flag off         → off (no deny-list entry)
//   dependency-audit    auto-loaded only                    → on
//   web-scraper         auto-loaded only, DENIED            → off (its only lever)
//   legacy-migrator     deny-list only, nothing loaded      → off, still re-enableable
import type { SkillEntry, SkillsSettings, SkillSources } from "../../lib/api.js";
import { skillEffectiveEnabled } from "../../lib/skills.js";

/** An explicitly installed skill, as `GET /api/skills/installed` reports it. */
export interface InstalledSkillRecord {
  name: string;
  version: string;
  description: string;
  source: string;
  /** The install-level flag. Upstream omits it to mean `true`. */
  enabled: boolean;
}

/** A skill the agent loaded from a source without it being installed. */
export interface LoadedSkillRecord {
  name: string;
  description: string;
  source: string;
}

/** Everything the demo needs to answer GET /skills and apply a PATCH. */
export interface SkillsState {
  installed: InstalledSkillRecord[];
  loaded: LoadedSkillRecord[];
  /** Raw `agent_context.disabled_skills`, order-significant. */
  disabledSkills: string[];
  sources: SkillSources;
}

export function initialSkillsState(): SkillsState {
  return {
    installed: [
      {
        name: "changelog-writer",
        version: "1.4.0",
        description: "Turns a merged diff into a release note entry in the project's own voice.",
        source: "github:OpenHands/extensions",
        enabled: true,
      },
      {
        name: "api-contract-check",
        version: "0.9.2",
        description: "Diffs an OpenAPI document against the previous tag and flags breaking changes.",
        source: "github:OpenHands/extensions",
        enabled: true,
      },
      {
        name: "slide-deck",
        version: "0.3.1",
        description: "Renders a short deck from a markdown outline. Rarely useful for code work.",
        source: "github:OpenHands/extensions",
        enabled: false,
      },
    ],
    loaded: [
      {
        name: "dependency-audit",
        description: "Reads the lockfile and reports advisories affecting the pinned versions.",
        source: "public",
      },
      {
        name: "web-scraper",
        description: "Fetches and extracts page content. Denied here — it reaches the network unattended.",
        source: "public",
      },
    ],
    // `web-scraper` is auto-loaded, so the deny-list is the ONLY way to switch
    // it off; `legacy-migrator` is not loaded from anywhere any more, and its
    // row exists solely so the toggle stays undoable.
    disabledSkills: ["api-contract-check", "web-scraper", "legacy-migrator"],
    // Both defaults are `false` upstream; the demo switches two on so the list
    // is not immediately in the "skill loading is off" state. Unchecking both
    // in the UI reaches that state, which the page explains for itself.
    sources: { user: true, public: true, project: false },
  };
}

/**
 * Merge the three views into the client payload — the same union, ordering and
 * precedence as `skillsResponse` upstream: an installed record wins a name
 * collision (only it carries the install-level flag), auto-loaded rows get
 * `installEnabled: true` because there is nothing to disable at install level,
 * and deny-listed names nobody loaded still get a row.
 */
export function buildSkillsPayload(state: SkillsState): SkillsSettings {
  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const s of state.installed) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    skills.push({
      name: s.name,
      description: s.description,
      version: s.version,
      source: s.source,
      installed: true,
      autoLoaded: false,
      installEnabled: s.enabled,
      denied: state.disabledSkills.includes(s.name),
      enabled: skillEffectiveEnabled({ name: s.name, enabled: s.enabled }, state.disabledSkills),
    });
  }

  // Auto-loaded rows only exist while some source is switched on: upstream
  // enumerates them by actually loading them, so an all-off profile reports
  // none. Modelling that keeps the "loading is off" state honest.
  const anySource = state.sources.user || state.sources.public || state.sources.project;
  if (anySource) {
    for (const s of state.loaded) {
      const existing = skills.find((e) => e.name === s.name);
      if (existing) {
        existing.autoLoaded = true;
        continue;
      }
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const denied = state.disabledSkills.includes(s.name);
      skills.push({
        name: s.name,
        description: s.description,
        version: "",
        source: s.source,
        installed: false,
        autoLoaded: true,
        installEnabled: true,
        denied,
        enabled: skillEffectiveEnabled({ name: s.name, enabled: true }, state.disabledSkills),
      });
    }
  }

  for (const name of state.disabledSkills) {
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

  return {
    skills,
    disabledSkills: [...state.disabledSkills],
    sources: { ...state.sources },
    loadingDisabled: !anySource,
    // The demo's effective-set probe always answers, so this is never true —
    // the page's "couldn't enumerate auto-loaded skills" banner belongs to a
    // failure the simulation has no way to have.
    loadedUnavailable: false,
  };
}

/** Upstream's path-param contract for PATCH /api/skills/installed/{name}. */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 255;

const SOURCE_KEYS = ["user", "public", "project"] as const;

/**
 * Validate a `PATCH /skills` body and apply it, returning the next state.
 *
 * The rules are the ones `validateSkillsPatch` enforces upstream, and they are
 * not arbitrary:
 *  · the deny-list is recomputed IN FULL and order-stably (upstream's
 *    `agent_settings_diff` replaces lists wholesale, so a partial list would
 *    silently drop every name it omitted);
 *  · the install-level flag is mirrored only for names that are actually
 *    installed, because PATCHing an unknown one 404s upstream;
 *  · names are checked against the URL-safe pattern before anything else.
 *
 * Returns an error string instead of throwing so the route can decide the
 * status code.
 */
export function applySkillsPatch(
  state: SkillsState,
  body: unknown,
): { error: string } | { next: SkillsState } {
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
      if (name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) {
        return { error: `invalid skill name "${name}" (lowercase alphanumeric and hyphens, max ${SKILL_NAME_MAX})` };
      }
      if (typeof value !== "boolean") return { error: `skills.${name} must be a boolean` };
      toggles.push([name, value]);
    }
  }

  const sources: SkillSources = { ...state.sources };
  if (b.sources !== undefined) {
    if (typeof b.sources !== "object" || b.sources === null || Array.isArray(b.sources)) {
      return { error: "sources must be an object" };
    }
    const src = b.sources as Record<string, unknown>;
    for (const key of SOURCE_KEYS) {
      if (src[key] === undefined) continue;
      if (typeof src[key] !== "boolean") return { error: `sources.${key} must be a boolean` };
      sources[key] = src[key] as boolean;
    }
  }

  if (b.skills === undefined && b.sources === undefined) {
    return { error: "no recognized fields in patch (skills, sources)" };
  }

  // Deny-list: read-modify-write over the current list. Survivors keep their
  // position so repeated saves are stable; new denials append.
  const requested = new Map(toggles);
  const disabledSkills = state.disabledSkills.filter((name) => requested.get(name) !== true);
  for (const [name, enabled] of toggles) {
    if (!enabled && !disabledSkills.includes(name)) disabledSkills.push(name);
  }

  const installed = state.installed.map((s) =>
    requested.has(s.name) ? { ...s, enabled: requested.get(s.name) as boolean } : s,
  );

  return { next: { ...state, installed, disabledSkills, sources } };
}
