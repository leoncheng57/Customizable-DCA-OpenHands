// client/components/ConversationSidebar.tsx
//
// Right sidebar of the native conversation view. A slim icon rail is ALWAYS
// visible (every width, expanded or collapsed) on the far right — clicking an
// inactive icon opens that panel, clicking the active icon collapses it. The
// expanded panel hosts the three conversation-scoped panels — Files, Changes,
// and the agent-commands audit trail — plus the transcript Wrap toggle and
// the shared-Terminal link in its header. Below lg the expanded panel overlays
// the transcript instead of squeezing it. The panel's left edge is a drag
// handle — width persists in localStorage (same pattern as the platform
// sidebar in design-system/sidebar.tsx).
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { CommandEntry } from "../lib/events.js";
import { FilesPage } from "../pages/Files.js";
import { ChangesPage } from "../pages/Changes.js";
import { CommandsPanel } from "./CommandSidebar.js";
import { MrPanel } from "./MrPanel.js";
import { RunPanel } from "./RunPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";

export type SidebarPanel = "files" | "changes" | "commands" | "mr" | "preview" | "run";

const FilesIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

const ChangesIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4" />
  </svg>
);

const CommandsIcon = <span className="font-mono text-xs" aria-hidden>$</span>;

const MrIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="18" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M6 21V9a9 9 0 0 0 9 9" />
  </svg>
);

const TerminalIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </svg>
);

const PreviewIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
  </svg>
);

const RunIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" />
    <path d="M12 7v4M12 11H5v6M12 11h7v6" />
  </svg>
);

export const SIDEBAR_PANELS: { key: SidebarPanel; label: string; shortLabel: string; icon: ReactNode }[] = [
  // "run" is only offered on conversations that belong to a manager run.
  { key: "run", label: "Run board", shortLabel: "Run", icon: RunIcon },
  { key: "files", label: "Files", shortLabel: "Files", icon: FilesIcon },
  { key: "changes", label: "Changes", shortLabel: "Diff", icon: ChangesIcon },
  { key: "preview", label: "Preview", shortLabel: "Preview", icon: PreviewIcon },
  { key: "commands", label: "Commands", shortLabel: "Cmds", icon: CommandsIcon },
  { key: "mr", label: "Merge requests", shortLabel: "MRs", icon: MrIcon },
];

/** Terminal-prompt glyph shared by the rail and the mobile dock. */
export const SIDEBAR_TERMINAL_ICON = TerminalIcon;

/**
 * Panel content shared between the desktop sidebar and the mobile bottom
 * sheet (MobileSheet.tsx) — one switch so the two hosts can't drift.
 */
export function SidebarPanelBody({
  panel,
  conversationId,
  entries,
  mrUrls,
  runId,
  onJump,
}: {
  panel: SidebarPanel;
  conversationId: string;
  entries: CommandEntry[];
  mrUrls: string[];
  runId: string | null;
  onJump: (eventId: string) => void;
}) {
  // Files re-mounts per panel switch, which re-fetches the tree — fine
  // for a read-only browser and keeps the page states independent.
  if (panel === "files") {
    return (
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
        <FilesPage conversation={conversationId} variant="sidebar" />
      </div>
    );
  }
  if (panel === "changes") return <ChangesPage conversation={conversationId} variant="sidebar" />;
  if (panel === "preview") return <PreviewPanel conversationId={conversationId} />;
  if (panel === "mr") return <MrPanel urls={mrUrls} />;
  if (panel === "run" && runId) return <RunPanel runId={runId} />;
  return <CommandsPanel entries={entries} conversationId={conversationId} onJump={onJump} />;
}

// Resizable panel width — default matches the previous fixed `w-96` (24rem).
// Growing (dragging left) is unbounded so the panel can take as much of the
// screen as the user wants; only a lower bound keeps the panel usable.
const WIDTH_STORAGE_KEY = "openhands.conversationSidebar.width";
const DEFAULT_WIDTH = 384;
const MIN_WIDTH = 320;

function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH, width);
}

function initialWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampWidth(stored);
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return DEFAULT_WIDTH;
}

export function ConversationSidebar({
  conversationId,
  panel,
  entries,
  mrUrls,
  runId = null,
  wrap,
  onToggleWrap,
  onJump,
  onSelectPanel,
  onCollapse,
}: {
  conversationId: string;
  /** Open panel, or null when collapsed to just the icon rail. */
  panel: SidebarPanel | null;
  entries: CommandEntry[];
  /** MR URLs detected in the transcript (drives the MR panel + rail badge). */
  mrUrls: string[];
  /** Manager run this conversation belongs to; enables the Run board panel. */
  runId?: string | null;
  /** Transcript output wrapping — the toggle lives in the panel header. */
  wrap: boolean;
  onToggleWrap: () => void;
  onJump: (eventId: string) => void;
  onSelectPanel: (panel: SidebarPanel) => void;
  onCollapse: () => void;
}) {
  const panels = SIDEBAR_PANELS.filter((p) => p.key !== "run" || runId);
  const effectivePanel = panel === "run" && !runId ? null : panel;
  const active = effectivePanel ? panels.find((p) => p.key === effectivePanel) ?? null : null;

  const [width, setWidth] = useState<number>(initialWidth);
  const [resizing, setResizing] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const startResize = useCallback(
    // Pointer events (not mouse events) so pen/trackpad drags work uniformly;
    // on touch devices the handle is hidden entirely (pointer-coarse:hidden) —
    // a 4px-wide drag strip is not a usable touch target (issue #28).
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragStart.current = { x: e.clientX, width };
      setResizing(true);
    },
    [width],
  );

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      // Panel sits on the right — dragging left grows it.
      setWidth(clampWidth(start.width + (start.x - e.clientX)));
    };
    const onUp = () => {
      setResizing(false);
      dragStart.current = null;
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_STORAGE_KEY, String(w));
        } catch {
          // Persistence is best-effort.
        }
        return w;
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [resizing]);

  return (
    // relative so the below-lg overlay panel can anchor to the rail's edge.
    <div className="relative flex shrink-0" data-testid="openhands-sidebar">
      {/* Full-screen shield while dragging — keeps mouse events away from the
          preview iframe (which would otherwise swallow them mid-drag) and
          holds the col-resize cursor + disables text selection. */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize select-none" data-testid="openhands-sidebar-resize-shield" />}
      {active && (
        <section
          className="absolute inset-y-0 right-full z-20 flex max-w-[85vw] flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-app)] shadow-xl lg:relative lg:inset-auto lg:right-auto lg:z-auto lg:max-w-none lg:shadow-none"
          style={{ width }}
          aria-label="Conversation sidebar"
          data-testid="openhands-conversation-sidebar"
          data-panel={active.key}
        >
          {/* Drag handle on the panel's left edge — hidden on touch devices. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize"
            onPointerDown={startResize}
            className={`absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize transition-colors hover:bg-[var(--color-border-focus,#3b82f6)]/50 pointer-coarse:hidden ${resizing ? "bg-[var(--color-border-focus,#3b82f6)]/50" : ""}`}
            data-testid="openhands-sidebar-resize-handle"
          />
          <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-default)]" data-testid="openhands-sidebar-title">
              {active.icon}
              {active.label}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={onToggleWrap}
                className={`rounded border px-2 py-0.5 text-[11px] transition-colors pointer-coarse:px-3 pointer-coarse:py-2 ${wrap ? "border-[var(--color-border-focus)] text-[var(--color-text-default)]" : "border-[var(--color-border-default)] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"}`}
                title={wrap ? "Output wraps — click for horizontal scrolling" : "Output scrolls horizontally — click to wrap"}
                aria-pressed={wrap}
                data-testid="openhands-wrap-toggle"
              >
                Wrap
              </button>
              {/* The upstream bash_events/search endpoint has no per-conversation
                  filter, so terminal history cannot be scoped — link to the
                  shared Terminal and label it as such. */}
              <Link
                to="/openhands/terminal"
                className="text-[11px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-default)]"
                data-testid="openhands-terminal-link"
              >
                Terminal (shared)
              </Link>
              <button
                onClick={onCollapse}
                className="rounded px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] pointer-coarse:px-3 pointer-coarse:py-2"
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                data-testid="openhands-sidebar-collapse"
              >
                »
              </button>
            </div>
          </div>

          <SidebarPanelBody
            panel={active.key}
            conversationId={conversationId}
            entries={entries}
            mrUrls={mrUrls}
            runId={runId ?? null}
            onJump={onJump}
          />
        </section>
      )}

      {/* Icon rail — always visible. Active icon collapses; inactive switches. */}
      <aside
        className="flex shrink-0 flex-col items-center gap-1 border-l border-[var(--color-border-default)] px-1 py-2"
        aria-label="Conversation sidebar rail"
        data-testid="openhands-sidebar-rail"
      >
        {panels.map((p) => {
          const isActive = panel === p.key;
          const badge = p.key === "mr" ? mrUrls.length : 0;
          return (
            <button
              key={p.key}
              onClick={() => (isActive ? onCollapse() : onSelectPanel(p.key))}
              className={`relative flex h-7 w-7 items-center justify-center rounded transition-colors pointer-coarse:h-10 pointer-coarse:w-10 ${
                isActive
                  ? "bg-[var(--color-background-muted,rgba(127,127,127,0.12))] text-[var(--color-text-default)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] hover:text-[var(--color-text-default)]"
              }`}
              title={isActive ? `Collapse ${p.label}` : `Open ${p.label}`}
              aria-label={isActive ? `Collapse ${p.label}` : `Open ${p.label}`}
              aria-pressed={isActive}
              data-testid={`openhands-sidebar-rail-${p.key}`}
            >
              {p.icon}
              {badge > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-border-focus,#3b82f6)] px-0.5 text-[8px] font-semibold leading-none text-white"
                  title={`${badge} merge/pull request${badge === 1 ? "" : "s"} detected`}
                  data-testid="openhands-sidebar-mr-badge"
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
        <Link
          to="/openhands/terminal"
          className="mt-auto flex h-7 w-7 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] hover:text-[var(--color-text-default)] pointer-coarse:h-10 pointer-coarse:w-10"
          title="Terminal (shared)"
          aria-label="Terminal (shared)"
          data-testid="openhands-sidebar-rail-terminal"
        >
          {TerminalIcon}
        </Link>
      </aside>
    </div>
  );
}
