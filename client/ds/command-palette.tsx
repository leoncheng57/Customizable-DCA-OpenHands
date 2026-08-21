// The app's first modal overlay and first ARIA listbox — the Cmd/Ctrl+K
// command palette. It lives in ds/ rather than components/ because it owns no
// domain data: it is handed a `Command[]` (built by lib/palette.ts) and reports
// a selection back. All ranking/labelling logic stays in lib/palette.ts so it
// is testable under vitest's node environment; everything here is DOM.
//
// Decisions worth knowing before editing:
//
// · Portal. The conversation page renders inside stacking contexts (the
//   resizable sidebar, the preview iframe wrapper), so an in-tree overlay
//   would be clipped. `createPortal` to <body> plus `z-[60]` clears the two
//   existing layers: the sticky navbar (`z-40`) and the sidebar's drag shield
//   (`z-50`, ConversationSidebar.tsx).
//
// · Flat ranked list, no group headers. When a query is active the ranking in
//   `rankCommands` cross-cuts kinds; bucketing the rows under headings would
//   visually contradict that order. Each row carries its own small group label
//   instead, and the listbox stays a flat set of options — which is also the
//   simplest correct ARIA shape.
//
// · Roving `aria-activedescendant`, not roving tabindex. Focus never leaves
//   the input (so typing keeps working while arrowing), and the active option
//   is announced via `aria-activedescendant` pointing at `Command.id`. That
//   makes command ids DOM ids — they must stay unique and space-free.
//
// · Focus trap. The dialog has exactly one tab stop (the input); options are
//   not focusable by design. So the trap is simply "Tab keeps you here", and
//   the previously focused element is restored on close.
import * as React from "react";
import { createPortal } from "react-dom";
import type { Command } from "../lib/palette.js";
import { cn } from "./utils.js";

export interface CommandPaletteProps {
  open: boolean;
  /** Close without running anything (Escape, backdrop, re-press of Cmd+K). */
  onClose: () => void;
  /** Already-ranked rows to render, in display order. */
  commands: Command[];
  /** Current query text; the palette is fully controlled. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Invoked with the chosen command; the host decides navigate-vs-run. */
  onSelect: (command: Command) => void;
  /** Optional footer note (e.g. "Loading conversations…"). */
  status?: string;
}

const LISTBOX_ID = "openhands-palette-listbox";

const CommandPalette = React.forwardRef<HTMLInputElement, CommandPaletteProps>(
  ({ open, onClose, commands, query, onQueryChange, onSelect, status }, ref) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const [active, setActive] = React.useState(0);

    React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

    // The result set changes on every keystroke; snapping back to the top row
    // is what every palette does and keeps Enter predictable.
    React.useEffect(() => {
      setActive(0);
    }, [query, commands.length]);

    // Focus the input on open and hand focus back to whatever had it on close.
    // Body scroll is locked so the page behind cannot move under the overlay.
    React.useEffect(() => {
      if (!open) return;
      const previous = document.activeElement as HTMLElement | null;
      inputRef.current?.focus();
      const overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = overflow;
        previous?.focus?.();
      };
    }, [open]);

    // Keep the active row visible when arrowing past the scroll edge.
    React.useEffect(() => {
      if (!open) return;
      const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
      el?.scrollIntoView({ block: "nearest" });
    }, [active, open, commands]);

    if (!open) return null;

    const activeCommand = commands[active];

    const move = (delta: number) => {
      if (commands.length === 0) return;
      // Wrap around: Down on the last row returns to the first.
      setActive((i) => (i + delta + commands.length) % commands.length);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          return;
        case "ArrowDown":
          e.preventDefault();
          move(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          return;
        case "Home":
          e.preventDefault();
          setActive(0);
          return;
        case "End":
          e.preventDefault();
          setActive(Math.max(0, commands.length - 1));
          return;
        case "Enter":
          e.preventDefault();
          if (activeCommand) onSelect(activeCommand);
          return;
        case "Tab":
          // Single tab stop — swallow Tab so focus cannot escape the dialog.
          e.preventDefault();
          inputRef.current?.focus();
          return;
        default:
      }
    };

    return createPortal(
      <div
        className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]"
        data-testid="openhands-command-palette"
      >
        {/* mousedown (not click) so a drag that starts on a row and ends on
            the backdrop does not close the palette mid-interaction. */}
        <div
          className="absolute inset-0 bg-[color-mix(in_oklab,var(--color-text-default)_45%,transparent)] backdrop-blur-[2px]"
          onMouseDown={onClose}
          aria-hidden
          data-testid="openhands-palette-backdrop"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className={cn(
            "relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl",
            "border border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-2xl",
          )}
          onKeyDown={onKeyDown}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeCommand?.id}
            aria-label="Search commands"
            placeholder="Search pages, docs and conversations…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className={cn(
              "w-full shrink-0 border-b border-[var(--color-border-default)] bg-transparent px-4 py-3",
              "text-sm text-[var(--color-text-default)] outline-none",
              "placeholder:text-[var(--color-text-subtle)]",
            )}
            data-testid="openhands-palette-input"
          />
          <div
            ref={listRef}
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Commands"
            className="min-h-0 flex-1 overflow-y-auto p-1"
          >
            {commands.length === 0 ? (
              <p
                className="px-3 py-6 text-center text-sm text-[var(--color-text-subtle)]"
                data-testid="openhands-palette-empty"
              >
                No matching commands
              </p>
            ) : (
              commands.map((command, i) => (
                <div
                  key={command.id}
                  id={command.id}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  data-kind={command.kind}
                  // Pointer selection mirrors keyboard selection: hovering
                  // moves the active row so Enter and click never disagree.
                  onMouseMove={() => setActive(i)}
                  onClick={() => onSelect(command)}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
                    i === active && "bg-[color-mix(in_oklab,var(--color-text-default)_8%,transparent)]",
                  )}
                  data-testid="openhands-palette-option"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--color-text-default)]">{command.title}</span>
                    {command.subtitle && (
                      <span className="block truncate text-xs text-[var(--color-text-subtle)]">{command.subtitle}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
                    {command.group}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="shrink-0 border-t border-[var(--color-border-default)] px-4 py-2 text-[11px] text-[var(--color-text-subtle)]">
            {status ?? "↑↓ to navigate · ↵ to open · esc to close"}
          </div>
        </div>
      </div>,
      document.body,
    );
  },
);
CommandPalette.displayName = "CommandPalette";

export { CommandPalette };
