import { workspaceMode } from "../lib/workspace.js";

/**
 * Honest workspace-mode pill (issue #31, phase 1): shared original folder vs
 * isolated per-conversation workspace. The distinction matters — a shared
 * folder is the user's live checkout (editor, dev servers, and other
 * conversations see every change), while a sessions/ dir is disposable.
 */
export function WorkspaceModeBadge({
  workingDir,
  compact = false,
}: {
  workingDir: string | null | undefined;
  compact?: boolean;
}) {
  const mode = workspaceMode(workingDir);
  if (mode.kind === "unknown") return null;
  if (mode.kind === "local") {
    return (
      <span
        className="inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
        data-testid="workspace-mode-badge"
        data-mode="local"
        title={`Works directly in your project folder ${workingDir} — shared with your editor and any other conversation on this folder; changes (and branch switches) land live.`}
      >
        <span aria-hidden>📁</span>
        <span className="truncate">{mode.folder || "projects root"}</span>
        {!compact && <span className="font-medium">· shared folder</span>}
      </span>
    );
  }
  if (compact) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[var(--color-background-element)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
      data-testid="workspace-mode-badge"
      data-mode="session"
      title={`Isolated per-conversation workspace (${workingDir}) — nothing else touches it; your original folders are untouched.`}
    >
      <span aria-hidden>🗂️</span>
      isolated workspace
    </span>
  );
}
