// client/components/MobileSheet.tsx
//
// Phone-width replacement for the conversation sidebar (issue #28, mobile
// pass). Below lg the always-visible icon rail cost 36–48px of a ~375px
// viewport and its overlay panel was capped at 85vw with no dismiss
// affordance. Instead:
//
//  - MobileDock: a horizontal row of panel triggers docked above the
//    composer — the rail rotated 90°, full transcript width reclaimed.
//  - MobileSheet: the tapped panel opens as a full-screen bottom sheet with
//    a scrim. Dismiss = tap the scrim, the ✕ button, swipe the header down,
//    or the OS back gesture (the sheet pushes a history entry on open).
//
// Panel content is the same SidebarPanelBody the desktop sidebar renders,
// so the two hosts cannot drift.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { Link } from "react-router-dom";
import type { CommandEntry } from "../lib/events.js";
import {
  SIDEBAR_PANELS,
  SIDEBAR_TERMINAL_ICON,
  SidebarPanelBody,
  type SidebarPanel,
} from "./ConversationSidebar.js";

/** Swipe distance (px) past which releasing the header closes the sheet. */
const SWIPE_CLOSE_PX = 80;

export function MobileDock({
  runId,
  mrCount,
  activePanel,
  onSelect,
}: {
  runId: string | null;
  /** MR URLs detected in the transcript — drives the badge on the MRs icon. */
  mrCount: number;
  activePanel: SidebarPanel | null;
  onSelect: (panel: SidebarPanel) => void;
}) {
  const panels = SIDEBAR_PANELS.filter((p) => p.key !== "run" || runId);
  return (
    <div
      className="flex items-stretch justify-around gap-0.5 border-t border-[var(--color-border-default)] px-1"
      role="toolbar"
      aria-label="Conversation panels"
      data-testid="openhands-mobile-dock"
    >
      {panels.map((p) => {
        const isActive = activePanel === p.key;
        return (
          <button
            key={p.key}
            onClick={() => onSelect(p.key)}
            className={`relative flex min-h-12 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[9px] transition-colors ${
              isActive
                ? "text-[var(--color-text-default)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
            }`}
            aria-label={`Open ${p.label}`}
            aria-pressed={isActive}
            data-testid={`openhands-mobile-dock-${p.key}`}
          >
            {p.icon}
            <span>{p.shortLabel}</span>
            {p.key === "mr" && mrCount > 0 && (
              <span
                className="absolute right-1.5 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-border-focus,#3b82f6)] px-0.5 text-[8px] font-semibold leading-none text-white"
                title={`${mrCount} merge/pull request${mrCount === 1 ? "" : "s"} detected`}
              >
                {mrCount}
              </span>
            )}
          </button>
        );
      })}
      <Link
        to="/openhands/terminal"
        className="flex min-h-12 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[9px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
        aria-label="Terminal (shared)"
        data-testid="openhands-mobile-dock-terminal"
      >
        {SIDEBAR_TERMINAL_ICON}
        <span>Term</span>
      </Link>
    </div>
  );
}

export function MobileSheet({
  panel,
  conversationId,
  entries,
  mrUrls,
  runId,
  wrap,
  onToggleWrap,
  onJump,
  onClose,
}: {
  panel: SidebarPanel;
  conversationId: string;
  entries: CommandEntry[];
  mrUrls: string[];
  runId: string | null;
  wrap: boolean;
  onToggleWrap: () => void;
  onJump: (eventId: string) => void;
  onClose: () => void;
}) {
  const meta = SIDEBAR_PANELS.find((p) => p.key === panel);

  // OS back gesture closes the sheet: opening pushes ONE marker entry (the
  // guard makes it idempotent under React StrictMode's double-mount) and
  // popstate closes. UI closes (scrim / ✕ / swipe) go through history.back()
  // so the marker is consumed on the same path — Back never needs a second
  // press, and an in-app navigation on top is never undone.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!(window.history.state as { ohlSheet?: boolean } | null)?.ohlSheet) {
      window.history.pushState({ ohlSheet: true }, "");
    }
    const onPop = () => onCloseRef.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const close = useCallback(() => {
    if ((window.history.state as { ohlSheet?: boolean } | null)?.ohlSheet) window.history.back();
    else onCloseRef.current();
  }, []);

  // Body scroll can't move (the page behind is a fixed-height column), but
  // lock overscroll chaining anyway so rubber-banding inside the sheet never
  // scrolls the page.
  useEffect(() => {
    const prev = document.documentElement.style.overscrollBehavior;
    document.documentElement.style.overscrollBehavior = "contain";
    return () => {
      document.documentElement.style.overscrollBehavior = prev;
    };
  }, []);

  // Swipe-to-dismiss on the grab-handle/header region: the sheet follows the
  // finger down (never up) and closes past the threshold.
  const [dragY, setDragY] = useState(0);
  const touchStartY = useRef<number | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const start = touchStartY.current;
    if (start === null) return;
    const y = e.touches[0]?.clientY ?? start;
    setDragY(Math.max(0, y - start));
  };
  const onTouchEnd = () => {
    touchStartY.current = null;
    if (dragY > SWIPE_CLOSE_PX) close();
    else setDragY(0);
  };

  return (
    <>
      <div
        // inset-0 covers the layout viewport, which stays full-size behind a
        // shrunken visual viewport — so the scrim keeps covering the area the
        // keyboard occupies too.
        className="app-scrim-enter fixed inset-0 z-50 bg-black/40"
        onClick={close}
        aria-hidden
        data-testid="openhands-sheet-scrim"
      />
      <section
        // Sized to the VISUAL viewport, not the layout one: this is a fixed
        // element, so anchoring it to `bottom: 0` would put its footer behind
        // the software keyboard — and the Commands panel has a search input.
        // The shell never scrolls (100dvh, overflow-hidden), so the visual
        // viewport's top stays at 0 and only its height needs tracking.
        className={`fixed inset-x-0 z-50 flex flex-col rounded-t-2xl border-t border-[var(--color-border-default)] bg-[var(--color-background-app)] shadow-2xl ${dragY ? "" : "app-sheet-enter"}`}
        style={{
          top: "max(0.75rem, env(safe-area-inset-top))",
          height: "calc(var(--app-vvh, 100dvh) - max(0.75rem, env(safe-area-inset-top)))",
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragY ? "none" : "transform 200ms ease",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={meta?.label ?? "Conversation panel"}
        data-testid="openhands-mobile-sheet"
        data-panel={panel}
      >
        <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <div className="flex justify-center pt-2" aria-hidden>
            <span className="h-1 w-9 rounded-full bg-[var(--color-border-default)]" />
          </div>
          <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-1.5">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-[var(--color-text-default)]" data-testid="openhands-sheet-title">
              {meta?.icon}
              {meta?.label}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                onClick={onToggleWrap}
                className={`rounded border px-3 py-2 text-[11px] transition-colors ${wrap ? "border-[var(--color-border-focus)] text-[var(--color-text-default)]" : "border-[var(--color-border-default)] text-[var(--color-text-muted)]"}`}
                title={wrap ? "Output wraps — tap for horizontal scrolling" : "Output scrolls horizontally — tap to wrap"}
                aria-pressed={wrap}
                data-testid="openhands-sheet-wrap-toggle"
              >
                Wrap
              </button>
              <button
                onClick={close}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-base text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
                aria-label="Close panel"
                data-testid="openhands-sheet-close"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
        <SidebarPanelBody
          panel={panel}
          conversationId={conversationId}
          entries={entries}
          mrUrls={mrUrls}
          runId={runId}
          // Jumping to a transcript row only makes sense with the sheet gone.
          onJump={(eventId) => {
            close();
            onJump(eventId);
          }}
        />
        {/* Home-indicator inset inside the sheet so the last row stays tappable. */}
        <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" aria-hidden />
      </section>
    </>
  );
}
