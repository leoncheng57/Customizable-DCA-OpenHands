// Compact run board rendered INSIDE the manager conversation's sidebar —
// the run's primary home. Self-polling (5s), like the app's other panels.
// The wide standalone board (/openhands/runs/:id) remains as a secondary view.

import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import {
  formatAge,
  formatBytes,
  managerApi,
  PHASE_TONES,
  type BoardState,
  type BoardWorker,
  type RepoStats,
  type RunRecord,
} from "../lib/manager-api.js";

/**
 * Repo line for plan-approval sections: the resolved project path (or a loud
 * "not resolved" notice — approval is gated on it) plus the shared-pod clone
 * size advisory when the repo is known. Rendered in both the compact sidebar
 * panel and the wide board.
 */
export function PlanRepoAdvisory({ run }: { run: RunRecord }) {
  const [stats, setStats] = useState<RepoStats | null>(null);
  useEffect(() => {
    if (!run.repoUrl) {
      setStats(null);
      return;
    }
    let cancelled = false;
    managerApi
      .repoStats(run.repoUrl, run.maxWorkersPerWave)
      .then((s) => !cancelled && setStats(s))
      .catch(() => !cancelled && setStats(null));
    return () => {
      cancelled = true;
    };
  }, [run.repoUrl, run.maxWorkersPerWave]);
  return (
    <div className="mb-2 flex flex-col gap-0.5" data-testid="manager-plan-repo">
      <div>
        Repository:{" "}
        {run.projectPath ? (
          <>
            <span className="font-mono">{run.projectPath}</span>
            {run.repoInferred ? (
              <span className="text-amber-600" data-testid="manager-plan-repo-inferred">
                {" "}
                · inferred from the conversation — verify it is the right repo
                before approving (the plan&apos;s repoUrl can correct it)
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-red-600">
            not resolved yet — approval is blocked until the manager names one
          </span>
        )}
      </div>
      {run.plan?.repoUrl && run.repoUrl && run.plan.repoUrl !== run.repoUrl ? (
        <div className="text-red-600" data-testid="manager-plan-repo-mismatch">
          The plan names a different repository ({run.plan.repoUrl}) than the
          one this run targets ({run.repoUrl}) — reject the plan and sort this
          out before approving.
        </div>
      ) : null}
      {stats ? (
        <div
          data-testid="manager-plan-size-advisory"
          className={
            stats.level === "confirm"
              ? "text-red-600"
              : stats.level === "warn"
                ? "text-amber-600"
                : "text-[var(--color-text-muted)]"
          }
        >
          {stats.level === "unknown"
            ? "Repo size unknown — every worker clones onto the ONE shared pod (best for small/medium repos)."
            : `Projected clone footprint ~${formatBytes(stats.projectedBytes)} across workers on the ONE shared pod (${formatBytes(stats.repoSizeBytes)}/clone).`}
        </div>
      ) : null}
    </div>
  );
}

function PanelPhasePill({ worker }: { worker: BoardWorker }) {
  const tone = worker.stale
    ? "bg-orange-100 text-orange-800"
    : PHASE_TONES[worker.phase] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {worker.stale ? `${worker.phase}·stale` : worker.phase}
    </span>
  );
}

export function RunPanel({ runId }: { runId: string }) {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBoard(await managerApi.board(runId));
      setError(null);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const approve = useCallback(async () => {
    setBusy(true);
    try {
      const res = await managerApi.approve(runId);
      setNotice(res.result.message);
      await refresh();
    } catch (err) {
      setNotice(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }, [runId, refresh]);

  const reject = useCallback(async () => {
    const reason = window.prompt(
      "Reject the pending plan? The run returns to planning and the manager revises. Optional reason (sent to the manager):",
    );
    if (reason === null) return; // cancelled
    setBusy(true);
    try {
      const res = await managerApi.rejectPlan(runId, reason);
      setNotice(res.message);
      await refresh();
    } catch (err) {
      setNotice(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }, [runId, refresh]);

  const nudge = useCallback(
    async (task: string) => {
      const message = window.prompt(`Nudge for worker "${task}":`);
      if (!message) return;
      try {
        const res = await managerApi.nudge(runId, task, message);
        setNotice(res.message);
        await refresh();
      } catch (err) {
        setNotice(String((err as Error).message ?? err));
      }
    },
    [runId, refresh],
  );

  if (error) {
    return (
      <div className="p-3">
        <Alert variant="danger">{error}</Alert>
      </div>
    );
  }
  if (!board) {
    return <div className="p-3 text-xs text-[var(--color-text-muted)]">Loading run…</div>;
  }

  const { run, workers, activity } = board;
  const totalWaves = run.plan?.waves.length ?? 0;

  return (
    <div
      className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t-2 border-cyan-500 p-3 text-xs"
      data-testid="manager-run-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{run.status}</span>
        <span className="text-[var(--color-text-muted)]">
          wave {run.currentWave}/{totalWaves || "?"} · base {run.baseBranch}
        </span>
        <span className="flex-1" />
        <Link className="underline underline-offset-2" to={`/openhands/runs/${run.id}`}>
          wide board →
        </Link>
      </div>

      {board.managerNeedsAttention ? (
        <Alert variant="warning">
          The manager conversation ended in an error state; monitoring continues.
        </Alert>
      ) : null}
      {notice ? <Alert variant="info">{notice}</Alert> : null}

      {run.status === "planning" ? (
        <Alert variant="info">The manager is drafting a wave plan.</Alert>
      ) : null}

      {run.status === "plan-ready" && run.plan ? (
        <div className="rounded border border-[var(--color-border-default)] p-2">
          <div className="mb-1 font-semibold">Proposed plan — your approval launches wave 1</div>
          <PlanRepoAdvisory run={run} />
          {run.plan.waves.map((w) => (
            <div key={w.index} className="mb-1">
              <span className="font-semibold">Wave {w.index}</span>{" "}
              (<span className="font-mono">{w.baseBranch}</span>):{" "}
              {w.workers.map((x) => x.task).join(", ")}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void approve()} data-testid="manager-panel-approve">
              {busy ? "Launching…" : "Approve & launch"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void reject()}
              data-testid="manager-panel-reject"
              title="Return the run to planning; the manager revises and re-proposes"
            >
              Reject plan
            </Button>
          </div>
        </div>
      ) : null}

      {workers.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="manager-panel-workers">
          {workers.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--color-border-default)] px-2 py-1.5">
              {w.conversationId ? (
                <Link className="font-medium underline-offset-2 hover:underline" to={`/openhands/native/conversations/${w.conversationId}`}>
                  {w.task}
                </Link>
              ) : (
                <span className="font-medium">{w.task}</span>
              )}
              <PanelPhasePill worker={w} />
              <span className="text-[var(--color-text-muted)]">{formatAge(w.ageSeconds)}</span>
              <span className="flex-1" />
              {w.mrUrl ? (
                <a className="underline" href={w.mrUrl} target="_blank" rel="noreferrer">
                  !{w.mrIid ?? "MR"}
                </a>
              ) : null}
              <button
                type="button"
                className="text-[var(--color-text-muted)] underline-offset-2 hover:underline"
                onClick={() => void nudge(w.task)}
              >
                nudge
              </button>
              {w.blockReason ? (
                <span className="w-full text-red-600">{w.blockReason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <details>
        <summary className="cursor-pointer font-semibold">Activity log</summary>
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[10px]">
          {activity.slice(-40).map((a) => (
            <li key={a.id}>
              <span className="text-[var(--color-text-muted)]">
                {new Date(a.createdAt).toLocaleTimeString()} {a.actor}
              </span>{" "}
              {a.message}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
