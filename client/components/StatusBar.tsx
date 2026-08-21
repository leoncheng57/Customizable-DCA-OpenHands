import { useEffect, useRef } from "react";
import {
  contextTone,
  deriveStatusBar,
  formatCost,
  formatPercent,
  formatTokens,
  type StatusBarSource,
} from "../lib/statusBar.js";

const TONE_CLASS: Record<string, string> = {
  normal: "text-[var(--color-text-muted)]",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

const GAUGE_CLASS: Record<string, string> = {
  normal: "bg-[var(--color-text-muted)]",
  warn: "bg-amber-500",
  danger: "bg-red-500",
};

function Gauge({ pct, tone }: { pct: number; tone: string }) {
  return (
    <span
      className="inline-block h-1.5 w-10 overflow-hidden rounded-full bg-[var(--color-background-element,rgba(127,127,127,0.2))]"
      aria-hidden
    >
      <span
        className={`block h-full rounded-full ${GAUGE_CLASS[tone]}`}
        style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
      />
    </span>
  );
}

/**
 * Slim bottom status bar, opencode-style (issue #43): where the agent works,
 * how full its context window is, and what the session has cost so far. All
 * three answer questions asked mid-run ("is it about to forget?", "how much
 * am I spending?"), so they live pinned under the composer rather than in a
 * panel that has to be opened.
 */
export function StatusBar({ conversation }: { conversation: StatusBarSource | null | undefined }) {
  const info = deriveStatusBar(conversation);
  // When the path cell is too narrow for the whole path, show its END. The
  // tail (worktree or session folder) is what distinguishes two checkouts;
  // the shared `/home/openhands/workspace/...` prefix distinguishes nothing.
  // On a desktop track the path fits, scrollWidth === clientWidth, and this
  // is a no-op.
  const pathRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = pathRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [info.workingDir]);
  const tone = contextTone(info.contextPct);
  const pct = formatPercent(info.contextPct);
  const cost = formatCost(info.cost);
  const tokens = formatTokens(info.contextTokens);
  const window = formatTokens(info.contextWindow);

  return (
    // shrink-0: the bar is pinned under the composer inside the conversation's
    // flex column, so it must never be squeezed by a tall transcript. Gutters
    // match the composer's (px-3 sm:px-6) so the max-w-3xl track lines up with
    // the composer above it rather than floating on a wider rail.
    <div
      // pb carries the iOS home-indicator inset (viewport-fit=cover): this bar
      // is the bottom-most element of the column, so it owns the safe area.
      className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-background-surface-canvas-secondary)] px-3 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:px-6"
      data-testid="openhands-status-bar"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-4 font-mono text-[11px] text-[var(--color-text-muted)]">
        {info.workingDir ? (
          // The whole path, not the basename: sibling worktrees and session
          // checkouts share a folder name, so the basename alone cannot answer
          // "which copy of the repo is this agent editing?".
          //
          // Scrolled, not truncated and not wrapped. `truncate` destroys the
          // tail, which is the part that actually distinguishes two worktrees.
          // Wrapping keeps every character but costs height: at 390px the
          // path only gets ~74px of the row, so it wraps to seven lines and
          // the "slim status bar" becomes a paragraph. A nowrap cell that
          // scrolls keeps the bar one line tall at every width, keeps the full
          // string selectable and copyable, and needs no scrolling at all on
          // a desktop track, where it fits outright.
          <span
            ref={pathRef}
            className="thin-scrollbar min-w-0 overflow-x-auto whitespace-nowrap"
            data-testid="status-bar-folder"
            title={info.workingDir}
          >
            <span aria-hidden className="mr-1">📁</span>
            {info.workingDir}
          </span>
        ) : (
          <span className="opacity-60">no workspace</span>
        )}
        {/* Gauges pushed right with ml-auto rather than a flex-1 spacer
            element: a spacer is a third flex child, and the gap it adds is
            charged to the only shrinkable cell — the path — which is enough
            to start clipping it on a desktop track where it otherwise fits. */}
        <span className="ml-auto flex shrink-0 items-center gap-4">
          {pct && (
            <span
              className={`flex shrink-0 items-center gap-1.5 ${TONE_CLASS[tone]}`}
              data-testid="status-bar-context"
              data-tone={tone}
              title={`Last turn used ${info.contextTokens?.toLocaleString()} of ${info.contextWindow?.toLocaleString()} context tokens${info.contextModel ? ` (${info.contextModel})` : ""}`}
            >
              <Gauge pct={info.contextPct ?? 0} tone={tone} />
              {pct} context
              {tokens && window && <span className="opacity-70">({tokens}/{window})</span>}
            </span>
          )}
          {cost && (
            <span className="shrink-0 tabular-nums" data-testid="status-bar-cost" title="Estimated LLM spend for this conversation">
              {cost}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
