// client/mock/conversations.ts
//
// OWNER: the conversations group. Read ./types.ts first — it is the contract.
//
// Endpoints this group owns (paths are already stripped of the deploy base and
// the `/api/openhands` prefix):
//
//   GET    /status                                       → OpenHandsStatus
//   GET    /conversations                                → { items: ConversationSummary[] }
//   POST   /conversations                                → { id, started }
//   GET    /conversations/:id                            → ConversationSummary
//   DELETE /conversations/:id                            → unknown (the UI ignores the body)
//   GET    /conversations/:id/events                     → { items: RawOpenHandsEvent[]; next_page_id: string | null }
//   POST   /conversations/:id/messages                   → unknown
//   POST   /conversations/:id/run                        → unknown
//   POST   /conversations/:id/pause                      → unknown
//   POST   /conversations/:id/mode                       → { mode: "build" | "plan"; notified: boolean }
//   POST   /conversations/:id/respond_to_confirmation    → unknown
//   GET    /conversations/:id/agent_final_response       → string | null
//   SSE    GET /conversations/:id/stream                 → `streams`, named frames: delta / reasoning / event
//
// NOT this group: `/conversations/:id/preview/*` belongs to ./workspace.ts,
// which owns the whole preview surface. Do not declare a preview route here.
//
// START HERE: `GET /status` is load-bearing for the whole site. Hub.tsx:233 is
// `if (!status) return <LoadingIndicator/>`, so until that one route answers,
// the app's homepage is an infinite spinner rather than an empty state. A
// throwaway placeholder is wired up below purely so the scaffold deploys
// without a hang — replace it (and delete this paragraph) with the real thing.
//
// Notes for whoever fills this in:
//  · `GET /conversations/:id/events` is polled every 3s by Conversation.tsx and
//    is the transcript's real source. The SSE stream only paints an in-flight
//    draft; leaving `streams` empty is fine.
//  · `?order=desc` on the events route means newest-first, and `next_page_id`
//    then walks toward OLDER events — that is how the transcript pages upward.
//  · `execution_status` drives colour, polling cadence and the notification
//    watcher: "running" | "finished" | "error" | "stuck" | "idle" | "paused" |
//    "waiting_for_confirmation" (see TERMINAL_STATUSES in lib/api.ts).
//  · Plan/Build mode is READ from `confirmation_policy.kind`, not stored
//    client-side — see lib/planMode.ts.
//  · Timestamps come from ./clock.ts (`isoAt(-5 * MINUTE)`), never hardcoded.
//  · Mutable state (a conversation created by the composer) goes in
//    ./state.ts under a `conversations:` key prefix.
//
// TODO(agent): implement the routes above.
import type { OpenHandsStatus } from "../lib/api.js";
import type { HandlerGroup } from "./types.js";

export const handlers: HandlerGroup = {
  name: "conversations",
  routes: {
    // PLACEHOLDER — see "START HERE" above. Just enough for the shell to get
    // past its loading gate; every other route is still unhandled, so the hub
    // renders empty rather than spinning.
    "GET /status": (): OpenHandsStatus => ({
      configured: true,
      allowlisted: true,
      publicUrl: null,
      server: { version: "demo" },
    }),
  },
  streams: {},
};
