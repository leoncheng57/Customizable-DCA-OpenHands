// client/components/PreviewPanel.tsx
//
// Live frontend preview panel for the native conversation view. Renders an app
// running inside the agent's workspace pod (e.g. `vite`) in a sandboxed
// iframe, reverse-proxied same-origin through the authenticated BFF. The
// default target is the STABLE path-based route
// (/api/openhands/conversations/:id/preview/app/*), backed by the
// conversation → port registration that Start (or the advanced manual port
// registration) writes; the legacy :port route remains as a fallback.
// Start/Stop drive the BFF lifecycle endpoints, a status dot polls
// /preview/status, and the logs drawer tails the detached process's output.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  openHandsApi,
  previewBase,
  previewUrl,
  type PreviewConfig,
  type PreviewStatus,
} from "../lib/api.js";

const PORT_STORAGE_KEY = "openhands.preview.port";
const STATUS_POLL_MS = 5_000;
const LOGS_POLL_MS = 5_000;
// After this many CONSECUTIVE status-poll failures the panel stops pretending:
// the colored dot is replaced by a "status unavailable — retrying" badge and
// the last-known status is visibly marked stale, so a dead poll (BFF down,
// upstream timeout) can never keep impersonating a healthy preview. A single
// blip still only shows the small "status check failing" note.
const STATUS_UNAVAILABLE_AFTER_FAILURES = 2;

/** Clamp a user-typed port to the configured range; null when unusable. */
function normalizePort(value: string, cfg: PreviewConfig | null): number | null {
  if (!value) return null;
  const port = Number(value);
  if (!Number.isInteger(port)) return null;
  const min = cfg?.portRange.min ?? 1024;
  const max = cfg?.portRange.max ?? 65_535;
  if (port < min || port > max) return null;
  return port;
}

/**
 * Fill the `{previewBase}`/`{previewPort}` placeholders in a run-command hint
 * with this conversation's stable path-based proxy mount and its derived
 * port, yielding a copy-paste-ready command: the proxy is path-preserving, so
 * the app must serve under that base.
 */
export function resolveRunCommand(template: string, conversationId: string, port: number): string {
  return template
    .replaceAll("{previewBase}", previewBase(conversationId))
    .replaceAll("{previewPort}", String(port));
}

const STATUS_LABEL: Record<PreviewStatus["status"], string> = {
  running: "Running",
  starting: "Starting…",
  exited: "Start failed",
  stopped: "Stopped",
  "workspace-missing": "Workspace expired",
};

const STATUS_DOT_CLASS: Record<PreviewStatus["status"], string> = {
  running: "bg-emerald-500",
  starting: "bg-amber-400 animate-pulse",
  exited: "bg-red-500",
  stopped: "bg-zinc-400",
  "workspace-missing": "bg-red-500",
};

// After this long in "starting", surface a hint pointing at the Logs drawer —
// a cold npm install legitimately takes minutes, but the user can't tell slow
// from stuck without it.
const SLOW_START_HINT_MS = 120_000;

/** Compact m:ss elapsed formatter for the starting indicator. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function PreviewPanel({ conversationId }: { conversationId: string }) {
  const [config, setConfig] = useState<PreviewConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Consecutive status-poll failures; reset by every successful poll.
  const [statusFailures, setStatusFailures] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  // The iframe URL once loaded (auto on running, or manual). null = empty state.
  const [src, setSrc] = useState<string | null>(null);
  // Bumped to force the iframe to reload the same URL on Refresh.
  const [reloadKey, setReloadKey] = useState(0);
  // True while the iframe document is loading — the proxied dev server can
  // take several seconds to answer the first request, during which the frame
  // is blank; this drives a spinner overlay so it doesn't look broken.
  const [iframeLoading, setIframeLoading] = useState(false);
  // Open by default: the log tail is the primary diagnostic for a starting or
  // crashed dev server (npm install progress, port conflicts), so it should be
  // visible without an extra click. Still collapsible once running.
  const [logsOpen, setLogsOpen] = useState(true);
  const [logs, setLogs] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [portInput, setPortInput] = useState<string>(() => localStorage.getItem(PORT_STORAGE_KEY) ?? "");
  // Wall-clock start of the current "starting" phase — drives the elapsed
  // readout and the slow-start hint so a minutes-long npm install doesn't
  // look identical to a wedged preview. null outside the starting state.
  const [startingSince, setStartingSince] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prevStatusRef = useRef<PreviewStatus["status"] | null>(null);

  // Every (re)load of the iframe — fresh src or a reloadKey bump — starts a
  // new document fetch, so show the spinner until the frame's load event.
  useEffect(() => {
    if (src) setIframeLoading(true);
  }, [src, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    openHandsApi
      .previewConfig()
      .then((cfg) => {
        if (!cancelled) setConfig(cfg);
      })
      .catch((err: unknown) => {
        if (!cancelled) setConfigError(err instanceof Error ? err.message : "Failed to load preview config");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live status: poll while the panel is open; auto-load the iframe on the
  // transition to running so Load-guessing is no longer needed. Bumping
  // `pollNonce` restarts the loop for an immediate re-poll (Reload button).
  const [pollNonce, setPollNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await openHandsApi.previewStatus(conversationId);
        if (cancelled) return;
        setStatus(next);
        setStatusError(null);
        setStatusFailures(0);
        if (next.status === "running" && prevStatusRef.current !== "running") {
          setSrc(previewUrl(conversationId));
          setReloadKey((k) => k + 1);
        }
        if (next.status === "starting") {
          setStartingSince((since) => since ?? Date.now());
        } else {
          setStartingSince(null);
        }
        prevStatusRef.current = next.status;
      } catch (err: unknown) {
        if (!cancelled) {
          setStatusError(err instanceof Error ? err.message : "Failed to load preview status");
          setStatusFailures((n) => n + 1);
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, STATUS_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, pollNonce]);

  const refreshLogs = useCallback(() => {
    openHandsApi
      .previewLogs(conversationId)
      .then((r) => setLogs(r.log || "(log file is empty)"))
      .catch((err: unknown) => setLogs(err instanceof Error ? `Failed to load logs: ${err.message}` : "Failed to load logs"));
  }, [conversationId]);

  // Auto-refresh while the drawer is open so a starting dev server's output
  // (npm install progress, vite ready line, port conflicts) streams in without
  // hammering the Refresh button.
  useEffect(() => {
    if (!logsOpen) return;
    refreshLogs();
    const timer = setInterval(refreshLogs, LOGS_POLL_MS);
    return () => clearInterval(timer);
  }, [logsOpen, refreshLogs]);

  const start = async () => {
    setBusy("start");
    setActionError(null);
    try {
      await openHandsApi.previewStart(conversationId);
      setStatus((s) => (s ? { ...s, status: "starting" } : s));
      setStartingSince(Date.now());
      prevStatusRef.current = "starting";
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to start the preview");
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy("stop");
    setActionError(null);
    try {
      await openHandsApi.previewStop(conversationId);
      setStatus((s) => (s ? { ...s, status: "stopped" } : s));
      prevStatusRef.current = "stopped";
      setSrc(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to stop the preview");
    } finally {
      setBusy(null);
    }
  };

  // One-click Reload: re-poll the status immediately (no 5s wait), reload the
  // iframe (only loading it fresh when the server actually answers), and
  // refresh the logs drawer if it is open.
  const reload = () => {
    if (!src && status?.status === "running") setSrc(previewUrl(conversationId));
    setReloadKey((k) => k + 1);
    setPollNonce((n) => n + 1);
    if (logsOpen) refreshLogs();
  };

  // Advanced manual fallback: register a port the user started themselves so
  // the stable /preview/app path serves it (and legacy :port URLs still work).
  const manualPort = useMemo(() => normalizePort(portInput, config), [portInput, config]);
  const loadManualPort = async () => {
    if (manualPort === null) return;
    localStorage.setItem(PORT_STORAGE_KEY, String(manualPort));
    setActionError(null);
    try {
      await openHandsApi.previewSetTarget(conversationId, manualPort);
      setSrc(previewUrl(conversationId));
    } catch {
      // Registration failed (e.g. pod unreachable) — fall back to the legacy
      // direct :port proxy URL so the manual path still works.
      setSrc(previewUrl(conversationId, manualPort));
    }
    setReloadKey((k) => k + 1);
  };

  // 1s ticker while starting so the elapsed readout counts up smoothly
  // between the 5s status polls.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (startingSince === null) return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startingSince]);

  const hint = config?.repos[0];
  const statusKind = status?.status ?? null;
  const statusUnavailable = statusFailures >= STATUS_UNAVAILABLE_AFTER_FAILURES;
  const disabled = !config?.enabled;
  const startingElapsedMs = statusKind === "starting" && startingSince !== null ? Math.max(0, nowTick - startingSince) : null;
  const slowStart = startingElapsedMs !== null && startingElapsedMs >= SLOW_START_HINT_MS;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="openhands-preview-panel">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-preview-status">
          {statusUnavailable ? (
            // The poll is dead (repeated failures): replace the colored dot
            // with an explicit badge so the stale state can't pass as live.
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-500 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
              role="status"
              title={statusError ?? "The preview status poll keeps failing"}
              data-testid="openhands-preview-status-unavailable"
            >
              status unavailable — retrying
            </span>
          ) : (
            <span
              className={`inline-block h-2 w-2 rounded-full ${statusKind ? STATUS_DOT_CLASS[statusKind] : "bg-zinc-300"}`}
              data-testid="openhands-preview-status-dot"
              data-status={statusKind ?? "unknown"}
            />
          )}
          <span
            className={statusUnavailable ? "opacity-50" : ""}
            {...(statusUnavailable ? { "data-stale": "true" } : {})}
          >
            {statusKind ? STATUS_LABEL[statusKind] : "…"}
            {statusUnavailable && statusKind ? " (stale)" : ""}
          </span>
          {startingElapsedMs !== null && (
            <span className="tabular-nums" title="Time since the dev server was started" data-testid="openhands-preview-starting-elapsed">
              ({formatElapsed(startingElapsedMs)})
            </span>
          )}
          {status && (
            <span className="tabular-nums" title="Derived per-conversation preview port">
              :{status.port}
            </span>
          )}
          {statusError && status && !statusUnavailable && (
            <span
              className="text-[10px] text-[var(--color-text-danger,#dc2626)]"
              title={statusError}
              data-testid="openhands-preview-status-stale"
            >
              status check failing
            </span>
          )}
        </span>
        <button
          onClick={() => void start()}
          disabled={disabled || busy !== null || statusKind === "starting"}
          className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-default)] transition-colors hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] disabled:opacity-50"
          title="Start (or restart) the dev server inside the session workspace"
          data-testid="openhands-preview-start"
        >
          {busy === "start" ? "Starting…" : statusKind === "running" ? "Restart" : "Start"}
        </button>
        <button
          onClick={() => void stop()}
          disabled={disabled || busy !== null || statusKind === "stopped" || statusKind === "workspace-missing"}
          className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-default)] disabled:opacity-50"
          title="Stop the dev server (kills the recorded process group)"
          data-testid="openhands-preview-stop"
        >
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
        <button
          onClick={reload}
          disabled={disabled}
          className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-default)] disabled:opacity-50"
          title="Reload the preview: re-check the status now, reload the iframe, refresh open logs"
          data-testid="openhands-preview-reload"
        >
          ↻ Reload
        </button>
        <button
          onClick={() => setLogsOpen((open) => !open)}
          className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-default)]"
          data-testid="openhands-preview-logs-toggle"
        >
          {logsOpen ? "Hide logs" : "Logs"}
        </button>
        <a
          href={previewUrl(conversationId)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-[11px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-default)]"
          title="Stable per-conversation preview URL"
          data-testid="openhands-preview-newtab"
        >
          Open in new tab ↗
        </a>
      </div>

      {/* Errors / disabled notices */}
      {configError && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-danger,#dc2626)]" data-testid="openhands-preview-config-error">
          {configError}
        </div>
      )}
      {actionError && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-danger,#dc2626)]" data-testid="openhands-preview-action-error">
          {actionError}
        </div>
      )}
      {statusError && !status && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-preview-status-error">
          {statusError}
        </div>
      )}
      {config && !config.enabled && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-preview-disabled">
          Live preview is not wired up on this deployment. Set{" "}
          <code className="font-mono">OPENHANDS_PREVIEW_ORIGIN</code> (or expose the preview port on the agent service) to enable it.
        </div>
      )}
      {slowStart && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-preview-slow-start">
          Still starting — a cold <code className="font-mono">npm install</code> can take a few
          minutes in the workspace pod. Open <strong>Logs</strong> to watch its progress; if the log
          shows the dev server is already listening, the deployment may be missing{" "}
          <code className="font-mono">OPENHANDS_PREVIEW_ORIGIN</code> (the hub can't reach the
          preview port to confirm it's up).
        </div>
      )}
      {statusKind === "exited" && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-danger,#dc2626)]" data-testid="openhands-preview-exited">
          The dev server exited before it became reachable — usually a failed{" "}
          <code className="font-mono">npm install</code> or a port conflict. Check{" "}
          <strong>Logs</strong> for the error, then press <strong>Start</strong> to retry.
        </div>
      )}
      {statusKind === "workspace-missing" && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text-danger,#dc2626)]" data-testid="openhands-preview-workspace-missing">
          Workspace expired — agent workspaces are pruned after 2h of inactivity on the shared
          instance, which stops the dev server. Resume the conversation to recreate the workspace,
          then press <strong>Start</strong> again to relaunch the preview.
        </div>
      )}

      {/* Logs drawer */}
      {logsOpen && (
        <div className="flex max-h-48 min-h-0 flex-col border-b border-[var(--color-border-default)]" data-testid="openhands-preview-logs">
          <div className="flex items-center justify-between px-3 py-1">
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Preview logs (last 200 lines)</span>
            <button
              onClick={refreshLogs}
              className="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-default)]"
              data-testid="openhands-preview-logs-refresh"
            >
              Refresh logs
            </button>
          </div>
          <pre className="thin-scrollbar min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[10px] text-[var(--color-text-default)]" data-testid="openhands-preview-logs-content">
            {logs ?? "Loading…"}
          </pre>
        </div>
      )}

      {/* Body */}
      {src ? (
        <div className="relative min-h-0 flex-1">
          {iframeLoading && (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--color-background-app)]"
              data-testid="openhands-preview-loading"
            >
              <span
                className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-border-focus,#3b82f6)]"
                aria-hidden
              />
              <span className="text-[11px] text-[var(--color-text-muted)]" role="status">
                Loading preview — the dev server can take a few seconds to answer…
              </span>
            </div>
          )}
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={src}
            title="Agent workspace preview"
            onLoad={() => setIframeLoading(false)}
            // allow-same-origin lets the app load its own relative assets/scripts;
            // the frame is still a separate document proxied through the hub gate.
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            className="h-full w-full border-0 bg-white"
            data-testid="openhands-preview-iframe"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-[12px] text-[var(--color-text-muted)]" data-testid="openhands-preview-empty">
          <p>
            Preview the frontend the agent is building. Press <strong>Start</strong> to launch the
            dev server inside the session workspace on this conversation's own derived port — the
            preview loads automatically once it answers. Stop/Start round-trips cleanly; agent
            workspaces are pruned after 2h of inactivity on the shared instance, which also stops
            the dev server.
          </p>
          {hint && status && (
            <div className="rounded border border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.06))] p-2">
              <div className="mb-1 text-[11px] font-medium text-[var(--color-text-default)]">{hint.label} — or run it yourself:</div>
              <pre className="thin-scrollbar overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-text-default)]" data-testid="openhands-preview-runcommand">{resolveRunCommand(hint.runCommand, conversationId, status.port)}</pre>
              <div className="mt-1 text-[10px]">
                Derived port {status.port} · served under the stable path{" "}
                <code className="font-mono">{previewBase(conversationId)}</code>
              </div>
            </div>
          )}
          <div>
            <button
              onClick={() => setAdvancedOpen((open) => !open)}
              className="text-[11px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-default)]"
              data-testid="openhands-preview-advanced-toggle"
            >
              {advancedOpen ? "Hide advanced" : "Advanced: preview a manually-started port"}
            </button>
            {advancedOpen && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px]">
                  Port
                  <input
                    type="number"
                    inputMode="numeric"
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void loadManualPort();
                    }}
                    className="w-20 rounded border border-[var(--color-border-default)] bg-[var(--color-background-app)] px-2 py-0.5 text-[12px] tabular-nums text-[var(--color-text-default)]"
                    placeholder={status ? String(status.port) : "20000"}
                    data-testid="openhands-preview-port"
                  />
                </label>
                <button
                  onClick={() => void loadManualPort()}
                  disabled={manualPort === null}
                  className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-default)] transition-colors hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] disabled:opacity-50"
                  data-testid="openhands-preview-load"
                >
                  Load
                </button>
                <span className="text-[10px]">Registers the port for this conversation's stable preview URL.</span>
              </div>
            )}
          </div>
          <p className="text-[10px]">
            Note: the preview reflects whatever is listening on this conversation's registered port
            in the shared, single-tenant workspace pod. The app's root-absolute{" "}
            <code className="font-mono">/api</code> calls run same-origin against this hub with{" "}
            <em>your</em> session. HMR/live reload is not proxied — use Refresh after changes.
          </p>
        </div>
      )}
    </div>
  );
}
