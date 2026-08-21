// client/mock/settings.ts
//
// OWNER: the settings group — project sources, tools, skills, notifications,
// agent settings and the merge-request panel. Read ./types.ts first: it is the
// contract.
//
// Endpoints this group owns:
//
//   GET   /repos                → { items: RepoOption[] }
//   GET   /local-folders        → { items: Array<{ name: string; path: string }> }
//   GET   /suggested-issues     → SuggestedIssuesResponse        (query: repo)
//   GET   /tools                → ToolsHealth                    (query: refresh=1 on manual re-probe)
//   GET   /skills               → SkillsSettings
//   PATCH /skills               → SkillsSettings                 (body: { skills?, sources? })
//   GET   /notifications        → NotificationSettings
//   PATCH /notifications        → NotificationSettings           (body: enabled/notifyIdle/mentionMe/ntfyUrl?/ntfyTopic?)
//   POST  /notifications/test   → { ok: boolean; url: string; topic: string }
//   GET   /agent-settings       → AgentSettings
//   PATCH /agent-settings       → AgentSettings                  (body: { condenser })
//   GET   /mr                   → MrInfo                         (query: url)
//   GET   /mr/comments          → { items: MrComment[] }          (query: url)
//   GET   /mr/pipeline          → MrPipelineProgress | null       (query: url)
//   POST  /mr/merge             → MrInfo                          (body: { url })
//
// Everything mutable lives in ./state.ts under the `settings:` prefix, so a
// PATCH is visible to the GET the page fires next and a toggled checkbox stays
// toggled until the tab is reloaded. The fixtures in ./fixtures/ hold the data
// and the validation rules; this file is just the wiring.
//
// Two places where the simulation deliberately refuses to playact:
//
//  · `POST /notifications/test` reports success — the request did "succeed" —
//    but names an endpoint on a `.invalid` host with a topic that reads
//    `demo-nothing-was-actually-sent`, because the page's confirmation line
//    ends "check your subscribed device" and no device was pinged.
//  · `POST /mr/merge` returns 409 instead of flipping the card to Merged.
//    Every other write here is a preference inside this app, and simulating
//    those is what a sandbox is for; a merge is an irreversible action against
//    someone else's repository, and a green "Merged" badge for one that never
//    happened is a different kind of claim. The card's own error row says so
//    in one line, which is more informative than a silent fake success.
import { MockHttpError, type HandlerGroup, type MockRequest } from "./types.js";
import { demoState } from "./state.js";
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
} from "../lib/api.js";
import { applyCondenserPatch, applyNotificationsPatch, initialAgentSettings, initialNotifications, DEMO_NTFY_TEST_TOPIC, DEMO_NTFY_URL } from "./fixtures/settings-prefs.js";
import { applySkillsPatch, buildSkillsPayload, initialSkillsState, type SkillsState } from "./fixtures/settings-skills.js";
import { DEMO_LOCAL_FOLDERS, DEMO_REPOS, suggestedIssuesFor } from "./fixtures/settings-projects.js";
import { toolsHealth } from "./fixtures/tools-health.js";
import { mrComments, mrInfo, mrPipeline, parseMrTarget } from "./fixtures/mr-thread.js";

const SKILLS_KEY = "settings:skills";
const NOTIFICATIONS_KEY = "settings:notifications";
const AGENT_KEY = "settings:agent-settings";
const TOOLS_CACHE_KEY = "settings:tools-cache";

/** Same 30s window the real route caches its probe for. */
const TOOLS_CACHE_MS = 30_000;
/**
 * A forced re-probe of a live agent-server costs seconds (a bash exec, an MCP
 * connect per server, three token checks). The Re-check button says
 * "Checking…" while that happens, and a button that finishes instantly reads
 * as a button that did nothing.
 */
const TOOLS_REFRESH_MS = 1_400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skillsState(): SkillsState {
  return demoState.ensure(SKILLS_KEY, initialSkillsState);
}

function notifications(): NotificationSettings {
  return demoState.ensure(NOTIFICATIONS_KEY, initialNotifications);
}

function agentSettings(): AgentSettings {
  return demoState.ensure(AGENT_KEY, initialAgentSettings);
}

/** Query param, trimmed; `""` when absent. */
function param(req: MockRequest, name: string): string {
  return (req.query.get(name) ?? "").trim();
}

/** The MR/PR url every /mr* route needs, with the real 400 when it is missing. */
function mrUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new MockHttpError(400, "url must be a GitLab merge request or GitHub pull request URL");
  }
  return raw.trim();
}

export const handlers: HandlerGroup = {
  name: "settings",
  routes: {
    // ── Project sources ────────────────────────────────────────────────────
    // The client caches this list in localStorage for 24h, so it has to stay
    // stable across reloads: no shuffling, no clock-dependent entries.
    "GET /repos": () => ({ items: DEMO_REPOS satisfies RepoOption[] }),

    "GET /local-folders": () => ({ items: DEMO_LOCAL_FOLDERS }),

    "GET /suggested-issues": (req): SuggestedIssuesResponse => {
      const repo = param(req, "repo");
      if (!repo || repo.includes("..")) {
        throw new MockHttpError(400, "repo must be a valid GitLab project path (group/subgroup/name)");
      }
      // Repos without a bespoke issue list still get one, so no path through
      // the picker dead-ends on an empty panel it cannot explain.
      return suggestedIssuesFor(repo);
    },

    // ── Tools & health ─────────────────────────────────────────────────────
    "GET /tools": async (req): Promise<ToolsHealth> => {
      const refresh = req.query.get("refresh") === "1";
      const cached = demoState.get<{ at: number; body: ToolsHealth }>(TOOLS_CACHE_KEY);
      if (!refresh && cached && Date.now() - cached.at < TOOLS_CACHE_MS) return cached.body;
      if (refresh) await sleep(TOOLS_REFRESH_MS);

      const skills = buildSkillsPayload(skillsState()).skills;
      const prefs = notifications();
      const body = toolsHealth({
        // The health roll-up reads the installed set, so a skill switched off
        // on this very page reports "installed, disabled" on the next probe.
        skills: skills.filter((s) => s.installed).map((s) => ({ name: s.name, installEnabled: s.installEnabled })),
        ntfy: prefs.enabled && prefs.ntfyTopic ? { url: prefs.ntfyUrl, topic: prefs.ntfyTopic } : null,
      });
      demoState.set(TOOLS_CACHE_KEY, { at: Date.now(), body });
      return body;
    },

    // ── Skills (global — decision #17) ─────────────────────────────────────
    "GET /skills": (): SkillsSettings => buildSkillsPayload(skillsState()),

    "PATCH /skills": (req): SkillsSettings => {
      const result = applySkillsPatch(skillsState(), req.body);
      if ("error" in result) throw new MockHttpError(400, result.error);
      demoState.set(SKILLS_KEY, result.next);
      // The skills roll-up on the Tools page is derived from this state, so a
      // stale probe would disagree with the card the user just clicked.
      demoState.delete(TOOLS_CACHE_KEY);
      return buildSkillsPayload(result.next);
    },

    // ── Notifications ──────────────────────────────────────────────────────
    "GET /notifications": (): NotificationSettings => notifications(),

    "PATCH /notifications": (req): NotificationSettings => {
      const result = applyNotificationsPatch(notifications(), req.body);
      if ("error" in result) throw new MockHttpError(400, result.error);
      demoState.set(NOTIFICATIONS_KEY, result.next);
      // The Tools page's ntfy integration row reads these values.
      demoState.delete(TOOLS_CACHE_KEY);
      return result.next;
    },

    // Nothing is delivered: there is no server here to post to, and a browser
    // cannot reach a push endpoint on the user's behalf. The response is
    // shaped like the real one so the page renders its success line, but the
    // target it names is unresolvable by construction and says what happened.
    "POST /notifications/test": () => {
      const prefs = notifications();
      if (!prefs.ntfyTopic) {
        throw new MockHttpError(400, "No ntfy topic configured (set one below or via OPENHANDS_NTFY_TOPIC)");
      }
      return { ok: true, url: DEMO_NTFY_URL, topic: DEMO_NTFY_TEST_TOPIC };
    },

    // ── Agent settings (condenser — decision #11) ──────────────────────────
    "GET /agent-settings": (): AgentSettings => agentSettings(),

    "PATCH /agent-settings": (req): AgentSettings => {
      const body = (req.body as { condenser?: unknown } | undefined)?.condenser ?? req.body;
      const result = applyCondenserPatch(agentSettings().condenser, body);
      if ("error" in result) throw new MockHttpError(400, result.error);
      const next: AgentSettings = { condenser: result.next };
      demoState.set(AGENT_KEY, next);
      return next;
    },

    // ── Merge request panel ────────────────────────────────────────────────
    "GET /mr": (req): MrInfo => mrInfo(parseMrTarget(mrUrl(param(req, "url")))),

    "GET /mr/comments": (req): { items: MrComment[] } => {
      mrUrl(param(req, "url"));
      return { items: mrComments() };
    },

    "GET /mr/pipeline": (req): MrPipelineProgress => mrPipeline(parseMrTarget(mrUrl(param(req, "url")))),

    // Refused, not simulated — see the header note. 409 is what the panel
    // renders in its `openhands-mr-merge-error` row, so the reason lands right
    // under the button that was pressed.
    "POST /mr/merge": (req) => {
      mrUrl((req.body as { url?: unknown } | undefined)?.url);
      throw new MockHttpError(
        409,
        "Nothing was merged — this is a simulation and there is no repository behind this card. In the real app the button calls the merge API and the badge flips to Merged.",
      );
    },
  },
};
