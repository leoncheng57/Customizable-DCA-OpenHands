// Demo-mode disclosure strip.
//
// Rendered by `Shell` in main.tsx only when `import.meta.env.VITE_DEMO` is set
// — i.e. on the GitHub Pages build, where `client/mock/` answers every
// `/api/openhands` request and there is no agent, no container and no
// workspace behind the UI.
//
// It sits as the first child of the shell's viewport-tall flex column rather
// than `position: fixed`, so it is pinned to the top of the viewport and
// physically pushes the sticky navbar down: no overlap is possible, whatever
// the banner wraps to on a narrow screen.
//
// Tone: warning, from the semantic token set only (docs/design-system.md) —
// this file must survive a theme change without edits.
import { FlaskConical } from "lucide-react";
import { REPO_URL } from "../lib/docs.js";

export function DemoBanner() {
  return (
    <div
      role="status"
      data-testid="openhands-demo-banner"
      className="shrink-0 border-b border-[var(--color-border-surface-warning)] bg-[var(--color-background-surface-warning-muted)] px-3 py-1.5 text-[var(--color-text-warning)]"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-[12px] leading-snug">
        <FlaskConical size={13} strokeWidth={2.2} className="shrink-0" aria-hidden />
        <span className="font-semibold">Interactive demo</span>
        <span aria-hidden className="opacity-40">
          ·
        </span>
        <span>
          Every screen is a simulation running on invented data. No agent is running, nothing is
          being edited, and no request leaves your browser.
        </span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="font-semibold underline underline-offset-2 hover:opacity-80"
        >
          Run the real thing →
        </a>
      </div>
    </div>
  );
}
