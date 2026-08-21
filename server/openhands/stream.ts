// SSE bridge for live LLM token streaming (issue #48).
//
// The agent-server publishes transient `StreamingDeltaEvent` frames (LLM
// token deltas — never persisted to the event log) plus every durable event
// over its websocket `/sockets/events/{id}`. The BFF deliberately has no
// websocket proxying, so the browser polls and sees nothing for the entire
// duration of an LLM step. This module maps upstream websocket frames onto a
// small SSE vocabulary the Conversation page consumes:
//
//   event: delta      data: {"content":"..."}   → append to the draft bubble
//   event: reasoning  data: {"content":"..."}   → append to the live Thought row
//   event: event      data: {"kind":"..."}      → a durable event landed: poll
//                                                 now, drop the draft
//                                                 (transcript wins)
//
// Reasoning is a SEPARATE frame type on purpose: mixing chain-of-thought into
// the answer draft would render it as if it were the agent's reply.
//
// Deltas are display-only; the 3s poll remains the durable source of truth,
// so a dropped stream degrades to exactly the pre-SSE behavior.

export interface SseFrame {
  event: "delta" | "reasoning" | "event";
  data: string;
}

/** Map one raw upstream websocket frame to an SSE frame, or null to drop it. */
export function mapWsFrame(raw: string): SseFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as { kind?: unknown; content?: unknown; reasoning_content?: unknown };
  const kind = typeof frame.kind === "string" ? frame.kind : "";
  if (!kind) return null;
  if (kind === "StreamingDeltaEvent") {
    const content = typeof frame.content === "string" ? frame.content : "";
    if (content) return { event: "delta", data: JSON.stringify({ content }) };
    // Reasoning-only delta: forwarded on its own channel so the client can
    // show live thinking without polluting the answer draft.
    const reasoning = typeof frame.reasoning_content === "string" ? frame.reasoning_content : "";
    if (reasoning) return { event: "reasoning", data: JSON.stringify({ content: reasoning }) };
    return null;
  }
  // Durable event: a lightweight ping is enough — the client refreshes via
  // the poll rather than trusting a second (unvalidated) event pipeline.
  return { event: "event", data: JSON.stringify({ kind }) };
}

/** Serialize an SSE frame to the wire format. */
export function sseSerialize(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${frame.data}\n\n`;
}

/** First websocket frame: agent-server first-message auth (undici WebSocket
 * cannot send custom headers, and query-param auth is deprecated upstream). */
export function wsAuthFrame(sessionApiKey: string): string {
  return JSON.stringify({ type: "auth", session_api_key: sessionApiKey });
}

/** ws(s) URL for a conversation's event socket, derived from the http base. */
export function wsEventsUrl(internalUrl: string, conversationId: string): string {
  return `${internalUrl.replace(/^http/, "ws")}/sockets/events/${conversationId}`;
}
