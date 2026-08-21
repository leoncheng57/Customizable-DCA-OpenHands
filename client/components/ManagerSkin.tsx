// Manager-skin transcript decorations. The manager is a PLAIN OpenHands
// conversation; these components only change how its machine-protocol
// messages render:
//   - "TRIGGER: <kind>" user messages (monitor wakes)   -> compact separators
//   - "EXECUTOR RESULT..." user messages                -> one-line status rows
//   - ```manager-command fenced blocks in agent replies -> command cards
// All three formats are produced by our own server code, so prefix/fence
// matching is stable.

import React from "react";
import { LinkifiedText } from "../ds/markdown.js";
import type { TranscriptEvent } from "../lib/events.js";

export function isTriggerMessage(text: string): boolean {
  return text.startsWith("TRIGGER: ");
}

export function isExecutorMessage(text: string): boolean {
  return text.startsWith("EXECUTOR RESULT") || text.startsWith("PROMOTION:");
}

const COMMAND_FENCE_RE = /```manager-command\s*\n([\s\S]*?)```/g;

export function hasManagerCommand(text: string): boolean {
  return text.includes("```manager-command");
}

/** Split agent text into prose and command segments, in order. */
export function splitCommandSegments(
  text: string,
): Array<{ kind: "prose"; text: string } | { kind: "command"; raw: string }> {
  const segments: Array<{ kind: "prose"; text: string } | { kind: "command"; raw: string }> = [];
  let last = 0;
  for (const match of text.matchAll(COMMAND_FENCE_RE)) {
    const before = text.slice(last, match.index).trim();
    if (before) segments.push({ kind: "prose", text: before });
    segments.push({ kind: "command", raw: match[1].trim() });
    last = (match.index ?? 0) + match[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) segments.push({ kind: "prose", text: tail });
  return segments;
}

function commandSummary(raw: string): { name: string; detail: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = String(parsed.command ?? "unknown");
    if (name === "propose_plan") {
      const plan = parsed.plan as { waves?: Array<{ workers?: unknown[] }> } | undefined;
      const waves = plan?.waves?.length ?? 0;
      const workers = plan?.waves?.reduce((n, w) => n + (w.workers?.length ?? 0), 0) ?? 0;
      return { name, detail: `${waves} wave(s) · ${workers} worker(s)` };
    }
    if (name === "nudge_worker") {
      const modelPart = typeof parsed.model === "string" ? ` [model → ${parsed.model}]` : "";
      return { name, detail: `${String(parsed.task)}${modelPart}: ${String(parsed.message ?? "").slice(0, 80)}` };
    }
    if (name === "launch_wave") return { name, detail: `wave ${String(parsed.wave)}` };
    if (name === "inspect_worker") return { name, detail: `${String(parsed.task)} (${String(parsed.mode ?? "recent")})` };
    if (name === "request_human") return { name, detail: String(parsed.reason ?? "").slice(0, 100) };
    if (name === "complete_run") return { name, detail: String(parsed.summary ?? "").slice(0, 100) };
    return { name, detail: "" };
  } catch {
    return { name: "unparseable", detail: raw.slice(0, 80) };
  }
}

/** ⚡ compact separator for a monitor wake trigger. */
export function TriggerSeparator({ e }: { e: TranscriptEvent }) {
  const firstLine = e.text.split("\n", 1)[0]; // "TRIGGER: worker-blocked"
  const detail = e.text.split("\n")[1] ?? "";
  return (
    <div className="my-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]" data-kind="manager-trigger" data-testid="manager-trigger-separator">
      <span className="h-px flex-1 bg-[var(--color-border-default)]" />
      <span aria-hidden>⚡</span>
      <span className="font-medium">{firstLine.replace(/^TRIGGER: /, "trigger: ")}</span>
      {detail ? <span className="max-w-[50%] truncate">{detail}</span> : null}
      <span className="h-px flex-1 bg-[var(--color-border-default)]" />
    </div>
  );
}

/** One-line executor/system status row. */
export function ExecutorRow({ e }: { e: TranscriptEvent }) {
  const firstLine = e.text.split("\n", 1)[0];
  return (
    <div className="my-1.5 text-xs text-[var(--color-text-muted)]" data-kind="manager-executor" data-testid="manager-executor-row">
      <span aria-hidden>⚙ </span>
      {e.text.startsWith("PROMOTION:") ? "promoted to manager — briefing delivered" : firstLine}
    </div>
  );
}

/** Agent reply containing manager-command fences: prose + command cards. */
export function ManagerAgentMessage({ e }: { e: TranscriptEvent }) {
  const segments = splitCommandSegments(e.text);
  return (
    <div className="flex flex-col gap-2" data-kind="manager-agent">
      {segments.map((seg, i) =>
        seg.kind === "prose" ? (
          <div key={i} className="text-sm leading-relaxed">
            <pre className="whitespace-pre-wrap break-words font-sans">
              <LinkifiedText text={seg.text} />
            </pre>
          </div>
        ) : (
          <CommandCard key={i} raw={seg.raw} />
        ),
      )}
    </div>
  );
}

export function CommandCard({ raw }: { raw: string }) {
  const { name, detail } = commandSummary(raw);
  return (
    <div
      className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-secondary)] px-3 py-2"
      data-testid="manager-command-card"
    >
      <div className="flex items-center gap-2 text-xs">
        <span aria-hidden>⚙</span>
        <span className="font-mono font-semibold">{name}</span>
        <span className="truncate text-[var(--color-text-muted)]">{detail}</span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[10px] text-[var(--color-text-muted)]">raw command</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px]">{raw}</pre>
      </details>
    </div>
  );
}
