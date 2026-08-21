// client/lib/events.ts
//
// Normalizes raw agent-server events (as returned by the BFF's
// /conversations/:id/events pass-through) into the small shape the
// transcript renders. Tolerant by design: unknown kinds degrade to a
// generic status row rather than throwing.

/** One entry in the agent's task-tracker plan (agent-server `TaskItem`). */
export interface TaskItem {
  title: string;
  notes?: string;
  status?: "todo" | "in_progress" | "done";
}

/** Risk classification the LLM security analyzer attaches to every action. */
export type SecurityRisk = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH";

/**
 * One entry of `ActionEvent.thinking_blocks` (Anthropic extended thinking).
 * `thinking` is readable prose; `signature`/`data` are opaque provider blobs
 * that must never reach the DOM.
 */
export interface ThinkingBlock {
  type?: string;
  thinking?: string;
  signature?: string;
  data?: string;
}

/**
 * `ActionEvent.responses_reasoning_item` (OpenAI Responses API). Only the
 * plaintext `summary`/`content` arrays are renderable; `encrypted_content`
 * is an opaque blob.
 */
export interface ResponsesReasoningItem {
  id?: string;
  summary?: string[];
  content?: string[];
  encrypted_content?: string;
}

export interface RawOpenHandsEvent {
  id?: string;
  kind?: string;
  source?: string;
  timestamp?: string;
  llm_message?: { role?: string; content?: Array<{ type?: string; text?: string; image_urls?: string[] }> };
  /** Skill names activated by this message (MessageEvent). */
  activated_skills?: string[];
  tool_name?: string;
  /** Agent prose accompanying an ActionEvent (only the first action of a batch carries it). */
  thought?: Array<{ type?: string; text?: string }>;
  /**
   * Human-readable description of the tool call. Lives at the TOP level of
   * ActionEvent (not on `action`) — the SDK's `_extract_summary()` always
   * fills it, either from the model or with a generated `<tool>: <args-json>`
   * fallback that `cleanSummary()` rejects.
   */
  summary?: string;
  /** Provider-normalized reasoning text (readable). */
  reasoning_content?: string;
  /** Anthropic extended-thinking blocks (readable and/or redacted). */
  thinking_blocks?: ThinkingBlock[];
  /** OpenAI Responses reasoning item (plaintext summary/content and/or encrypted). */
  responses_reasoning_item?: ResponsesReasoningItem;
  /** Risk classification used by Plan mode to gate writes. */
  security_risk?: string;
  /** Identifies the LLM response a batch of parallel actions came from. */
  llm_response_id?: string;
  /** Raw provider tool call; `arguments` is a JSON string of normalized args. */
  tool_call?: { id?: string; name?: string; arguments?: string };
  action?: Record<string, unknown> & {
    kind?: string;
    command?: string;
    task_list?: TaskItem[];
    name?: string;
    /** Legacy/nested summary — kept for tolerance, superseded by the top-level field. */
    summary?: string;
  };
  observation?: Record<string, unknown> & {
    kind?: string;
    content?: Array<{ type?: string; text?: string }>;
    is_error?: boolean;
    task_list?: TaskItem[];
  };
  key?: string;
  value?: unknown;
  code?: string;
  detail?: string;
  action_id?: string;
  tool_call_id?: string;
}

export type TranscriptKind = "user" | "agent" | "tool" | "observation" | "status" | "error" | "reasoning";

export interface TranscriptEvent {
  id: string;
  kind: TranscriptKind;
  /** Short row label (e.g. tool name, status key). */
  label: string;
  /** Main body text (may be empty for pure status rows). */
  text: string;
  timestamp: string;
  isError?: boolean;
  /** True for the FinishAction row carrying the agent's final summary. */
  isFinal?: boolean;
  /** Correlation fields emitted by agent-server for action/observation pairs. */
  actionId?: string;
  toolCallId?: string;
  /** Skills activated by this message (rendered as badges). */
  skills?: string[];
  /** Attached images (data: URLs) — rendered as thumbnails on user bubbles. */
  images?: string[];
  /** Task list carried by task-tracker actions/observations (rendered as a checklist). */
  tasks?: TaskItem[];
  /** Human-readable description of a tool call — shown instead of raw args when collapsed. */
  summary?: string;
  /** Risk classification — rendered as a badge on MEDIUM/HIGH actions. */
  risk?: SecurityRisk;
  /**
   * The model reasoned before this action, but the provider only exposed an
   * encrypted/redacted payload — there is no readable text to show. Rendered
   * as a subtle marker on the tool chip rather than an empty Thought row.
   */
  opaque?: boolean;
}

function textOf(content?: Array<{ type?: string; text?: string }>): string {
  return (content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// Only data: image URLs render — a transcript must never trigger a fetch of
// an attacker-controlled remote URL, and the BFF only ever forwards data URLs.
const IMAGE_DATA_URL_RE = /^data:image\/[a-z+.-]+;base64,/;

function imagesOf(content?: Array<{ type?: string; image_urls?: string[] }>): string[] {
  return (content ?? [])
    .filter((c) => c.type === "image" && Array.isArray(c.image_urls))
    .flatMap((c) => c.image_urls!)
    .filter((u) => typeof u === "string" && IMAGE_DATA_URL_RE.test(u));
}

const MAX_OBSERVATION_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 200;
const MAX_REASONING_CHARS = 8_000;
const MAX_DETAIL_VALUE_CHARS = 80;
const MAX_DETAIL_FIELDS = 4;

/**
 * Argument keys that carry whole file bodies or patches. They are never worth
 * a chip and would dump hundreds of lines (or secrets) into the transcript,
 * so the compact detail line always skips them.
 */
const BULKY_ARG_KEYS = new Set([
  "file_text",
  "old_str",
  "new_str",
  "content",
  "file_content",
  "text",
  "patch",
  "diff",
  "translated_text",
]);

/** Keys that never add information to a detail line. */
const NOISE_ARG_KEYS = new Set(["kind", "command", "security_risk", "summary"]);

/**
 * The human-readable tool summary, or undefined when OpenHands only had its
 * generated fallback.
 *
 * The SDK's `_extract_summary()` always populates `ActionEvent.summary`: with
 * the model's own description when the tool defines one, otherwise with
 * `"<tool_name>: <full arguments JSON>"`. That fallback inlines `old_str` /
 * `new_str` / `file_text`, so rendering it verbatim would paste entire patches
 * into the chip. Reject it and let the caller fall back to the compact detail.
 */
export function cleanSummary(e: RawOpenHandsEvent): string | undefined {
  const raw = typeof e.summary === "string" && e.summary.trim()
    ? e.summary
    : typeof e.action?.summary === "string"
      ? e.action.summary
      : "";
  const summary = raw.trim();
  if (!summary) return undefined;
  const fallbackPrefix = e.tool_name ? `${e.tool_name}: ` : null;
  if (fallbackPrefix && summary.startsWith(fallbackPrefix)) {
    const rest = summary.slice(fallbackPrefix.length).trimStart();
    if (rest.startsWith("{") || rest.startsWith("[")) return undefined;
  }
  // Real summaries are a single prose line; anything multi-line is a dump.
  if (summary.includes("\n")) return undefined;
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary;
}

/** Readable reasoning for one action, plus whether opaque metadata existed. */
export interface Reasoning {
  /** Renderable reasoning prose; empty when only opaque metadata was present. */
  text: string;
  /** True when the provider only exposed encrypted/redacted reasoning. */
  opaque: boolean;
}

/**
 * Collect the renderable reasoning attached to an ActionEvent.
 *
 * Providers populate different fields for the same thought, so all readable
 * representations are merged and deduplicated (whitespace-insensitive).
 * Opaque payloads — Anthropic `redacted_thinking.data`, OpenAI
 * `encrypted_content` — are only ever counted, never read: they flip `opaque`
 * so the UI can show a bare "Thought" marker. Anthropic `signature` is
 * ignored entirely.
 */
export function extractReasoning(e: RawOpenHandsEvent): Reasoning | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const text = value.trim();
    if (!text) return;
    const key = text.replace(/\s+/g, " ");
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };
  let opaque = false;
  add(e.reasoning_content);
  for (const block of e.thinking_blocks ?? []) {
    if (!block) continue;
    if (block.type === "redacted_thinking" || typeof block.data === "string") {
      opaque = true;
      continue;
    }
    add(block.thinking);
  }
  const item = e.responses_reasoning_item;
  if (item) {
    for (const s of item.summary ?? []) add(s);
    for (const c of item.content ?? []) add(c);
    if (typeof item.encrypted_content === "string" && item.encrypted_content) opaque = true;
  }
  const text = parts.join("\n\n");
  if (!text) return opaque ? { text: "", opaque: true } : null;
  return {
    text: text.length > MAX_REASONING_CHARS ? `${text.slice(0, MAX_REASONING_CHARS)}…` : text,
    opaque: false,
  };
}

/** `key=value` for a primitive argument, or null when it isn't renderable. */
function primitiveDetail(key: string, value: unknown): string | null {
  if (BULKY_ARG_KEYS.has(key) || NOISE_ARG_KEYS.has(key)) return null;
  if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`;
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) return null;
    return `${key}=${v.length > MAX_DETAIL_VALUE_CHARS ? `${v.slice(0, MAX_DETAIL_VALUE_CHARS)}…` : v}`;
  }
  // Short numeric/string tuples (view_range: [1, 50]) are useful selectors.
  if (Array.isArray(value) && value.length > 0
    && value.every((v) => typeof v === "number" || typeof v === "string")) {
    const joined = value.join(",");
    return joined.length > MAX_DETAIL_VALUE_CHARS ? null : `${key}=${joined}`;
  }
  return null;
}

/** Bounded `[k=v k=v]` list of an argument record's primitive fields. */
function bracketDetails(record: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const pair = primitiveDetail(key, value);
    if (!pair) continue;
    pairs.push(pair);
    if (pairs.length >= MAX_DETAIL_FIELDS) break;
  }
  return pairs.length > 0 ? `[${pairs.join(" ")}]` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compact, bounded description of what a tool call actually does — the
 * opencode-style detail line (`create /srv/app.ts [view_range=1,50]`).
 *
 * Derived from the validated `action` payload rather than the raw
 * `tool_call.arguments` JSON string, which also carries SDK metadata and
 * unbounded values. Safe to render while a write is still awaiting
 * confirmation: file bodies and patches are excluded by `BULKY_ARG_KEYS`.
 */
export function toolDetails(e: RawOpenHandsEvent): string {
  const action = e.action ?? {};
  const kind = typeof action.kind === "string" ? action.kind : "";
  const command = typeof action.command === "string" ? action.command : "";

  // File editor: the command alone ("create") is useless without its target.
  if (kind === "FileEditorAction" || typeof action.path === "string") {
    const path = typeof action.path === "string" ? action.path : "";
    const extras = bracketDetails(
      Object.fromEntries(Object.entries(action).filter(([k]) => k !== "path")),
    );
    const line = [command || "edit", path, extras].filter(Boolean).join(" ");
    if (line.trim()) return line;
  }
  // Terminal commands stay verbatim: they are the single most useful detail
  // and the commands sidebar renders this same string.
  if (command && !isRecord(action.data)) return command;
  // MCP tools carry their arguments in `action.data`.
  if (isRecord(action.data)) {
    const line = [command, bracketDetails(action.data)].filter(Boolean).join(" ");
    if (line.trim()) return line;
  }
  const generic = bracketDetails(action);
  if (generic) return command ? `${command} ${generic}` : generic;
  return command || JSON.stringify(action);
}

/** Normalize a raw `security_risk` string, ignoring UNKNOWN (the default). */
function riskOf(e: RawOpenHandsEvent): SecurityRisk | undefined {
  const risk = e.security_risk;
  return risk === "LOW" || risk === "MEDIUM" || risk === "HIGH" ? risk : undefined;
}

/** Normalize one raw event; returns null for events the transcript hides. */
export function normalizeEvent(e: RawOpenHandsEvent, fallbackIndex = 0): TranscriptEvent | null {
  const base = {
    id: String(e.id ?? `event-${fallbackIndex}`),
    timestamp: e.timestamp ?? "",
    actionId: e.action_id,
    toolCallId: e.tool_call_id,
  };
  switch (e.kind) {
    case "SystemPromptEvent":
      return null; // internal plumbing — hidden like the Canvas UI hides it
    case "MessageEvent": {
      const text = textOf(e.llm_message?.content);
      const images = imagesOf(e.llm_message?.content);
      const isUser = (e.llm_message?.role ?? e.source) === "user" || e.source === "user";
      const skills = (e.activated_skills ?? []).filter((s) => typeof s === "string" && s.length > 0);
      return {
        ...base,
        kind: isUser ? "user" : "agent",
        label: isUser ? "You" : "Agent",
        text,
        ...(skills.length > 0 ? { skills } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
    }
    case "ActionEvent": {
      const action = e.action ?? {};
      // FinishAction carries the agent's final summary — render it as agent
      // prose, not as a raw tool-JSON row.
      if (action.kind === "FinishAction" && typeof action.message === "string") {
        return { ...base, kind: "agent", label: "Agent — finished", text: action.message, isFinal: true };
      }
      // Task-tracker calls carry the structured plan that feeds the pinned
      // task list above the transcript (and the chip's expanded snapshot).
      // The plan is on the action; `view` calls carry it on the observation.
      if (action.kind === "TaskTrackerAction") {
        const tasks = Array.isArray(action.task_list) ? action.task_list : undefined;
        return { ...base, kind: "tool", label: "Task list", text: String(action.command ?? "view"), tasks };
      }
      // Skill invocations show the skill name instead of the args JSON.
      if (action.kind === "InvokeSkillAction" && typeof action.name === "string") {
        return { ...base, kind: "tool", label: "Skill", text: action.name };
      }
      const summary = cleanSummary(e);
      const risk = riskOf(e);
      return {
        ...base,
        kind: "tool",
        label: e.tool_name ?? String(action.kind ?? "tool"),
        text: toolDetails(e),
        ...(summary ? { summary } : {}),
        ...(risk ? { risk } : {}),
      };
    }
    case "ObservationEvent": {
      const text = textOf(e.observation?.content);
      const tasks = e.observation?.kind === "TaskTrackerObservation" && Array.isArray(e.observation.task_list)
        ? e.observation.task_list
        : undefined;
      return {
        ...base,
        kind: "observation",
        label: "Output",
        text: text.length > MAX_OBSERVATION_CHARS ? `${text.slice(0, MAX_OBSERVATION_CHARS)}…` : text,
        isError: e.observation?.is_error === true,
        ...(tasks ? { tasks } : {}),
      };
    }
    case "ConversationStateUpdateEvent": {
      if (e.key !== "execution_status") return null; // agent_status etc. are noise
      return { ...base, kind: "status", label: "Status", text: String(e.value ?? "") };
    }
    case "ConversationErrorEvent":
    case "AgentErrorEvent":
      return { ...base, kind: "error", label: e.code ?? "Error", text: e.detail ?? "", isError: true };
    default:
      return null;
  }
}

export function normalizeEvents(items: RawOpenHandsEvent[]): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  // A single LLM response can emit several parallel actions, but its reasoning
  // belongs to the response as a whole — attach it once, to the first action.
  const reasoned = new Set<string>();
  for (const [index, item] of items.entries()) {
    const n = normalizeEvent(item, index);
    if (!n) continue;
    if (item.kind === "ActionEvent" && (n.kind === "tool" || n.isFinal)) {
      // Model reasoning (Anthropic thinking / OpenAI reasoning items) precedes
      // the narration it produced.
      const responseKey = item.llm_response_id ?? "";
      if (!responseKey || !reasoned.has(responseKey)) {
        const reasoning = extractReasoning(item);
        if (reasoning) {
          if (responseKey) reasoned.add(responseKey);
          if (reasoning.text) {
            out.push({
              id: `${n.id}-reasoning`,
              kind: "reasoning",
              label: "Thought",
              text: reasoning.text,
              timestamp: n.timestamp,
            });
          } else {
            // Encrypted/redacted-only reasoning carries no readable text, and
            // providers attach it to virtually every action — a row per action
            // would be 50 empty "Thought" lines that also break up the
            // "N actions completed" grouping. Mark the action instead.
            n.opaque = true;
          }
        }
      }
    }
    // The agent's narration between tool calls arrives as `thought` on the
    // first ActionEvent of a batch (the Canvas renders it as agent prose).
    // Emit it as its own agent row so tool chips don't swallow it — except on
    // FinishAction, whose message is already rendered as prose.
    if (item.kind === "ActionEvent" && n.kind === "tool") {
      const thought = textOf(item.thought);
      if (thought.trim()) {
        out.push({ id: `${n.id}-thought`, kind: "agent", label: "Agent", text: thought, timestamp: n.timestamp });
      }
    }
    out.push(n);
  }
  return out;
}

// ── Accumulating raw events across polls / pages ─────────────────────────────
// The transcript is bottom-anchored: the poll fetches the newest window and
// "Load older events" pages walk backwards. The newest-N window slides forward
// as the agent works, so naive segment concatenation can develop gaps between
// a previously loaded window and the current one. The log is append-only and
// event ids are stable, so accumulating everything ever seen — deduped by id,
// ordered chronologically — yields a gap-free transcript.

function rawEventKey(e: RawOpenHandsEvent): string {
  return String(e.id ?? `${e.timestamp ?? ""}|${e.kind ?? ""}`);
}

/** Merge incoming raw events (any order) into a chronologically sorted, deduped list. */
export function mergeRawEvents(
  prev: RawOpenHandsEvent[],
  incoming: RawOpenHandsEvent[],
): RawOpenHandsEvent[] {
  if (incoming.length === 0) return prev;
  const byId = new Map<string, RawOpenHandsEvent>();
  for (const e of prev) byId.set(rawEventKey(e), e);
  let changed = false;
  for (const e of incoming) {
    const key = rawEventKey(e);
    if (!byId.has(key)) changed = true;
    byId.set(key, e);
  }
  if (!changed) return prev;
  // ISO timestamps compare lexicographically; the id tiebreak only matters for
  // (microsecond-)identical timestamps and merely needs to be deterministic.
  return [...byId.values()].sort(
    (a, b) =>
      (a.timestamp ?? "").localeCompare(b.timestamp ?? "") ||
      rawEventKey(a).localeCompare(rawEventKey(b)),
  );
}

// ── Grouping for the chat-style transcript ──────────────────────────────────
// The Deployment Tracker chat style renders tool calls as compact chips with
// their output attached, rather than as two separate rows. agent-server emits
// action_id/tool_call_id explicitly, so correlate by those IDs instead of
// assuming observations are adjacent (parallel tools may interleave events).

export type TranscriptItem =
  | { type: "event"; event: TranscriptEvent }
  | { type: "toolCall"; tool: TranscriptEvent; output: TranscriptEvent | null };

export function groupEvents(events: TranscriptEvent[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const observations = new Map<string, TranscriptEvent>();
  for (const event of events) {
    if (event.kind !== "observation") continue;
    if (event.actionId) observations.set(`action:${event.actionId}`, event);
    if (event.toolCallId) observations.set(`tool:${event.toolCallId}`, event);
  }
  const consumed = new Set<string>();

  for (const e of events) {
    if (e.kind === "tool") {
      const output = observations.get(`action:${e.id}`)
        ?? (e.toolCallId ? observations.get(`tool:${e.toolCallId}`) : undefined)
        ?? null;
      if (output) consumed.add(output.id);
      out.push({ type: "toolCall", tool: e, output });
      continue;
    }
    // An observation without a preceding tool (e.g. after a hidden event)
    // still renders — as an unpaired tool-call output.
    if (e.kind === "observation") {
      if (consumed.has(e.id)) continue;
      out.push({ type: "toolCall", tool: { ...e, kind: "tool", label: "output", text: "" }, output: e });
      continue;
    }
    out.push({ type: "event", event: e });
  }
  return out;
}

// ── Live-activity summary for the running indicator ──────────────────────────
// What is the agent doing *right now*? Polling only ever shows persisted
// events, so the best available signals are (a) the last tool call that has
// no observation yet — the tool is still executing — and (b) the age of the
// newest event when nothing is pending, i.e. the LLM is generating (or a
// silent stall: rate-limit backoff, MCP init; see issue #48).

export type RunningActivity =
  | { kind: "tool"; label: string; text: string; since: string | null }
  | { kind: "thinking"; since: string | null };

export function runningActivity(items: TranscriptItem[]): RunningActivity {
  let latest: string | null = null;
  for (const item of items) {
    const ts = item.type === "toolCall" ? item.output?.timestamp || item.tool.timestamp : item.event.timestamp;
    if (ts && (!latest || ts > latest)) latest = ts;
  }
  // Scan from the end past status separators: a pending tool call is only
  // "the current activity" when nothing substantive happened after it —
  // an unpaired call deeper in history is stale, not running.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "event" && item.event.kind === "status") continue;
    if (item.type === "toolCall" && !item.output) {
      return { kind: "tool", label: item.tool.label, text: item.tool.text, since: item.tool.timestamp || null };
    }
    break;
  }
  return { kind: "thinking", since: latest };
}

// ── Collapsing runs of completed actions ─────────────────────────────────────
// The Canvas folds consecutive completed tool calls into one "N actions
// completed" row so long transcripts read as narration instead of a wall of
// chips. Mirror that on top of groupEvents: only *finished, successful* calls
// collapse — errors, still-running calls, and structured cards (task lists)
// stay visible so nothing important hides behind a chevron.

export type ToolCallItem = Extract<TranscriptItem, { type: "toolCall" }>;

export type DisplayItem =
  | TranscriptItem
  | { type: "actionGroup"; id: string; calls: ToolCallItem[] };

function isCollapsible(item: ToolCallItem): boolean {
  if (!item.output) return false; // still running / awaiting confirmation
  if (item.output.isError) return false;
  if (item.tool.tasks || item.output.tasks) return false; // task-list card
  return true;
}

export function collapseActionGroups(items: TranscriptItem[], minGroupSize = 2): DisplayItem[] {
  const out: DisplayItem[] = [];
  let run: ToolCallItem[] = [];
  const flush = (): void => {
    if (run.length >= minGroupSize) {
      // Keyed by the first call, which never changes as the run grows across
      // polls — keeps the user's expand/collapse choice stable.
      out.push({ type: "actionGroup", id: `group-${run[0].tool.id}`, calls: run });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    if (item.type === "toolCall" && isCollapsible(item)) {
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

// ── Command extraction for the commands sidebar ──────────────────────────────
// The sidebar shows a flat audit trail of what the agent *did* — shell
// commands, file edits, and other tool calls — derived from the same grouped
// transcript items the chat renders, so both views always agree.

export type CommandCategory = "command" | "edit" | "other";

export interface CommandEntry {
  /** Id of the tool TranscriptEvent — used to jump to the transcript row. */
  id: string;
  category: CommandCategory;
  /** Tool label (e.g. "terminal", "str_replace_editor"). */
  label: string;
  /** The command string / tool arguments. */
  text: string;
  timestamp: string;
  /** pending = no output yet (still running or awaiting confirmation). */
  status: "ok" | "error" | "pending";
  /** First non-empty output line, for a compact result hint. */
  outputPreview?: string;
}

const COMMAND_LABEL = /terminal|bash|shell|cmd/i;
// Deliberately narrow: "file" alone would swallow unrelated tools like a
// hypothetical "filesystem_search". Unmatched labels fall into "other",
// which the sidebar still shows — miscategorization only affects filtering.
const EDIT_LABEL = /edit|str_replace/i;

function categorize(label: string): CommandCategory {
  if (COMMAND_LABEL.test(label)) return "command";
  if (EDIT_LABEL.test(label)) return "edit";
  return "other";
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

// ── Merge request detection for the MR sidebar ───────────────────────────────
// The agent links the MRs/PRs it opens in tool output ("glab mr create" /
// "gh pr create" print the URL) and in its final summary. Scanning the
// already-loaded transcript keeps detection free of extra polling; the sidebar
// then fetches live MR state for each detected URL through the BFF.

// Ends at the iid, so query strings, fragments, tab segments (/diffs, /files),
// and trailing punctuation after the number are never captured. `]` and `)`
// are excluded so URLs inside markdown links terminate correctly. Matches
// GitLab MR URLs on any host and GitHub PR URLs on github.com.
const MR_URL_RE = /https?:\/\/[^\s)\]>"']+\/-\/merge_requests\/\d+|https?:\/\/github\.com\/[^\s)\]>"'/]+\/[^\s)\]>"'/]+\/pull\/\d+/g;

/**
 * GitLab merge request / GitHub pull request URLs mentioned anywhere in the
 * transcript (and the separately fetched final response) — normalized,
 * deduplicated, and in first-seen order so the list is stable across polls.
 */
export function extractMrUrls(items: TranscriptItem[], finalResponse?: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const scan = (text: string | null | undefined): void => {
    if (!text) return;
    for (const match of text.matchAll(MR_URL_RE)) {
      const url = match[0].replace(/\/+$/, "");
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  };
  for (const item of items) {
    if (item.type === "toolCall") {
      scan(item.tool.text);
      scan(item.output?.text);
    } else {
      scan(item.event.text);
    }
  }
  scan(finalResponse);
  return out;
}

/** Flatten grouped transcript items into sidebar command entries. */
export function extractCommands(items: TranscriptItem[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const item of items) {
    if (item.type !== "toolCall") continue;
    // Skip synthetic rows groupEvents fabricates for orphaned observations and
    // structured cards that aren't "commands" (task lists, skill invocations).
    if (!item.tool.text || item.tool.label === "output") continue;
    if (item.tool.tasks || item.output?.tasks) continue;
    if (item.tool.label === "Task list" || item.tool.label === "Skill") continue;
    out.push({
      id: item.tool.id,
      category: categorize(item.tool.label),
      label: item.tool.label,
      text: item.tool.text,
      timestamp: item.tool.timestamp,
      status: item.output ? (item.output.isError ? "error" : "ok") : "pending",
      ...(item.output?.text ? { outputPreview: firstLine(item.output.text).slice(0, 120) } : {}),
    });
  }
  return out;
}
