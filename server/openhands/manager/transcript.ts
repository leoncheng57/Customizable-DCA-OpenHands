/**
 * Renders a worker's raw agent-server events into a plain-text view for the
 * `inspect_worker` manager command.
 *
 * Tolerant parsing mirrors client/lib/events.ts (MessageEvent,
 * ActionEvent, ObservationEvent, AgentErrorEvent, ConversationErrorEvent);
 * unknown kinds are hidden rather than thrown on, since this reads the same
 * agent-server event stream the Canvas transcript does. This module does NOT
 * import from the client app — it keeps its own minimal normalizer so the
 * manager feature has no dependency on client code.
 *
 * `redactSecrets` is applied to the fully assembled text as the last step, so
 * a credential split across a per-entry truncation boundary is still masked
 * before any cut can leave a partial marker behind.
 */

import { redactSecrets, stripPartialRedaction } from "../../redact-secrets.js";
import type { ConversationEvent } from "./agent-client.js";
import type { InspectMode } from "./types.js";

type EntryKind = "user" | "agent" | "tool" | "observation" | "error";

interface NormalizedEntry {
  id: string;
  kind: EntryKind;
  label: string;
  text: string;
  timestamp: string;
  isError: boolean;
  actionId?: string;
  toolCallId?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c) =>
        c && typeof c === "object" && (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

/** Normalize one raw event; returns null for kinds the transcript hides. */
function normalizeEntry(e: ConversationEvent, fallbackIndex: number): NormalizedEntry | null {
  const id = String(e.id ?? `event-${fallbackIndex}`);
  const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";
  const actionId = typeof e.action_id === "string" ? e.action_id : undefined;
  const toolCallId = typeof e.tool_call_id === "string" ? e.tool_call_id : undefined;
  const base = { id, timestamp, actionId, toolCallId };

  switch (e.kind) {
    case "MessageEvent": {
      const msg = e.llm_message as { role?: string; content?: unknown } | undefined;
      const text = textOf(msg?.content);
      const isUser = (msg?.role ?? e.source) === "user" || e.source === "user";
      return {
        ...base,
        kind: isUser ? "user" : "agent",
        label: isUser ? "You" : "Agent",
        text,
        isError: false,
      };
    }
    case "ActionEvent": {
      const action = (e.action ?? {}) as Record<string, unknown> & {
        kind?: string;
        command?: string;
        name?: string;
        message?: string;
      };
      if (action.kind === "FinishAction" && typeof action.message === "string") {
        return { ...base, kind: "agent", label: "Agent — finished", text: action.message, isError: false };
      }
      if (action.kind === "InvokeSkillAction" && typeof action.name === "string") {
        return { ...base, kind: "tool", label: "Skill", text: action.name, isError: false };
      }
      const detail = typeof action.command === "string" ? action.command : JSON.stringify(action);
      const toolName = typeof e.tool_name === "string" ? e.tool_name : String(action.kind ?? "tool");
      return { ...base, kind: "tool", label: toolName, text: detail, isError: false };
    }
    case "ObservationEvent": {
      const observation = (e.observation ?? {}) as Record<string, unknown> & {
        content?: unknown;
        is_error?: boolean;
      };
      const text = textOf(observation.content);
      return {
        ...base,
        kind: "observation",
        label: "Output",
        text,
        isError: observation.is_error === true,
      };
    }
    case "ConversationErrorEvent":
    case "AgentErrorEvent": {
      const code = typeof e.code === "string" ? e.code : "Error";
      const detail = typeof e.detail === "string" ? e.detail : "";
      return { ...base, kind: "error", label: code, text: detail, isError: true };
    }
    default:
      return null; // SystemPromptEvent, ConversationStateUpdateEvent, etc. — hidden
  }
}

/** Normalize a newest-first raw event page, dropping hidden kinds. */
function normalizeEntries(events: ConversationEvent[]): NormalizedEntry[] {
  const out: NormalizedEntry[] = [];
  events.forEach((e, i) => {
    const n = normalizeEntry(e, i);
    if (n) out.push(n);
  });
  return out;
}

const ENTRY_TRUNCATE_CHARS = 400;
const TOTAL_CHAR_CAP = 6000;
const RECENT_ENTRY_COUNT = 15;

function truncate(text: string, max: number): string {
  // Reserve one char for the ellipsis so the result never exceeds `max`.
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatEntry(e: NormalizedEntry): string {
  const ts = e.timestamp ? `[${e.timestamp}] ` : "";
  const tag = e.isError ? " ERROR" : "";
  const text = truncate(e.text.trim().length > 0 ? e.text : "(empty)", ENTRY_TRUNCATE_CHARS);
  return `${ts}${e.label}${tag}:\n${text}`;
}

/** Map observations by the action_id/tool_call_id that correlates them to a call. */
function observationsByCorrelationId(entries: NormalizedEntry[]): Map<string, NormalizedEntry> {
  const map = new Map<string, NormalizedEntry>();
  for (const e of entries) {
    if (e.kind !== "observation") continue;
    if (e.actionId) map.set(`action:${e.actionId}`, e);
    if (e.toolCallId) map.set(`tool:${e.toolCallId}`, e);
  }
  return map;
}

function findOutputFor(tool: NormalizedEntry, map: Map<string, NormalizedEntry>): NormalizedEntry | null {
  return (
    map.get(`action:${tool.id}`) ??
    (tool.toolCallId ? map.get(`tool:${tool.toolCallId}`) : undefined) ??
    null
  );
}

function toolsByCorrelationId(entries: NormalizedEntry[]): {
  byId: Map<string, NormalizedEntry>;
  byToolCallId: Map<string, NormalizedEntry>;
} {
  const byId = new Map<string, NormalizedEntry>();
  const byToolCallId = new Map<string, NormalizedEntry>();
  for (const e of entries) {
    if (e.kind !== "tool") continue;
    byId.set(e.id, e);
    if (e.toolCallId) byToolCallId.set(e.toolCallId, e);
  }
  return { byId, byToolCallId };
}

function findToolFor(
  obs: NormalizedEntry,
  maps: { byId: Map<string, NormalizedEntry>; byToolCallId: Map<string, NormalizedEntry> },
): NormalizedEntry | null {
  if (obs.actionId && maps.byId.has(obs.actionId)) return maps.byId.get(obs.actionId)!;
  if (obs.toolCallId && maps.byToolCallId.has(obs.toolCallId)) return maps.byToolCallId.get(obs.toolCallId)!;
  return null;
}

function formatToolPair(tool: NormalizedEntry, output: NormalizedEntry | null): string {
  const toolPart = formatEntry(tool);
  const outputPart = output ? formatEntry(output) : "(no output yet)";
  return `${toolPart}\n\n${outputPart}`;
}

function renderRecent(entries: NormalizedEntry[]): string {
  if (entries.length === 0) return "No transcript entries available yet.";
  // `entries` is newest-first; show the tail oldest-first, like a chat log.
  const recent = entries.slice(0, RECENT_ENTRY_COUNT).slice().reverse();
  return recent.map(formatEntry).join("\n\n");
}

function renderLastMessage(entries: NormalizedEntry[]): string {
  const found = entries.find((e) => e.kind === "agent" && e.text.trim().length > 0);
  return found ? formatEntry(found) : "No agent message found in recent history.";
}

function renderLastError(entries: NormalizedEntry[]): string {
  const found = entries.find((e) => e.isError);
  if (!found) return "No error found in recent history.";
  if (found.kind === "observation") {
    const tool = findToolFor(found, toolsByCorrelationId(entries));
    return tool ? formatToolPair(tool, found) : formatEntry(found);
  }
  return formatEntry(found);
}

function renderLastTool(entries: NormalizedEntry[]): string {
  const found = entries.find((e) => e.kind === "tool");
  if (!found) return "No tool call found in recent history.";
  const output = findOutputFor(found, observationsByCorrelationId(entries));
  return formatToolPair(found, output);
}

/**
 * Render a newest-first page of raw agent-server events into a text view for
 * the given inspect mode. Always redacts secrets before returning.
 */
export function renderTranscript(events: ConversationEvent[], mode: InspectMode = "recent"): string {
  const entries = normalizeEntries(events);
  let body: string;
  switch (mode) {
    case "last-message":
      body = renderLastMessage(entries);
      break;
    case "last-error":
      body = renderLastError(entries);
      break;
    case "last-tool":
      body = renderLastTool(entries);
      break;
    case "recent":
    default:
      body = renderRecent(entries);
      break;
  }
  const redacted = redactSecrets(body);
  const capped = truncate(redacted, TOTAL_CHAR_CAP);
  return stripPartialRedaction(capped);
}
