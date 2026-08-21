// client/mock/fixtures/events.ts
//
// Builders for the raw agent-server events the demo's transcripts are made of.
//
// There is exactly one reason this module exists: the fields that make a
// transcript render well are easy to get subtly wrong, and getting them wrong
// is invisible until a chip has no output or a Thought row is empty. Pinning
// them here means the scripted run (../timeline.ts), the seeded conversations
// (./seeds.ts) and anything appended at runtime all produce the same shapes.
//
// The shapes mirror agent-server 1.40.x, which is also what
// tests/transcript-details.test.ts was captured from:
//
//  · `summary`, `reasoning_content`, `thinking_blocks`,
//    `responses_reasoning_item`, `security_risk`, `llm_response_id` and
//    `tool_call` live at the TOP LEVEL of an ActionEvent, not on `action`.
//  · An ObservationEvent correlates back through `action_id` (and
//    `tool_call_id`); groupEvents() in client/lib/events.ts pairs on those, not
//    on adjacency, so a mismatch silently leaves a tool chip "still running".
//  · `thought` rides on the FIRST action of an LLM response only — the others
//    in the batch share its `llm_response_id`.
import type { RawOpenHandsEvent, TaskItem } from "../../lib/events.js";

/** Readable model reasoning, in whichever field the provider populates. */
export type Reasoning =
  | { provider: "openai"; summary: string[] }
  | { provider: "anthropic"; thinking: string }
  /**
   * The provider exposed only an encrypted payload. extractReasoning() must
   * never render it — the transcript marks the chip `opaque` instead of
   * emitting an empty Thought row. Reproduced here because it is the common
   * case on real OpenAI- and Anthropic-backed runs, so a demo without it would
   * make transcripts look tidier than they are.
   */
  | { provider: "encrypted" };

function reasoningFields(r: Reasoning | undefined): Partial<RawOpenHandsEvent> {
  if (!r) return {};
  if (r.provider === "openai") {
    return { responses_reasoning_item: { id: "rs_demo", summary: r.summary } };
  }
  if (r.provider === "anthropic") {
    return { thinking_blocks: [{ type: "thinking", thinking: r.thinking }] };
  }
  return { responses_reasoning_item: { id: "rs_demo", summary: [], encrypted_content: "OPAQUE" } };
}

export interface ActionSpec {
  id: string;
  timestamp: string;
  /** Tool id as agent-server reports it: terminal / file_editor / … */
  tool: string;
  /** Validated action payload — `kind` plus the tool's own arguments. */
  action: Record<string, unknown>;
  /** Human description of the call; the chip shows it instead of raw args. */
  summary?: string;
  /** Agent narration. Only the first action of an LLM response carries it. */
  thought?: string;
  reasoning?: Reasoning;
  /** Defaults to LOW — the read-only score plan mode lets through. */
  risk?: "LOW" | "MEDIUM" | "HIGH";
  /** Actions from one LLM response share this, so reasoning renders once. */
  response: string;
}

export function actionEvent(spec: ActionSpec): RawOpenHandsEvent {
  return {
    id: spec.id,
    kind: "ActionEvent",
    source: "agent",
    timestamp: spec.timestamp,
    tool_name: spec.tool,
    thought: spec.thought ? [{ type: "text", text: spec.thought }] : [],
    action: spec.action,
    security_risk: spec.risk ?? "LOW",
    llm_response_id: spec.response,
    tool_call: { id: `call_${spec.id}`, name: spec.tool, arguments: JSON.stringify(spec.action) },
    ...(spec.summary ? { summary: spec.summary } : {}),
    ...reasoningFields(spec.reasoning),
  };
}

export interface ObservationSpec {
  id: string;
  timestamp: string;
  /** Id of the ActionEvent this is the output of. */
  of: string;
  tool: string;
  /** Observation kind, e.g. TerminalObservation / FileEditorObservation. */
  kind: string;
  text: string;
  isError?: boolean;
  /** Present on TaskTrackerObservation — feeds the pinned task list. */
  taskList?: TaskItem[];
}

export function observationEvent(spec: ObservationSpec): RawOpenHandsEvent {
  return {
    id: spec.id,
    kind: "ObservationEvent",
    source: "environment",
    timestamp: spec.timestamp,
    action_id: spec.of,
    tool_call_id: `call_${spec.of}`,
    tool_name: spec.tool,
    observation: {
      kind: spec.kind,
      content: [{ type: "text", text: spec.text }],
      is_error: spec.isError === true,
      ...(spec.taskList ? { task_list: spec.taskList } : {}),
    },
  };
}

export interface MessageSpec {
  id: string;
  timestamp: string;
  role: "user" | "assistant";
  text: string;
  /** Skill names activated by the message — rendered as badges. */
  skills?: string[];
  /**
   * Attached images as `data:` URLs. Only data URLs render (imagesOf() in
   * client/lib/events.ts filters everything else), which is also all the real
   * BFF ever forwards.
   */
  images?: string[];
}

export function messageEvent(spec: MessageSpec): RawOpenHandsEvent {
  const content: Array<{ type?: string; text?: string; image_urls?: string[] }> = [];
  if (spec.text) content.push({ type: "text", text: spec.text });
  if (spec.images?.length) content.push({ type: "image", image_urls: spec.images });
  return {
    id: spec.id,
    kind: "MessageEvent",
    source: spec.role === "user" ? "user" : "agent",
    timestamp: spec.timestamp,
    llm_message: { role: spec.role, content },
    ...(spec.skills?.length ? { activated_skills: spec.skills } : {}),
  };
}

/**
 * An `execution_status` transition. The transcript renders these as full-width
 * separators, and ../timeline.ts derives the conversation's reported status
 * from them — one source of truth for the pill and the separator.
 */
export function statusEvent(id: string, timestamp: string, value: string): RawOpenHandsEvent {
  return {
    id,
    kind: "ConversationStateUpdateEvent",
    source: "environment",
    timestamp,
    key: "execution_status",
    value,
  };
}

/**
 * An agent-side failure. `detail` is the body; `code` becomes the row label
 * and is deliberately optional — normalizeEvent() falls back to "Error", which
 * is safer than guessing at an upstream error-code vocabulary.
 */
export function errorEvent(spec: {
  id: string;
  timestamp: string;
  code?: string;
  detail: string;
}): RawOpenHandsEvent {
  return {
    id: spec.id,
    kind: "AgentErrorEvent",
    source: "agent",
    timestamp: spec.timestamp,
    detail: spec.detail,
    ...(spec.code ? { code: spec.code } : {}),
  };
}
