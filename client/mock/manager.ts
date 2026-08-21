// client/mock/manager.ts
//
// OWNER: the manager-runs group. Read ./types.ts first — it is the contract.
//
// Endpoints this group owns — everything under `/manager/*`. The exact set the
// client calls is `managerApi` in client/lib/manager-api.ts:
//
//   GET  /manager/runs                                → { items: RunRecord[] }
//   POST /manager/runs                                → RunRecord            (body: CreateRunInput)
//   GET  /manager/runs/:id                            → BoardState
//   POST /manager/runs/:id/approve                    → { result: { ok, message }; run: RunRecord }
//   POST /manager/runs/:id/reject-plan                → { ok, message, run: RunRecord }   (body: { reason })
//   POST /manager/runs/:id/nudge                      → { ok, message }                   (body: { task, message, model? })
//   POST /manager/runs/:id/cancel                     → { ok, message }
//   GET  /manager/conversations/:conversationId/run   → { runId, role, task?, title, status } | 404
//   GET  /manager/conversation-roles                  → { roles: Record<string, ConversationRole> }
//   GET  /manager/repo-stats                          → RepoStats            (query: repoUrl, workers)
//
// Notes for whoever fills this in:
//  · `/manager/conversations/:conversationId/run` MUST 404 (not 200-with-null)
//    for a conversation that is not part of a run — `managerApi.conversationRun`
//    treats 404 as "genuinely not in a run" and any other error as transient.
//    Use `throw new MockHttpError(404, "not in a run")`.
//  · `GET /manager/conversation-roles` is what nests worker rows under their
//    manager on the hub (`groupConversationsByRun`). Its keys are conversation
//    ids owned by ./conversations.ts — keep the two fixtures in agreement.
//  · The board page polls `/manager/runs/:id`; `BoardWorker.ageSeconds` /
//    `stale` should be derived from ./clock.ts so they keep ticking.
//  · `RunStatus` "planning" → "plan-ready" → "active" → terminal is the story
//    arc the board UI is built around; a plan-ready run shows the approve/reject
//    controls.
//  · Mutable state (approve/cancel changing a run) goes in ./state.ts under a
//    `manager:` key prefix.
//
// TODO(agent): implement the routes above.
import type { HandlerGroup } from "./types.js";

export const handlers: HandlerGroup = {
  name: "manager",
  routes: {},
};
