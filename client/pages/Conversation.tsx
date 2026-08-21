// client/pages/Conversation.tsx
//
// Native conversation view: 3s polling of conversation + events through the
// BFF (deliberately no WebSocket proxying in v1 — same reliability tradeoff
// as Hive's LogViewer), lifecycle controls, and a follow-up composer.
//
// Layout follows the upstream Agent Canvas' reading ergonomics — a centered
// column with generous vertical space, small right-aligned user bubbles, and
// agent prose directly on the page — combined with the Deployment Tracker
// chat language (issue #167) for tool chips, status separators, and errors.
// Files, Changes and the agent-commands audit trail live in an expandable
// right sidebar (ConversationSidebar) so the transcript never leaves view;
// the agent's live task list sits in its own right-sidebar column
// (openhands-task-list-sidebar) between the transcript and that sidebar.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { LinkifiedText, Markdown } from "../ds/markdown.js";
import { openHandsApi, statusTone, TERMINAL_STATUSES, type ConversationSummary, type OpenHandsStatus } from "../lib/api.js";
import { setConversationTabMeta } from "../lib/tabMeta.js";
import { collapseActionGroups, extractCommands, extractMrUrls, groupEvents, mergeRawEvents, normalizeEvents, runningActivity, type DisplayItem, type RawOpenHandsEvent, type RunningActivity, type TaskItem, type ToolCallItem, type TranscriptEvent } from "../lib/events.js";
import { formatClockTime, formatDuration, formatElapsedSince, formatRelativeTime, formatTimestampTooltip, parseEventTimestamp } from "../lib/time.js";
import { MCP_STALL_HINT_AFTER_MS, useMcpStallHint } from "../lib/mcpStall.js";
import { loadStreamEnabled, streamRetryDelay } from "../lib/streamPrefs.js";
import { isCoarsePointer } from "../lib/touch.js";
import { useIsLgUp, useIsSmUp, useKeyboardOpen } from "../lib/viewport.js";
import { conversationMode } from "../lib/planMode.js";
import { MODEL_LABELS, StatusPill } from "./Hub.js";
import { ConversationSidebar, type SidebarPanel } from "../components/ConversationSidebar.js";
import { MobileDock, MobileSheet } from "../components/MobileSheet.js";
import { StatusBar } from "../components/StatusBar.js";
import { WorkspaceModeBadge } from "../components/WorkspaceModeBadge.js";
import { RunBanner, useRunMembership } from "../components/RunBanner.js";
import { managerApi, TERMINAL_RUN_STATUSES } from "../lib/manager-api.js";
import {
  ExecutorRow,
  hasManagerCommand,
  isExecutorMessage,
  isTriggerMessage,
  ManagerAgentMessage,
  TriggerSeparator,
} from "../components/ManagerSkin.js";
import { AttachImagesButton, ImageChips, useChatImages } from "../components/ImageAttachments.js";

/**
 * Deep-link entry points: `/files` and `/changes` open the conversation with
 * that sidebar panel expanded; `transcript` leaves the sidebar to the user's
 * persisted choice.
 */
export type ConversationTab = "transcript" | "files" | "changes" | "preview" | "run";

const WRAP_STORAGE_KEY = "openhands.wrapOutput";
const SIDEBAR_STORAGE_KEY = "openhands.conversationSidebar";
const TASKS_STORAGE_KEY = "openhands.taskListCollapsed";

/** Sidebar panel to open on mount: the deep link wins over the stored choice. */
function initialSidebarPanel(tab: ConversationTab): SidebarPanel | null {
  if (tab !== "transcript") return tab;
  const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  if (stored === "off") return null;
  if (stored === "files" || stored === "changes" || stored === "preview" || stored === "commands" || stored === "mr" || stored === "run") return stored;
  return "commands";
}

// ── Row components ───────────────────────────────────────────────────────────

/** Badges for skills activated by a message — matches the Canvas UI's skill chips. */
function SkillBadges({ skills, align }: { skills?: string[]; align?: "end" }) {
  if (!skills?.length) return null;
  return (
    <div className={`mb-1 flex flex-wrap gap-1 ${align === "end" ? "justify-end" : ""}`} data-testid="openhands-skill-badges">
      {skills.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.08))] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
          title={`Skill activated: ${s}`}
        >
          <span aria-hidden>⚡</span>
          {s}
        </span>
      ))}
    </div>
  );
}

/**
 * Muted timestamp shown on transcript rows. Prefers a relative label
 * ("2m ago") for recent events, falling back to a local clock time; the
 * `title` tooltip always carries the full local date plus the raw UTC value
 * so the timezone is discoverable either way.
 */
function TimeLabel({ timestamp, className = "" }: { timestamp: string; className?: string }) {
  if (!timestamp) return null;
  const display = formatRelativeTime(timestamp) || formatClockTime(timestamp);
  if (!display) return null;
  return (
    <time
      dateTime={timestamp}
      title={formatTimestampTooltip(timestamp)}
      className={`shrink-0 whitespace-nowrap text-[10px] tabular-nums text-[var(--color-text-muted)] opacity-70 ${className}`}
      data-testid="openhands-event-time"
    >
      {display}
    </time>
  );
}

function UserBubble({ e }: { e: TranscriptEvent }) {
  return (
    <div className="flex flex-col items-end gap-1" data-kind="user">
      <SkillBadges skills={e.skills} align="end" />
      <div className="max-w-[90%] sm:max-w-[75%] rounded-2xl bg-[var(--color-background-muted,rgba(127,127,127,0.12))] px-4 py-2.5 text-sm">
        {e.text && (
          <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">
            <LinkifiedText text={e.text} />
          </pre>
        )}
        {e.images && e.images.length > 0 && (
          <div className={`flex flex-wrap justify-end gap-2 ${e.text ? "mt-2" : ""}`} data-testid="openhands-message-images">
            {e.images.map((src, i) => (
              // Data URLs only (enforced in imagesOf) — safe to inline render.
              <img
                key={i}
                src={src}
                alt={`attached image ${i + 1}`}
                className="max-h-64 max-w-full rounded-lg border border-[var(--color-border-default)] object-contain"
              />
            ))}
          </div>
        )}
      </div>
      <TimeLabel timestamp={e.timestamp} />
    </div>
  );
}

function AgentProse({ e }: { e: TranscriptEvent }) {
  return (
    <div className="text-sm leading-relaxed" data-kind="agent">
      <SkillBadges skills={e.skills} />
      <Markdown source={e.text} />
      <div className="mt-1 flex justify-end">
        <TimeLabel timestamp={e.timestamp} />
      </div>
    </div>
  );
}

const TASK_ICON: Record<NonNullable<TaskItem["status"]>, { glyph: string; cls: string }> = {
  done: { glyph: "✓", cls: "text-[var(--color-text-success,#22c55e)]" },
  in_progress: { glyph: "◐", cls: "text-blue-400" },
  todo: { glyph: "○", cls: "text-[var(--color-text-muted)]" },
};

/** Checklist body shared by the pinned task list and expanded task-tracker chips. */
function TaskChecklist({ tasks }: { tasks: TaskItem[] }) {
  return (
    <ul className="space-y-1.5">
      {tasks.map((t, i) => {
        const icon = TASK_ICON[t.status ?? "todo"];
        return (
          <li key={i} className="flex items-start gap-2 text-sm" data-status={t.status ?? "todo"}>
            <span className={`mt-0.5 shrink-0 ${icon.cls}`} aria-hidden>{icon.glyph}</span>
            <div className="min-w-0">
              <span className={t.status === "done" ? "text-[var(--color-text-muted)] line-through" : ""}>{t.title}</span>
              {t.notes && <div className="text-xs text-[var(--color-text-muted)]">{t.notes}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Checklist card for an expanded task-tracker chip — a point-in-time snapshot. */
function TaskListCard({ tasks }: { tasks: TaskItem[] }) {
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div
      className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.06))] p-3"
      data-kind="tasklist"
      data-testid="openhands-task-list"
    >
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
        <span>Task list</span>
        <span>{done}/{tasks.length} done</span>
      </div>
      <TaskChecklist tasks={tasks} />
    </div>
  );
}

/**
 * The agent's current plan, shown in its own right-sidebar column beside the
 * transcript so it never scrolls out of view as new messages stream in.
 * Collapsing folds the whole column into a slim vertical rail (mirroring the
 * ConversationSidebar icon rail) instead of leaving an empty column; the
 * choice persists per browser. The same element structure renders in both
 * states so the toggle keeps its DOM identity across clicks.
 */
function PinnedTaskList({ tasks }: { tasks: TaskItem[] }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(TASKS_STORAGE_KEY) === "on");
  const done = tasks.filter((t) => t.status === "done").length;
  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem(TASKS_STORAGE_KEY, c ? "off" : "on");
      return !c;
    });
  };
  const summary = `${done}/${tasks.length} done`;
  return (
    <aside
      className={`shrink-0 border-l border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.04))] ${
        collapsed ? "w-9" : "thin-scrollbar w-72 overflow-y-auto"
      }`}
      aria-label="Task list"
      data-state={collapsed ? "collapsed" : "expanded"}
      data-testid="openhands-task-list-sidebar"
    >
      <div className={collapsed ? "h-full" : "px-3 py-2"} data-testid="openhands-pinned-tasks">
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand task list" : "Collapse task list"}
          className={`flex text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] ${
            collapsed ? "h-full w-full flex-col items-center gap-2 py-3" : "w-full items-center gap-1.5"
          }`}
          data-testid="openhands-pinned-tasks-toggle"
        >
          <span aria-hidden>{collapsed ? "\u25C2" : "\u25BE"}</span>
          <span className={collapsed ? "[writing-mode:vertical-rl]" : ""}>Task list</span>
          <span className={`tabular-nums ${collapsed ? "[writing-mode:vertical-rl]" : "ml-auto"}`}>{summary}</span>
        </button>
        {!collapsed && (
          <div className="mt-2" data-testid="openhands-pinned-tasks-body">
            <TaskChecklist tasks={tasks} />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Phone-width task list: the desktop `w-72` column would leave a ~50px
 * transcript on a 375px screen, so below lg the live plan is a collapsible
 * strip docked above the composer instead.
 */
function TaskListStrip({ tasks }: { tasks: TaskItem[] }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div className="border-t border-[var(--color-border-default)]" data-testid="openhands-task-list-strip">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-1.5 px-3 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
        data-testid="openhands-task-list-strip-toggle"
      >
        <span aria-hidden>{open ? "\u25BE" : "\u25B8"}</span>
        <span>Task list</span>
        <span className="ml-auto tabular-nums">{done}/{tasks.length} done</span>
      </button>
      {open && (
        <div className="thin-scrollbar max-h-[40vh] overflow-y-auto px-3 pb-3" data-testid="openhands-task-list-strip-body">
          <TaskChecklist tasks={tasks} />
        </div>
      )}
    </div>
  );
}

/** Compact status signal for the one-row phone header — tone only; the full
 *  label lives in the tooltip and the header ⋯ menu. */
const DOT_CLASSES: Record<ReturnType<typeof statusTone>, string> = {
  ok: "bg-emerald-500",
  busy: "bg-blue-500 animate-pulse",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

function StatusDot({ status }: { status: string }) {
  const label = status.replace(/_/g, " ");
  return (
    <span
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASSES[statusTone(status)]}`}
      role="status"
      title={label}
      aria-label={label}
      data-testid="openhands-status-dot"
    />
  );
}

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-[var(--color-text-default)] transition-colors hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] disabled:pointer-events-none disabled:opacity-40";

/**
 * Phone-width header overflow menu (issue #28): on a ~375px screen the header
 * held 8+ elements across three wrapped rows. Below sm only back / title /
 * status dot stay inline; every action and badge moves here. Wrap lives here
 * too — its only other home is the sheet header, invisible while closed.
 */
function HeaderMenu({
  status,
  busy,
  promotable,
  promoteBusy,
  hadRun,
  onRun,
  onPause,
  onDelete,
  onPromote,
  wrap,
  onToggleWrap,
  workingDir,
}: {
  status: string;
  busy: boolean;
  promotable: boolean;
  promoteBusy: boolean;
  /** Conversation previously belonged to a run — changes the Promote label. */
  hadRun: boolean;
  onRun: () => void;
  onPause: () => void;
  onDelete: () => void;
  onPromote: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  workingDir: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] hover:text-[var(--color-text-default)]"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Conversation actions"
        data-testid="conversation-header-menu"
      >
        <span aria-hidden>⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-app)] p-1 shadow-xl"
          data-testid="conversation-header-menu-panel"
        >
          <button role="menuitem" className={MENU_ITEM_CLASS} disabled={busy || status === "running"} onClick={run(onRun)}>
            <span aria-hidden>▶</span> Run
          </button>
          <button role="menuitem" className={MENU_ITEM_CLASS} disabled={busy || status !== "running"} onClick={run(onPause)}>
            <span aria-hidden>⏸</span> Pause
          </button>
          {promotable && (
            <button
              role="menuitem"
              className={MENU_ITEM_CLASS}
              disabled={promoteBusy}
              onClick={run(onPromote)}
              data-testid="conversation-header-menu-promote"
            >
              <span aria-hidden>⬡</span>{" "}
              {promoteBusy ? "Promoting…" : hadRun ? "Promote again (new run)" : "Promote to manager"}
            </button>
          )}
          <button role="menuitem" className={MENU_ITEM_CLASS} aria-pressed={wrap} onClick={run(onToggleWrap)}>
            <span aria-hidden>{wrap ? "☑" : "☐"}</span> Wrap tool output
          </button>
          <div className="my-1 border-t border-[var(--color-border-default)]" role="separator" />
          {/* Status + workspace only. Plan mode is deliberately absent: #94
              retired the badge/banner in favour of the composer's amber
              chrome and its Build/Plan toggle as the single signal+control. */}
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
            <WorkspaceModeBadge workingDir={workingDir} />
            <StatusPill status={status} />
          </div>
          <div className="my-1 border-t border-[var(--color-border-default)]" role="separator" />
          <button
            role="menuitem"
            className={`${MENU_ITEM_CLASS} text-red-600 dark:text-red-400`}
            disabled={busy}
            onClick={run(onDelete)}
            data-testid="conversation-header-menu-delete"
          >
            <span aria-hidden>🗑</span> Delete…
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact expandable tool chip with the paired output attached. */
function ToolCallRow({ tool, output, wrap }: { tool: TranscriptEvent; output: TranscriptEvent | null; wrap: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const failed = output?.isError === true;
  // Task-tracker calls carry a structured plan. The task-list sidebar column
  // shows the live list, so inline the call is just a compact chip
  // whose expansion reveals that point-in-time snapshot. Prefer the
  // observation's list (authoritative after a `view`), falling back to the
  // plan on the action.
  const tasks = failed ? undefined : output?.tasks ?? tool.tasks;
  const taskSummary = tasks ? `${tasks.filter((t) => t.status === "done").length}/${tasks.length} done` : null;
  const preClass = wrap
    ? "whitespace-pre-wrap break-words"
    : "overflow-x-auto thin-scrollbar";
  const duration = formatDuration(tool.timestamp, output?.timestamp);
  return (
    <div data-kind="tool">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded bg-[var(--color-background-muted,rgba(127,127,127,0.12))] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] pointer-coarse:min-h-10 ${failed ? "border border-[var(--color-border-critical)]" : ""}`}
        aria-expanded={expanded}
      >
        <span aria-hidden>{expanded ? "\u25BE" : "\u25B8"}</span>
        <span className={failed ? "text-[var(--color-text-critical)]" : "text-blue-400"} aria-hidden>&#9679;</span>
        {/* The model reasoned here, but the provider only exposed an encrypted
            payload — mark it rather than adding an empty Thought row. */}
        {tool.opaque && (
          <span className="shrink-0 opacity-50" title="The model reasoned before this action (encrypted by the provider)" data-testid="openhands-tool-opaque-thought" aria-hidden>
            &#10022;
          </span>
        )}
        <span className="shrink-0 font-medium">{tool.label}</span>
        {tool.risk && <RiskBadge risk={tool.risk} />}
        {/* The Canvas titles collapsed rows with the tool call's human summary;
            fall back to the compact argument detail when the tool didn't
            provide one (or when OpenHands only had its args-dump fallback).
            min-w-0 lets the truncation actually engage inside the flex row —
            without it long paths pushed the chip past the viewport. */}
        {taskSummary ? (
          <span className="min-w-0 truncate" data-testid="openhands-tool-summary">{taskSummary}</span>
        ) : tool.summary ? (
          <span className="min-w-0 truncate" data-testid="openhands-tool-summary">{tool.summary}</span>
        ) : tool.text ? (
          <span className="min-w-0 truncate font-mono" data-testid="openhands-tool-detail">{tool.text}</span>
        ) : null}
        {/* Execution time is useful at a glance; it used to require expanding. */}
        {duration && (
          <span className="shrink-0 opacity-70 tabular-nums" title="Execution time" data-testid="openhands-tool-duration-chip">
            {duration}
          </span>
        )}
        <TimeLabel timestamp={tool.timestamp} />
      </button>
      {expanded && tasks && (
        <div className="mt-1">
          <TaskListCard tasks={tasks} />
        </div>
      )}
      {expanded && !tasks && (
        <div className="mt-1 space-y-1">
          {/* Duration now lives on the chip itself, so it no longer needs an
              expansion to be visible. */}
          {tool.text && (
            <pre className={`rounded bg-[var(--color-background-muted,rgba(127,127,127,0.12))] p-2 font-mono text-[11px] ${preClass}`}>
              <code>{tool.text}</code>
            </pre>
          )}
          <pre
            className={`rounded p-2 font-mono text-[11px] ${preClass} ${failed ? "bg-[var(--color-background-surface-critical-muted)]" : "bg-[var(--color-background-muted,rgba(127,127,127,0.06))] opacity-90"}`}
          >
            <code>{output?.text || "(no output)"}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * "N actions completed" row for a run of finished tool calls — mirrors the
 * Canvas' action grouping. Expanded by default (header + collapsed chips is
 * the resting reading level); collapsing hides the chips entirely. Expansion
 * is controlled by the page so the commands sidebar can force a group open
 * before jumping to a row inside.
 */
function ActionGroupRow({
  group,
  wrap,
  expanded,
  onToggle,
}: {
  group: Extract<DisplayItem, { type: "actionGroup" }>;
  wrap: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const last = group.calls[group.calls.length - 1];
  return (
    <div data-kind="action-group" data-testid="openhands-action-group">
      <button
        onClick={onToggle}
        className="inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] pointer-coarse:min-h-10"
        aria-expanded={expanded}
        data-testid="openhands-action-group-toggle"
      >
        <span aria-hidden>{expanded ? "\u25BE" : "\u25B8"}</span>
        <span>{group.calls.length} actions completed</span>
        <TimeLabel timestamp={last.tool.timestamp} />
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5 border-l border-[var(--color-border-default)] pl-3">
          {group.calls.map((call) => (
            <div key={call.tool.id} data-event-id={call.tool.id}>
              <ToolCallRow tool={call.tool} output={call.output} wrap={wrap} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusSeparator({ e }: { e: TranscriptEvent }) {
  return (
    <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] opacity-70" data-kind="status">
      <span className="h-px flex-1 bg-[var(--color-border-default)]" aria-hidden />
      <span>
        {e.text.replace(/_/g, " ")}
        {e.timestamp && (
          <>
            {" · "}
            <time dateTime={e.timestamp} title={formatTimestampTooltip(e.timestamp)} data-testid="openhands-event-time">
              {formatClockTime(e.timestamp)}
            </time>
          </>
        )}
      </span>
      <span className="h-px flex-1 bg-[var(--color-border-default)]" aria-hidden />
    </div>
  );
}

/**
 * Model reasoning as a distinct, expandable row — visually quieter than agent
 * prose so a transcript still reads as narration. Collapsed it shows the first
 * line; expanded, the full (bounded) reasoning.
 *
 * `live` marks ephemeral reasoning streamed over SSE, which the durable event
 * replaces on the next poll. No duration is shown for replayed reasoning:
 * OpenHands persists only the action's completion timestamp, so any figure
 * would be invented (see PR notes).
 */
function ThoughtRow({ text, live = false }: { text: string; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const hasMore = text.trim() !== firstLine;
  return (
    <div data-kind="reasoning" data-testid={live ? "openhands-thought-live" : "openhands-thought"}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-[11px] italic text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
        aria-expanded={expanded}
      >
        <span aria-hidden>{expanded ? "\u25BE" : "\u25B8"}</span>
        <span className="shrink-0 font-medium not-italic">Thought</span>
        {!expanded && firstLine && (
          <span className="truncate opacity-80">
            {firstLine}
            {hasMore ? "…" : ""}
          </span>
        )}
        {live && <span className="shrink-0 opacity-60 not-italic">▍</span>}
      </button>
      {expanded && (
        <div className="mt-1 whitespace-pre-wrap break-words border-l border-[var(--color-border-default)] pl-3 text-[11px] italic leading-relaxed text-[var(--color-text-muted)]">
          {text}
        </div>
      )}
    </div>
  );
}

/** Risk badge for actions the security analyzer flagged as non-trivial. */
function RiskBadge({ risk }: { risk: NonNullable<TranscriptEvent["risk"]> }) {
  if (risk === "LOW") return null;
  const critical = risk === "HIGH";
  return (
    <span
      data-testid="openhands-tool-risk"
      className={`shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wide ${
        critical
          ? "bg-[var(--color-background-surface-critical-muted)] text-[var(--color-text-critical)]"
          : "text-[var(--color-text-muted)] opacity-80"
      }`}
      title={`Security analyzer risk: ${risk}`}
    >
      {risk}
    </span>
  );
}

function ErrorCard({ e }: { e: TranscriptEvent }) {
  return (
    <div className="rounded-lg border border-[var(--color-border-critical)] bg-[var(--color-background-surface-critical-muted)] p-3 text-sm" data-kind="error">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-critical)]">
        <span>{e.label}</span>
        <TimeLabel timestamp={e.timestamp} className="text-[var(--color-text-critical)]" />
      </div>
      <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">{e.text}</pre>
    </div>
  );
}

/**
 * Running indicator with live detail: shows the currently executing tool call
 * (an ActionEvent still awaiting its observation) with a ticking elapsed time,
 * or — when nothing is pending — how long the transcript has been silent
 * (LLM generating, or an invisible stall like rate-limit backoff; issue #48).
 *
 * A long silence additionally gets a cause hint when the tool-health probe
 * knows an MCP server is down (issue #41) — see lib/mcpStall.ts.
 */
function RunningIndicator({ activity }: { activity: RunningActivity }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const elapsed = formatElapsedSince(activity.since, now);
  const detail = activity.kind === "tool" ? activity.text.replace(/\s+/g, " ").trim() : "";
  const silentMs = activity.kind === "thinking" && activity.since ? now - (parseEventTimestamp(activity.since)?.getTime() ?? now) : 0;
  const stallHint = useMcpStallHint(silentMs >= MCP_STALL_HINT_AFTER_MS);
  return (
    <div className="text-xs text-[var(--color-text-muted)]" data-testid="openhands-running">
      <div className="flex items-center gap-2">
        <svg className="shrink-0 animate-spin" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        {activity.kind === "tool" ? (
          <span className="min-w-0 truncate" data-testid="openhands-running-tool">
            Running {activity.label}
            {detail && (
              <>
                : <code className="font-mono text-[11px]">{detail.length > 90 ? `${detail.slice(0, 90)}…` : detail}</code>
              </>
            )}
            {elapsed && <span className="opacity-70"> ({elapsed})</span>}
          </span>
        ) : (
          <span data-testid="openhands-running-thinking">
            Thinking…
            {elapsed && <span className="opacity-70"> no new events for {elapsed}</span>}
          </span>
        )}
      </div>
      {activity.kind === "thinking" && stallHint && (
        <div className="mt-1 pl-5" data-testid="openhands-running-stall-hint">
          {stallHint}{" "}
          <Link to="/openhands/tools" className="underline hover:text-[var(--color-text-default)]">
            Check tools
          </Link>
        </div>
      )}
    </div>
  );
}

function TranscriptRow({
  item,
  wrap,
  managerSkin = false,
}: {
  item: ToolCallItem | Extract<DisplayItem, { type: "event" }>;
  wrap: boolean;
  /** Manager conversations render protocol messages specially. */
  managerSkin?: boolean;
}) {
  if (item.type === "toolCall") return <ToolCallRow tool={item.tool} output={item.output} wrap={wrap} />;
  const e = item.event;
  switch (e.kind) {
    case "user":
      // Monitor wakes and executor replies are machine turns, not human ones.
      if (managerSkin && isTriggerMessage(e.text)) return <TriggerSeparator e={e} />;
      if (managerSkin && isExecutorMessage(e.text)) return <ExecutorRow e={e} />;
      return <UserBubble e={e} />;
    case "agent":
      if (managerSkin && hasManagerCommand(e.text)) return <ManagerAgentMessage e={e} />;
      return <AgentProse e={e} />;
    case "reasoning":
      return <ThoughtRow text={e.text} />;
    case "status":
      return <StatusSeparator e={e} />;
    case "error":
      return <ErrorCard e={e} />;
    default:
      return null;
  }
}

/** Consecutive tool calls / action groups sit tighter together than conversation turns. */
function rowSpacing(prev: DisplayItem | undefined, item: DisplayItem): string {
  if (!prev) return "";
  const isAction = (i: DisplayItem) => i.type === "toolCall" || i.type === "actionGroup";
  if (isAction(prev) && isAction(item)) return "mt-1.5";
  if (item.type === "event" && item.event.kind === "status") return "mt-5";
  return "mt-6";
}

/** Stable React key / scroll anchor for a display item. */
function displayItemId(item: DisplayItem): string {
  if (item.type === "toolCall") return item.tool.id;
  if (item.type === "actionGroup") return item.id;
  return item.event.id;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function ConversationPage({ tab = "transcript" }: { tab?: ConversationTab } = {}) {
  const { id = "" } = useParams<{ id: string }>();
  const [conv, setConv] = useState<ConversationSummary | null>(null);
  // The transcript is bottom-anchored: the poll fetches the NEWEST window and
  // older history is paged in on demand via "Load older events" at the top.
  // Everything ever fetched accumulates here (deduped, chronological — see
  // mergeRawEvents) so the sliding newest-N window can't open gaps.
  const [rawEvents, setRawEvents] = useState<RawOpenHandsEvent[]>([]);
  // Cursor toward OLDER events. Pinned by the FIRST poll: later polls slide
  // the newest window forward, but the oldest un-fetched event stays the same
  // until the user pages further back.
  const [olderPageId, setOlderPageId] = useState<string | null>(null);
  const olderCursorSet = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The agent's final summary fetched separately (issue #233). The bottom-
  // anchored window normally contains the FinishAction, so this is now just a
  // safety net (deduped via hasFinishEvent when the event is loaded).
  const [finalResponse, setFinalResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const attachments = useChatImages();
  const [busy, setBusy] = useState(false);
  // Per-message model choice (issue #245). Empty = keep the conversation's
  // current model; the allowlist comes from the same /status the Hub uses.
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_STORAGE_KEY) !== "off");
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel | null>(() => initialSidebarPanel(tab));
  // Responsive layout state (issue #28): below sm the header collapses to one
  // row with a ⋯ menu; below lg the sidebar becomes dock + bottom sheet and
  // the task list becomes a strip. Conditional *renders* (not CSS hiding) so
  // duplicate testids/ARIA never coexist in the DOM.
  const smUp = useIsSmUp();
  const lgUp = useIsLgUp();
  // While the keyboard is up the column is ~250px tall: passive chrome (panel
  // dock, status bar) is dropped so the composer and some transcript survive.
  const keyboardOpen = useKeyboardOpen();
  // The bottom sheet is transient — unlike the desktop panel it never
  // auto-opens from localStorage (a sheet covering the transcript on every
  // page load would be hostile). Deep links (…/files, …/changes) still open.
  const [mobileSheet, setMobileSheet] = useState<SidebarPanel | null>(() => (tab !== "transcript" ? tab : null));
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef<HTMLTextAreaElement>(null);
  // Scroll compensation for prepended history: captured right before an older
  // page is merged in, applied in a layout effect once the rows are mounted.
  const pendingPrepend = useRef<{ height: number; top: number } | null>(null);
  const lastCount = useRef(0);
  // In-flight fetches must not leak a previous conversation's events into the
  // accumulated transcript after the route param changes.
  const liveId = useRef(id);
  const status = conv?.execution_status ?? "";
  const terminal = TERMINAL_STATUSES.has(status);

  useEffect(() => {
    liveId.current = id;
    setRawEvents([]);
    setOlderPageId(null);
    olderCursorSet.current = false;
    pendingPrepend.current = null;
    lastCount.current = 0;
  }, [id]);

  // Browser-tab identity: session title + status badge (see lib/tabMeta.ts).
  const convTitle = conv?.title;
  const hasConv = Boolean(conv);
  useEffect(() => {
    setConversationTabMeta({
      title: (convTitle ?? "").trim() || `Conversation ${id.slice(0, 8)}`,
      tone: hasConv ? statusTone(status) : null,
    });
  }, [convTitle, status, id, hasConv]);
  useEffect(() => () => setConversationTabMeta(null), []);

  // Manager-run membership: drives the manager skin, the Run sidebar panel,
  // and the Promote button (shown only for conversations outside any run).
  const [membershipRefresh, setMembershipRefresh] = useState(0);
  const membership = useRunMembership(id, membershipRefresh);
  const isManager = membership?.role === "manager";
  // Promote is offered outside any run AND on conversations whose run ended:
  // a terminal run releases its conversation, so the accumulated planning
  // context can seed a fresh run (issue #265, gap C). `undefined` = still
  // loading — never offer Promote on unknown membership.
  const promotable =
    membership === null ||
    (membership != null &&
      membership.status != null &&
      TERMINAL_RUN_STATUSES.has(membership.status));
  // One-click promote: no dialog — the server infers the repository from the
  // conversation (or lets the manager resolve it during planning).
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const promote = async () => {
    if (promoteBusy) return;
    setPromoteBusy(true);
    setPromoteError(null);
    try {
      await managerApi.createRun({ managerConversationId: id });
      setMembershipRefresh((n) => n + 1);
    } catch (err) {
      setPromoteError(String((err as Error).message ?? err));
    } finally {
      setPromoteBusy(false);
    }
  };
  // A freshly-opened manager conversation starts on its Run panel.
  const managerPanelOpened = useRef(false);
  useEffect(() => {
    managerPanelOpened.current = false;
  }, [id]);
  useEffect(() => {
    if (isManager && tab === "transcript" && !managerPanelOpened.current) {
      managerPanelOpened.current = true;
      setSidebarPanel("run");
    }
  }, [isManager, tab]);

  const toggleWrap = () => {
    setWrap((w) => {
      localStorage.setItem(WRAP_STORAGE_KEY, w ? "off" : "on");
      return !w;
    });
  };

  const openSidebarPanel = (panel: SidebarPanel) => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, panel);
    setSidebarPanel(panel);
  };

  const collapseSidebar = () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "off");
    setSidebarPanel(null);
  };

  // Deep links (…/files, …/changes) open their panel even when the page is
  // already mounted; plain in-app panel switches don't touch the URL.
  useEffect(() => {
    if (tab !== "transcript") {
      setSidebarPanel(tab);
      setMobileSheet(tab);
    }
  }, [tab]);

  // In-flight guard: the 3s interval fires regardless of how long the previous
  // poll takes, so without this a slow/wedged BFF read stacks ~10 concurrent
  // polls per 30s per open tab — enough to exhaust the agent-server's worker
  // pool and take down every OpenHands endpoint (shared-deployment incident, 2026-08-19). Skipped
  // ticks are fine: the next tick after completion picks up the fresh state.
  const pollInFlight = useRef(false);
  const poll = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      // Newest-first window: the bottom of the transcript is always loaded.
      const [c, ev] = await Promise.all([openHandsApi.get(id), openHandsApi.events(id, 300, undefined, true)]);
      if (liveId.current !== id) return;
      setConv(c);
      setRawEvents((prev) => mergeRawEvents(prev, ev.items));
      if (!olderCursorSet.current) {
        olderCursorSet.current = true;
        setOlderPageId(ev.next_page_id ?? null);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pollInFlight.current = false;
    }
  }, [id]);

  useEffect(() => {
    void poll();
    if (terminal) return;
    // Hidden tabs skip their poll ticks: with many sessions open, N background
    // tabs otherwise keep N transcript walks running against the shared
    // agent-server worker pool (issue #48). One immediate refresh on return
    // keeps the transcript feeling live.
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void poll();
    }, 3_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [poll, terminal]);

  // Live token stream (SSE bridging the agent-server websocket; issue #48).
  // `delta` frames accumulate into a draft bubble rendered under the
  // transcript; any durable `event` frame triggers an immediate poll and
  // drops the draft (the persisted transcript supersedes it). Display-only:
  // when the stream is down this degrades to plain 3s polling.
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  // Live reasoning is tracked separately from the answer draft: it is the
  // model thinking, not the reply, and the durable ActionEvent supersedes it.
  const [reasoningDraft, setReasoningDraft] = useState("");
  const reasoningDraftRef = useRef("");
  const clearDraft = useCallback(() => {
    draftRef.current = "";
    setDraft("");
    reasoningDraftRef.current = "";
    setReasoningDraft("");
  }, []);
  // Connection budget: browsers cap HTTP/1.1 at ~6 connections per origin, so
  // persistent EventSources must be scarce. The stream opens only when ALL of:
  //  - this conversation is actively running (idle/finished tabs have nothing
  //    to stream — this is most open tabs),
  //  - the tab is visible (hidden tabs pause their poll anyway and the draft
  //    is invisible),
  //  - the per-browser kill switch (Agent-settings page) is on.
  // Reconnects are bounded (2s/4s/8s, then poll-only): EventSource's default
  // infinite retry turned a BFF restart into a pool-exhausting zombie storm
  // (#58). Read the pref at effect time — cheap, and re-checked whenever the
  // run state flips.
  const streamActive = status === "running" && !terminal;
  useEffect(() => {
    clearDraft();
    if (!streamActive || !loadStreamEnabled()) return;
    let es: EventSource | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const close = () => {
      es?.close();
      es = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const open = () => {
      if (disposed || es || document.visibilityState === "hidden") return;
      es = new EventSource(`/api/openhands/conversations/${id}/stream`);
      es.onopen = () => {
        retries = 0;
      };
      es.addEventListener("delta", (e) => {
        try {
          const { content } = JSON.parse((e as MessageEvent<string>).data) as { content?: string };
          if (typeof content === "string" && content) {
            draftRef.current += content;
            setDraft(draftRef.current);
          }
        } catch {
          /* malformed frame — ignore */
        }
      });
      es.addEventListener("reasoning", (e) => {
        try {
          const { content } = JSON.parse((e as MessageEvent<string>).data) as { content?: string };
          if (typeof content === "string" && content) {
            reasoningDraftRef.current += content;
            setReasoningDraft(reasoningDraftRef.current);
          }
        } catch {
          /* malformed frame — ignore */
        }
      });
      es.addEventListener("event", () => {
        clearDraft();
        void poll();
      });
      es.onerror = () => {
        close();
        const delay = streamRetryDelay(retries);
        if (delay === null) return; // exhausted — degrade to poll-only
        retries += 1;
        retryTimer = setTimeout(open, delay);
      };
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        retries = 0;
        open();
      } else {
        close();
        clearDraft();
      }
    };
    open();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      close();
    };
  }, [id, streamActive, poll, clearDraft]);
  // Safety net: a newly persisted event from the regular poll obsoletes the
  // draft. Keyed on the NEWEST event rather than the count, so paging older
  // history in doesn't discard an in-flight stream.
  const newestEventId = rawEvents.length > 0 ? String(rawEvents[rawEvents.length - 1].id ?? "") : "";
  useEffect(() => {
    clearDraft();
  }, [newestEventId, clearDraft]);

  // Model allowlist for the per-message switcher (best-effort, once).
  useEffect(() => {
    openHandsApi
      .status()
      .then((s: OpenHandsStatus) => setModels(s.models ?? (s.model ? [s.model] : [])))
      .catch(() => setModels([]));
  }, []);

  // Once the run has ended, fetch the final summary so it renders even when
  // the FinishAction falls outside the loaded transcript window (issue #233).
  useEffect(() => {
    if (!terminal) {
      // A follow-up resumes the run — the previous summary is stale.
      setFinalResponse(null);
      return;
    }
    openHandsApi
      .finalResponse(id)
      .then((text) => setFinalResponse(typeof text === "string" && text.trim() ? text : null))
      .catch(() => setFinalResponse(null));
  }, [id, terminal]);

  const loadOlder = async () => {
    if (!olderPageId || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await openHandsApi.events(id, 300, olderPageId, true);
      if (liveId.current !== id) return;
      // Rows are about to be inserted ABOVE the viewport — capture the scroll
      // geometry so the layout effect can keep what's on screen in place. Only
      // armed when the merge actually adds rows, so an all-duplicate page
      // can't make the next bottom-append skip its autoscroll.
      const scroller = scrollerRef.current;
      setRawEvents((prev) => {
        const merged = mergeRawEvents(prev, page.items);
        if (merged !== prev && scroller) {
          pendingPrepend.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
        }
        return merged;
      });
      setOlderPageId(page.next_page_id ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const allEvents = useMemo(() => normalizeEvents(rawEvents), [rawEvents]);

  // New rows at the bottom follow the conversation (autoscroll); older rows
  // prepended at the top must NOT move what the reader is looking at, so the
  // scroll position is compensated by the height the new rows added.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const prepend = pendingPrepend.current;
    if (prepend && scroller) {
      pendingPrepend.current = null;
      scroller.scrollTop = prepend.top + (scroller.scrollHeight - prepend.height);
    } else if (allEvents.length > lastCount.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
    lastCount.current = allEvents.length;
  }, [allEvents.length]);

  const items = useMemo(() => groupEvents(allEvents), [allEvents]);
  // Canvas-style grouping: runs of completed actions sit under one
  // "N actions completed" header. Groups are expanded unless the user
  // explicitly collapses them (per-group, keyed by a stable id).
  const displayItems = useMemo(() => collapseActionGroups(items), [items]);
  const liveActivity = useMemo(() => runningActivity(items), [items]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);
  const groupOfEvent = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of displayItems) {
      if (item.type !== "actionGroup") continue;
      for (const call of item.calls) m.set(call.tool.id, item.id);
    }
    return m;
  }, [displayItems]);

  // Scroll the transcript to a command's row and flash it so the eye lands
  // on the right chip among visually similar tool rows. Rows folded into a
  // collapsed action group are expanded first, then scrolled to once mounted.
  const jumpToEvent = useCallback((eventId: string) => {
    const scroll = () => {
      const el = document.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
      if (!(el instanceof HTMLElement)) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const highlight = ["rounded", "outline", "outline-2", "outline-[var(--color-border-focus)]"];
      el.classList.add(...highlight);
      setTimeout(() => el.classList.remove(...highlight), 1_500);
    };
    const groupId = groupOfEvent.get(eventId);
    if (groupId && collapsedGroups[groupId]) {
      setCollapsedGroups((prev) => ({ ...prev, [groupId]: false }));
      setTimeout(scroll, 60); // wait a tick for the expanded rows to mount
      return;
    }
    scroll();
  }, [groupOfEvent, collapsedGroups]);

  const commandEntries = useMemo(() => extractCommands(items), [items]);
  // MRs the agent linked, from the already-polled events — no extra polling.
  // Re-memoized on the JOINED url set so the array identity (and therefore the
  // MR panel's fetch effect) only changes when an actually-new URL appears.
  const mrUrlsKey = useMemo(() => extractMrUrls(items, finalResponse).join("\n"), [items, finalResponse]);
  const mrUrls = useMemo(() => (mrUrlsKey ? mrUrlsKey.split("\n") : []), [mrUrlsKey]);
  // De-duplicate: hide the separately fetched summary once the FinishAction
  // itself is part of the loaded transcript.
  const hasFinishEvent = useMemo(() => allEvents.some((e) => e.isFinal), [allEvents]);
  // Latest task-tracker snapshot: events are chronological, so the last event
  // carrying a task list is the agent's current plan (shown in the task-list
  // sidebar column so it stays in view while messages stream in).
  const latestTasks = useMemo(() => {
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const tasks = allEvents[i].tasks;
      if (tasks && tasks.length > 0) return tasks;
    }
    return null;
  }, [allEvents]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await poll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const model = conv?.agent?.llm?.model;

  // Seed the switcher with the model the conversation actually runs on.
  useEffect(() => {
    if (!selectedModel && model) setSelectedModel(model);
  }, [selectedModel, model]);

  const send = () => {
    const text = followUp.trim();
    if (!text || busy) return;
    // Only request a switch when the choice differs from the live model, so
    // plain follow-ups never touch the conversation's LLM.
    const switchTo = selectedModel && selectedModel !== model ? selectedModel : undefined;
    const images = attachments.images;
    void act(async () => {
      await openHandsApi.send(id, text, switchTo, images.length > 0 ? images : undefined);
      setFollowUp("");
      attachments.clear();
    });
  };

  // Auto-grow the composer with its content (capped ~6 lines): a fixed
  // two-row box made anything longer scroll inside a tiny window on phones.
  useEffect(() => {
    const el = followUpRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [followUp]);

  // Switcher options: the allowlist plus — when a conversation still runs on a
  // model that has since left the allowlist — its live model, so the select
  // always reflects reality.
  const modelOptions = useMemo(
    () => (model && !models.includes(model) ? [model, ...models] : models),
    [model, models],
  );

  // Generic confirmation handling: even Build (NeverConfirm) conversations can
  // surface a confirmation request for an individual action, so honour the
  // upstream status rather than any client-side mode.
  const waitingForConfirmation = status === "waiting_for_confirmation";

  // Plan/Build mode derives from the upstream confirmation policy (see
  // lib/planMode) so the UI can't drift from what the agent-server enforces.
  // The composer toggle is the single control: switching to Build is how a
  // plan gets approved, and the amber composer is how plan mode is announced.
  const mode = conv ? conversationMode(conv.confirmation_policy) : "build";
  const planMode = mode === "plan";
  const switchMode = (next: "build" | "plan") => act(() => openHandsApi.setMode(id, next));

  // Composer border, accent included. Amber = plan mode (writes are gated
  // behind your approval); cyan = manager conversation.
  //
  // The whole border has to be described by one branch of this expression.
  // Class lists resolve by stylesheet order, not by the order they are
  // written, and Tailwind emits the `border-<color>` shorthand after
  // `border-t-<color>` — so a shorthand base colour silently beats a per-side
  // accent. That is why the manager's cyan strip has never actually rendered.
  // Colouring the other three sides individually keeps base and accent on
  // different properties, where neither can clobber the other.
  //
  // Plan mode wins when both apply: the manager identity still reads from its
  // cyan header strip, whereas plan mode has no other composer chrome now
  // that the banner is gone.
  const SIDES = "border-x-[var(--color-border-default)] border-b-[var(--color-border-default)]";
  const composerBorder = planMode
    ? `${SIDES} border-t-2 border-t-amber-500`
    : isManager
      ? `${SIDES} border-t-2 border-t-cyan-500`
      : "border-[var(--color-border-default)]";

  return (
    // Fills the shell's routed area (which is itself 100dvh minus the nav) and
    // contains its own scrolling: only the transcript scrolls, so the composer
    // and the status bar stay on screen at every viewport size.
    <div
      className={`flex h-full min-h-0 flex-col overflow-hidden ${isManager ? "border-t-2 border-cyan-500" : ""}`}
      {...(isManager ? { "data-manager-skin": "true" } : {})}
    >
      {/* Shared shell header: title, status, lifecycle controls, tabs.
          Manager conversations carry a cyan identity so they read as a
          different place at a glance. */}
      <div
        className={`border-b border-[var(--color-border-default)] px-3 py-2 sm:px-6 sm:py-3 ${isManager ? "bg-cyan-500/5" : ""}`}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-2 sm:flex-wrap sm:gap-3">
          <Link
            to="/openhands/native"
            className={
              smUp
                ? "text-xs underline text-[var(--color-text-muted)]"
                : "flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-base text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
            }
            aria-label="Back to conversations"
          >
            {smUp ? "← Conversations" : "←"}
          </Link>
          {isManager && <span aria-hidden title="Manager conversation">🧭</span>}
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{conv?.title || id}</h1>
          {isManager && membership && (
            <Link
              to={`/openhands/runs/${membership.runId}`}
              className="shrink-0 rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-medium text-cyan-800"
              data-testid="manager-header-chip"
              title="Open the wide run board"
            >
              MANAGER{smUp ? ` · ${membership.status ?? "run"}` : ""}
            </Link>
          )}
          {smUp ? (
            <>
              {conv && <StatusPill status={status} />}
              {conv && <WorkspaceModeBadge workingDir={conv.workspace?.working_dir} />}
              {conv && promotable && (
                <Button
                  size="sm"
                  data-testid="manager-promote-button"
                  disabled={promoteBusy}
                  onClick={() => void promote()}
                  title={
                    membership
                      ? "The previous run ended — start a fresh run from this conversation's context"
                      : "Turn this conversation into the manager of a parallel worker run — the repository is inferred from the conversation"
                  }
                >
                  {promoteBusy
                    ? "Promoting…"
                    : membership
                      ? "⬡ Promote again (new run)"
                      : "⬡ Promote to manager"}
                </Button>
              )}
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy || status === "running"} onClick={() => act(() => openHandsApi.action(id, "run"))}>
                  Run
                </Button>
                <Button size="sm" variant="secondary" disabled={busy || status !== "running"} onClick={() => act(() => openHandsApi.action(id, "pause"))}>
                  Pause
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Delete this conversation? The workspace files persist.")) {
                      void act(async () => {
                        await openHandsApi.remove(id);
                        window.location.href = "/openhands/native";
                      });
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </>
          ) : (
            conv && (
              <>
                <StatusDot status={status} />
                <HeaderMenu
                  status={status}
                  busy={busy}
                  promotable={promotable}
                  promoteBusy={promoteBusy}
                  hadRun={membership != null}
                  onRun={() => void act(() => openHandsApi.action(id, "run"))}
                  onPause={() => void act(() => openHandsApi.action(id, "pause"))}
                  onDelete={() => {
                    if (window.confirm("Delete this conversation? The workspace files persist.")) {
                      void act(async () => {
                        await openHandsApi.remove(id);
                        window.location.href = "/openhands/native";
                      });
                    }
                  }}
                  onPromote={() => void promote()}
                  wrap={wrap}
                  onToggleWrap={toggleWrap}
                  workingDir={conv.workspace?.working_dir}
                />
              </>
            )
          )}
        </div>
      </div>

      {error && <div className="mx-auto w-full max-w-3xl px-3 pt-3 sm:px-6"><Alert variant="danger">{error}</Alert></div>}

      {promoteError && (
        <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-3 pt-3 sm:px-6" data-testid="manager-promote-error">
          <div className="flex-1">
            <Alert variant="danger">Promote failed: {promoteError}</Alert>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setPromoteError(null)} aria-label="Dismiss promote error">
            ✕
          </Button>
        </div>
      )}

      {/* Worker conversations get a membership banner; manager conversations
          get the full skin (header chip + Run panel) instead. */}
      {membership?.role === "worker" ? <RunBanner membership={membership} /> : null}

      {waitingForConfirmation && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-3 pt-3 sm:px-6">
          <Alert variant="warning">
            {planMode
              ? "The agent wants to perform a write action while in plan mode."
              : "The agent is waiting for approval before it performs its next action."}
          </Alert>
          <Button size="sm" disabled={busy} onClick={() => act(() => openHandsApi.respondToConfirmation(id, true))}>Approve</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => openHandsApi.respondToConfirmation(id, false))}>Reject</Button>
        </div>
      )}

      {/* Transcript — open reading column — with the task-list column and the
          Files/Changes/Commands sidebar on the right */}
      <div className="flex min-h-0 flex-1">
        <div ref={scrollerRef} className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-3 py-6 sm:px-6 sm:py-8" data-testid="openhands-transcript">
          <div className="mx-auto max-w-3xl">
            {olderPageId && (
              <div className="mb-6 flex justify-center">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loadingMore}
                  onClick={() => void loadOlder()}
                  data-testid="openhands-load-more"
                >
                  {loadingMore ? "Loading…" : "Load older events"}
                </Button>
              </div>
            )}
            {displayItems.length === 0 ? (
              <div className="py-16 text-center text-sm text-[var(--color-text-muted)]">
                {terminal ? "No transcript events." : "Waiting for the agent…"}
              </div>
            ) : (
              displayItems.map((item, i) => (
                <div
                  key={displayItemId(item)}
                  // Grouped rows carry their own anchors once expanded.
                  data-event-id={item.type === "actionGroup" ? undefined : displayItemId(item)}
                  className={rowSpacing(displayItems[i - 1], item)}
                >
                  {item.type === "actionGroup" ? (
                    <ActionGroupRow
                      group={item}
                      wrap={wrap}
                      expanded={collapsedGroups[item.id] !== true}
                      onToggle={() => toggleGroup(item.id)}
                    />
                  ) : (
                    <TranscriptRow item={item} wrap={wrap} managerSkin={isManager} />
                  )}
                </div>
              ))
            )}
            {finalResponse !== null && !hasFinishEvent && (
              <div className="mt-6" data-kind="agent" data-testid="openhands-final-response">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  Final response
                </div>
                <div className="text-sm leading-relaxed">
                  <Markdown source={finalResponse} />
                </div>
              </div>
            )}
            {status === "running" && reasoningDraft && (
              <div className="mt-6">
                <ThoughtRow text={reasoningDraft} live />
              </div>
            )}
            {status === "running" && draft && (
              <div className="mt-6" data-kind="agent" data-testid="openhands-draft">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  Streaming
                </div>
                <div className="text-sm leading-relaxed opacity-90">
                  <Markdown source={draft} />
                </div>
              </div>
            )}
            {status === "running" && <div className="mt-6"><RunningIndicator activity={liveActivity} /></div>}
            <div ref={bottomRef} />
          </div>
        </div>
        {lgUp && latestTasks && <PinnedTaskList tasks={latestTasks} />}
        {lgUp && (
          <ConversationSidebar
            conversationId={id}
            panel={sidebarPanel}
            entries={commandEntries}
            mrUrls={mrUrls}
            runId={membership?.runId ?? null}
            wrap={wrap}
            onToggleWrap={toggleWrap}
            onJump={jumpToEvent}
            onSelectPanel={openSidebarPanel}
            onCollapse={collapseSidebar}
          />
        )}
      </div>

      {/* Phone-width panel access: the task-list strip and the dock sit
          between the transcript and the composer; the tapped panel opens as
          a full-screen bottom sheet (see MobileSheet.tsx). */}
      {!lgUp && !keyboardOpen && latestTasks && <TaskListStrip tasks={latestTasks} />}
      {!lgUp && !keyboardOpen && (
        <MobileDock
          runId={membership?.runId ?? null}
          mrCount={mrUrls.length}
          activePanel={mobileSheet}
          onSelect={(panel) => setMobileSheet(panel)}
        />
      )}
      {!lgUp && mobileSheet && (
        <MobileSheet
          panel={mobileSheet}
          conversationId={id}
          entries={commandEntries}
          mrUrls={mrUrls}
          runId={membership?.runId ?? null}
          wrap={wrap}
          onToggleWrap={toggleWrap}
          onJump={jumpToEvent}
          onClose={() => setMobileSheet(null)}
        />
      )}

      {/* Floating composer with the agent identity. On manager conversations
          the composer carries a cyan header strip — you are talking to the
          run's manager. */}
      <div className="shrink-0 px-3 pb-3 sm:px-6">
        <div
          className={`mx-auto max-w-3xl rounded-xl border bg-[var(--color-background-surface-canvas-secondary)] shadow-sm ${composerBorder}`}
          {...(isManager ? { "data-manager-composer": "true" } : {})}
          {...(planMode ? { "data-plan-mode": "true" } : {})}
        >
          {isManager && (
            <div className="flex items-center gap-1.5 rounded-t-[10px] bg-cyan-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-cyan-500">
              <span aria-hidden>🧭</span> Manager
            </div>
          )}
          <div className="p-2">
          <textarea
            ref={followUpRef}
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onPaste={attachments.onPaste}
            onKeyDown={(e) => {
              // Touch devices: Enter inserts a newline (mobile keyboards have
              // no Shift+Enter) — sending is the visible Send button's job.
              if (e.key === "Enter" && !e.shiftKey && !isCoarsePointer()) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={terminal ? "Send a follow-up (resumes the agent)…" : "Steer the agent…"}
            // 16px on touch devices: iOS Safari auto-zooms on focus of any
            // input under 16px, which wrecked the fixed-height layout.
            className="w-full resize-none border-0 bg-transparent p-2 text-sm focus:outline-none pointer-coarse:text-base"
            data-testid="openhands-followup"
          />
          <ImageChips state={attachments} />
          {/* Deliberately nowrap: with flex-wrap the model select pushes the
              Send group onto a second row (+43px), which is unaffordable when
              the keyboard leaves the column ~250px tall. Shrinking the select
              (min-w-0 below) is the better trade — it clips, it doesn't hide. */}
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 items-center gap-2">
              {/* Build ⇄ Plan segmented toggle — the Shift+Tab of this app.
                  Reflects the live upstream confirmation policy (not local
                  state), so it only flips once the switch actually landed. */}
              {conv && (
                <div
                  className="flex shrink-0 items-center overflow-hidden rounded-full border border-[var(--color-border-default)] text-[11px]"
                  role="group"
                  aria-label="Agent mode"
                  data-testid="composer-mode-toggle"
                  data-mode={mode}
                >
                  <button
                    type="button"
                    disabled={busy || mode === "build"}
                    onClick={() => void switchMode("build")}
                    className={`px-2 py-0.5 transition-colors pointer-coarse:px-3 pointer-coarse:py-2 ${
                      mode === "build"
                        ? "bg-[var(--color-background-element)] font-medium text-[var(--color-text-default)]"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
                    }`}
                    data-testid="composer-mode-build"
                    title="Build: the agent works unattended (edits files, runs commands)."
                  >
                    🔨 Build
                  </button>
                  <button
                    type="button"
                    disabled={busy || mode === "plan"}
                    onClick={() => void switchMode("plan")}
                    // Amber, matching the composer's plan-mode top border —
                    // the toggle and the border are the only plan signals left.
                    className={`px-2 py-0.5 transition-colors pointer-coarse:px-3 pointer-coarse:py-2 ${
                      mode === "plan"
                        ? "bg-amber-500/15 font-medium text-amber-700 dark:text-amber-400"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
                    }`}
                    data-testid="composer-mode-plan"
                    title="Plan: the agent researches read-only; write actions wait for your approval."
                  >
                    📋 Plan
                  </button>
                </div>
              )}
              {modelOptions.length > 1 ? (
                <select
                  value={selectedModel || model || ""}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  // 16px on touch: sub-16px selects trigger the same iOS
                  // focus zoom as text inputs.
                  className="min-w-0 rounded border border-[var(--color-border-default)] bg-transparent px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] pointer-coarse:py-1.5 pointer-coarse:text-base"
                  data-testid="openhands-model-select"
                  aria-label="AI model"
                  title="Model used from the next message on"
                >
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>
                  ))}
                </select>
              ) : model ? (
                <span className="truncate font-mono text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-model" title="LLM this conversation runs on">
                  {model}
                </span>
              ) : null}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <AttachImagesButton state={attachments} disabled={busy} />
              <Button size="sm" disabled={busy || !followUp.trim()} onClick={send}>
                Send
              </Button>
            </div>
          </div>
          </div>
        </div>
      </div>

      {!keyboardOpen && <StatusBar conversation={conv} />}
    </div>
  );
}
