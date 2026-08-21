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
// Notes for whoever fills this in:
//  · `GET /repos` is cached in localStorage by the client (`openhands.repos.v1`,
//    24h TTL) — a visitor's second page load reads the demo repo list from
//    there before the mock even answers. Keep the fixture stable.
//  · The PATCH routes must ECHO BACK the full updated object: the pages replace
//    their state with the response, so returning a partial silently blanks the
//    form. Persist the mutation in ./state.ts under a `settings:` key prefix so
//    the following GET agrees.
//  · `SkillsSettings.enabled` is the EFFECTIVE state (install flag AND not in
//    `disabledSkills`); the client re-derives it in lib/skills.ts and a
//    mismatch shows up as a UI that disagrees with itself.
//  · `POST /notifications/test` claims a push was delivered. In a demo nothing
//    is delivered — say so in the returned `url`/`topic` (an obviously fake
//    endpoint) rather than inventing a plausible one.
//  · `GET /mr/pipeline` legitimately returns `null` when no pipeline has run;
//    that is a 200 with a `null` body, i.e. `return null`.
//  · Repo paths, hostnames, issue URLs and author names in fixtures must be
//    invented — tests/mock-fixtures.test.ts fails the build otherwise.
//
// TODO(agent): implement the routes above.
import type { HandlerGroup } from "./types.js";

export const handlers: HandlerGroup = {
  name: "settings",
  routes: {},
};
