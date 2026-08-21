// client/pages/Landing.tsx
//
// Hub page for the OpenHands app. The native frontend (BFF-backed) is
// always offered; the embedded upstream Agent Canvas card appears only when
// the wired instance exposes a public UI (status.publicUrl — e.g. a shared
// remote deployment). The local compose instance is headless, so the card is
// hidden there and the Native UI is the only frontend.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../ds/badge.js";
import { openHandsApi, type OpenHandsStatus } from "../lib/api.js";

export function LandingPage() {
  const [status, setStatus] = useState<OpenHandsStatus | null>(null);
  useEffect(() => {
    openHandsApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  const canvasUrl = status?.publicUrl ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">OpenHands</h1>
        <Badge variant="beta">beta</Badge>
      </div>

      <p className="max-w-3xl text-sm text-[var(--color-text-muted)]">
        An interactive, sandboxed coding agent — a shared remote instance when deployed, or a
        fully local container in local dev (<code>OPENHANDS_LOCAL=1</code>). Each
        conversation gets an isolated working directory on the same instance.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link
          to="/openhands/native"
          className="group rounded-lg border border-[var(--color-border-default)] p-5 transition-colors hover:border-[var(--color-border-focus)]"
          data-testid="openhands-card-native"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-base font-semibold">Native UI</span>
            <span className="rounded-full bg-[var(--color-background-surface-info-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-info)]">
              recommended
            </span>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">
            Themed conversations: searchable repo picker, readable transcript with
            collapsible tool activity, run/pause/steer. No extra sign-in —
            uses your local session.
          </p>
        </Link>

        {canvasUrl && (
          <a
            href={canvasUrl}
            target="_blank"
            rel="noreferrer"
            className="group rounded-lg border border-[var(--color-border-default)] p-5 transition-colors hover:border-[var(--color-border-focus)]"
            data-testid="openhands-card-canvas"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-base font-semibold">Agent Canvas</span>
              <span className="rounded-full bg-[var(--color-background-muted,rgba(127,127,127,0.12))] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                upstream
              </span>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">
              The full upstream OpenHands frontend (file browser, VS Code, settings), opened
              directly at <span className="underline">{canvasUrl.replace("https://", "")}</span>.
            </p>
          </a>
        )}
      </div>

      <div className="max-w-3xl rounded-lg border border-[var(--color-border-default)] p-4 text-sm">
        <div className="mb-2 font-medium">Read more</div>
        <ul className="list-disc space-y-1 pl-5 text-[var(--color-text-muted)]">
          <li><Link className="underline" to="/openhands/contributing">Contributing</Link> — architecture, docs, risk map, and how to extend or fork this app.</li>
          <li><Link className="underline" to="/openhands/notifications">Notifications</Link> — ntfy push, desktop notifications, and a browser chime on finish / error / stuck / awaiting input.</li>
          <li><Link className="underline" to="/openhands/manager-guide">Manager runs</Link> — parallel worker orchestration guide.</li>
        </ul>
      </div>
    </div>
  );
}
