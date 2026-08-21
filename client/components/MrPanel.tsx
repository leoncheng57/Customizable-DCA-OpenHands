// client/components/MrPanel.tsx
//
// "Merge requests" panel of the conversation sidebar: one card per MR/PR the
// agent linked in the transcript (detected client-side by extractMrUrls),
// showing live GitLab/GitHub state — title, pipeline status, and a merge
// button — so a session's MRs can be reviewed and merged without leaving the
// hub.
// Each card also offers three collapsed-by-default sections: the MR
// description, the discussion comments, and a per-stage pipeline breakdown
// (the latter two fetched lazily on first expand, then kept fresh on the
// same ~10s cadence as the card itself while expanded).
// Handles multiple MRs per session; state refreshes ~every 10s while open.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Markdown } from "../ds/markdown.js";
import { formatRelativeTime } from "../lib/time.js";
import { openHandsApi, type MrComment, type MrInfo, type MrPipelineProgress } from "../lib/api.js";

const REFRESH_MS = 10_000;

/** Pipeline badge styling per GitLab pipeline status. */
const PIPELINE_TONE: Record<string, string> = {
  success: "border-[var(--color-text-success,#22c55e)] text-[var(--color-text-success,#22c55e)]",
  failed: "border-[var(--color-text-critical)] text-[var(--color-text-critical)]",
  running: "border-blue-400 text-blue-400",
  pending: "border-amber-400 text-amber-400",
  canceled: "border-[var(--color-border-default)] text-[var(--color-text-muted)]",
};

const STATE_LABEL: Record<string, string> = {
  merged: "Merged",
  closed: "Closed",
  locked: "Locked",
};

type CardState = {
  info: MrInfo | null;
  error: string | null;
};

/** Job/stage status glyphs — same ok/error/pending conventions as CommandSidebar. */
const JOB_GLYPH: Record<string, { glyph: string; cls: string }> = {
  success: { glyph: "\u2714", cls: "text-[var(--color-text-success,#22c55e)]" },
  failed: { glyph: "\u2718", cls: "text-[var(--color-text-critical)]" },
  running: { glyph: "\u27F3", cls: "text-blue-400 animate-pulse" },
  pending: { glyph: "\u27F3", cls: "text-amber-400" },
  created: { glyph: "\u27F3", cls: "text-amber-400" },
};
const JOB_GLYPH_DEFAULT = { glyph: "\u25CB", cls: "text-[var(--color-text-muted)]" };

/** "42s" / "3m 05s" from GitLab's duration-in-seconds; "" when not run yet. */
function formatJobDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${String(rem).padStart(2, "0")}s`;
}

/** "2m ago" for recent comments, local date once relative stops being useful. */
function commentTime(timestamp: string): string {
  const relative = formatRelativeTime(timestamp);
  if (relative) return relative;
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** Collapsible card section: chevron header, children rendered while open. */
function Section({ title, testId, open, onToggle, children }: {
  title: string;
  testId: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="mt-2 border-t border-[var(--color-border-default)] pt-1.5"
      data-testid={testId}
      data-open={open}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 text-left text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
      >
        <span className="w-3 text-center" aria-hidden>{open ? "\u25BE" : "\u25B8"}</span>
        {title}
      </button>
      {open && <div className="mt-1.5 pl-4">{children}</div>}
    </div>
  );
}

function DescriptionSection({ description }: { description: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Description" testId="openhands-mr-description" open={open} onToggle={() => setOpen((v) => !v)}>
      {description.trim() ? (
        <Markdown source={description} untrusted className="text-xs" />
      ) : (
        <div className="text-[11px] text-[var(--color-text-muted)]">No description</div>
      )}
    </Section>
  );
}

function CommentsSection({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<MrComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy: nothing is fetched until the section is first expanded; while
  // expanded, refresh on the same cadence as the card itself.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { items } = await openHandsApi.getMrComments(url);
        if (!cancelled) {
          setComments(items);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, url]);

  const title = comments === null ? "Comments" : `Comments (${comments.length})`;
  return (
    <Section title={title} testId="openhands-mr-comments" open={open} onToggle={() => setOpen((v) => !v)}>
      {comments === null ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">{error ?? "Loading…"}</div>
      ) : comments.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">No comments yet</div>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} data-testid="openhands-mr-comment">
              <div className="flex items-baseline gap-1.5 text-[11px]">
                <span className="font-medium">{c.author}</span>
                <span className="text-[var(--color-text-muted)]">{commentTime(c.createdAt)}</span>
                {c.resolved && <span className="text-[10px] text-[var(--color-text-muted)]">resolved</span>}
              </div>
              <Markdown source={c.body} untrusted className="mt-0.5 text-xs" />
            </li>
          ))}
        </ul>
      )}
      {comments !== null && error && (
        <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">Refresh failed: {error}</div>
      )}
    </Section>
  );
}

function PipelineSection({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  // undefined = not fetched yet; null = fetched, no pipeline has run.
  const [progress, setProgress] = useState<MrPipelineProgress | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await openHandsApi.getMrPipeline(url);
        if (!cancelled) {
          setProgress(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, url]);

  return (
    <Section title="Pipeline progress" testId="openhands-mr-pipeline-progress" open={open} onToggle={() => setOpen((v) => !v)}>
      {progress === undefined ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">{error ?? "Loading…"}</div>
      ) : progress === null ? (
        <div className="text-[11px] text-[var(--color-text-muted)]">No pipeline or checks have run yet.</div>
      ) : (
        <ul className="space-y-1.5">
          {progress.stages.map((stage) => (
            <li key={stage.name} data-testid="openhands-mr-pipeline-stage" data-status={stage.status}>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className={JOB_GLYPH[stage.status]?.cls ?? JOB_GLYPH_DEFAULT.cls} title={stage.status} aria-hidden>
                  {JOB_GLYPH[stage.status]?.glyph ?? JOB_GLYPH_DEFAULT.glyph}
                </span>
                <span className="font-medium">{stage.name}</span>
                <span className="text-[var(--color-text-muted)]">{stage.status}</span>
              </div>
              <ul className="mt-0.5 space-y-0.5 pl-4">
                {stage.jobs.map((job) => {
                  const glyph = JOB_GLYPH[job.status] ?? JOB_GLYPH_DEFAULT;
                  const duration = formatJobDuration(job.duration);
                  const row = (
                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                      <span className={glyph.cls} title={job.status} aria-hidden>{glyph.glyph}</span>
                      <span className="truncate">{job.name}</span>
                      {duration && <span className="ml-auto shrink-0 text-[10px]">{duration}</span>}
                    </span>
                  );
                  return (
                    <li key={`${job.name}-${job.webUrl}`} data-testid="openhands-mr-pipeline-job" data-status={job.status}>
                      {job.webUrl ? (
                        <a href={job.webUrl} target="_blank" rel="noreferrer" className="block hover:underline" title={`Open job (${job.status})`}>
                          {row}
                        </a>
                      ) : (
                        row
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {progress !== undefined && error && (
        <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">Refresh failed: {error}</div>
      )}
    </Section>
  );
}

function PipelineBadge({ pipeline }: { pipeline: MrInfo["pipeline"] }) {
  if (!pipeline) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
        data-testid="openhands-mr-pipeline"
        data-status="none"
      >
        no pipeline
      </span>
    );
  }
  const tone = PIPELINE_TONE[pipeline.status] ?? "border-[var(--color-border-default)] text-[var(--color-text-muted)]";
  const badge = (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${tone}`}
      data-testid="openhands-mr-pipeline"
      data-status={pipeline.status}
    >
      {pipeline.status === "running" && <span className="animate-pulse" aria-hidden>●</span>}
      pipeline: {pipeline.status}
    </span>
  );
  if (!pipeline.webUrl) return badge;
  return (
    <a href={pipeline.webUrl} target="_blank" rel="noreferrer" title="Open pipeline">
      {badge}
    </a>
  );
}

function MrCard({ url, state, onMerged }: {
  url: string;
  state: CardState;
  onMerged: (url: string, info: MrInfo) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const info = state.info;
  const isGitHub = /^https?:\/\/github\.com\//.test(url);
  const host = isGitHub ? "GitHub" : "GitLab";
  const refPrefix = isGitHub ? "#" : "!";

  const merge = async () => {
    setMerging(true);
    setMergeError(null);
    try {
      const updated = await openHandsApi.mergeMr(url);
      onMerged(url, updated);
      setConfirming(false);
    } catch (e) {
      setMergeError((e as Error).message);
    } finally {
      setMerging(false);
    }
  };

  return (
    <li
      className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.06))] p-3"
      data-testid="openhands-mr-card"
      data-state={info?.state ?? (state.error ? "error" : "loading")}
    >
      {info ? (
        <>
          <a
            href={info.webUrl || url}
            target="_blank"
            rel="noreferrer"
            className="block hover:underline"
            title={isGitHub ? "Open pull request on GitHub" : "Open merge request in GitLab"}
            data-testid="openhands-mr-link"
          >
            <span className="block text-sm font-medium leading-snug">
              {info.title || `${isGitHub ? "Pull request" : "Merge request"} ${refPrefix}${info.iid}`}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
              {refPrefix}{info.iid} · {info.projectPath}
            </span>
          </a>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PipelineBadge pipeline={info.pipeline} />
            {info.state !== "opened" ? (
              <span
                className={`ml-auto text-[11px] font-medium ${info.state === "merged" ? "text-[var(--color-text-success,#22c55e)]" : "text-[var(--color-text-muted)]"}`}
                data-testid="openhands-mr-state"
              >
                {STATE_LABEL[info.state] ?? info.state}
              </span>
            ) : confirming ? (
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => void merge()}
                  disabled={merging}
                  className="rounded border border-[var(--color-text-success,#22c55e)] px-2 py-0.5 text-[11px] text-[var(--color-text-success,#22c55e)] hover:bg-[var(--color-background-muted,rgba(127,127,127,0.10))] disabled:opacity-40"
                  data-testid="openhands-mr-merge-confirm"
                >
                  {merging ? "Merging…" : "Confirm merge"}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={merging}
                  className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] disabled:opacity-40"
                  data-testid="openhands-mr-merge-cancel"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                disabled={info.mergeStatus !== "can_be_merged"}
                className="ml-auto rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] disabled:cursor-not-allowed disabled:opacity-40"
                title={info.mergeStatus === "can_be_merged" ? (isGitHub ? "Merge this PR" : "Merge this MR") : `${host} reports this as not mergeable (${info.mergeStatus})`}
                data-testid="openhands-mr-merge"
              >
                Merge
              </button>
            )}
          </div>
          {mergeError && (
            <div className="mt-2 text-[11px] text-[var(--color-text-critical)]" data-testid="openhands-mr-merge-error">
              {mergeError}
            </div>
          )}
          <DescriptionSection description={info.description} />
          <CommentsSection url={url} />
          <PipelineSection url={url} />
        </>
      ) : state.error ? (
        <>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-[11px] underline hover:text-[var(--color-text-default)]"
            data-testid="openhands-mr-link"
          >
            {url}
          </a>
          <div className="mt-1 text-[11px] text-[var(--color-text-critical)]">{state.error}</div>
        </>
      ) : (
        <div className="text-[11px] text-[var(--color-text-muted)]">Loading…</div>
      )}
    </li>
  );
}

export function MrPanel({ urls }: { urls: string[] }) {
  const [cards, setCards] = useState<Record<string, CardState>>({});

  const refresh = useCallback(async (targets: string[]) => {
    await Promise.all(targets.map(async (url) => {
      try {
        const info = await openHandsApi.getMr(url);
        setCards((prev) => ({ ...prev, [url]: { info, error: null } }));
      } catch (e) {
        // Keep the last good snapshot when a refresh fails mid-session.
        setCards((prev) => ({
          ...prev,
          [url]: { info: prev[url]?.info ?? null, error: (e as Error).message },
        }));
      }
    }));
  }, []);

  // Fetch on mount / when new MRs appear, then poll while the panel is open.
  const key = urls.join("\n");
  useEffect(() => {
    const targets = key ? key.split("\n") : [];
    if (targets.length === 0) return;
    void refresh(targets);
    const t = setInterval(() => void refresh(targets), REFRESH_MS);
    return () => clearInterval(t);
  }, [key, refresh]);

  const onMerged = useCallback((url: string, info: MrInfo) => {
    setCards((prev) => ({ ...prev, [url]: { info, error: null } }));
  }, []);

  return (
    <div
      className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3"
      aria-label="Merge requests"
      data-testid="openhands-mr-panel"
    >
      {urls.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-[var(--color-text-muted)]" data-testid="openhands-mr-empty">
          No merge request or pull request detected yet. When the agent opens one, it appears here.
        </div>
      ) : (
        <ul className="space-y-2">
          {urls.map((url) => (
            <MrCard key={url} url={url} state={cards[url] ?? { info: null, error: null }} onMerged={onMerged} />
          ))}
        </ul>
      )}
    </div>
  );
}
