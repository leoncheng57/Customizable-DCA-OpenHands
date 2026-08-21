// Manager runs — the runs LIST (secondary, wide view). Runs are not created
// here: a run starts by PROMOTING an existing conversation into a manager
// (the "Promote to manager" button on any conversation). This page links
// back into that flow and to each run's wide board.

import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { managerApi, RUN_STATUS_TONES, type RunRecord } from "../lib/manager-api.js";

export function RunStatusPill({ status }: { status: RunRecord["status"] }) {
  return (
    <span
      data-testid="manager-run-status"
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_TONES[status] ?? "bg-gray-100 text-gray-700"}`}
    >
      {status}
    </span>
  );
}

export function ManagerRunsPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await managerApi.listRuns();
      setRuns(res.items);
      setLoadError(null);
    } catch (err) {
      setLoadError(String((err as Error).message ?? err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="manager-runs-page">
      <div>
        <h1 className="text-xl font-semibold">Manager runs</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          One AI manager conversation plans and decides; deterministic code
          launches, monitors, and gates up to 8 parallel worker conversations
          per wave. Humans approve plans and merge MRs — this app never merges.
        </p>
      </div>

      <Alert variant="info" data-testid="manager-promote-hint">
        Runs start from conversations:{" "}
        <Link to="/openhands/native" className="underline underline-offset-2">
          open or start a conversation
        </Link>
        , discuss the goal, then click <strong>⬡ Promote to manager</strong> in
        its header. The conversation becomes the run's manager and this list
        tracks the run.
      </Alert>

      <section className="rounded-lg border border-[var(--color-border-default)]">
        <div className="border-b border-[var(--color-border-default)] px-4 py-2 text-sm font-semibold">
          Runs
        </div>
        {loadError ? (
          <div className="p-4">
            <Alert variant="danger">{loadError}</Alert>
          </div>
        ) : runs.length === 0 ? (
          <p className="p-4 text-sm text-[var(--color-text-muted)]">
            No runs yet — promote a conversation to start one.
          </p>
        ) : (
          <ul data-testid="manager-runs-list">
            {runs.map((run) => (
              <li key={run.id} className="border-b border-[var(--color-border-default)] last:border-b-0">
                <Link
                  to={`/openhands/runs/${run.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-background-secondary)]"
                >
                  <RunStatusPill status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-sm">{run.title}</span>
                  <Badge variant="neutral">{run.projectPath}</Badge>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    wave {run.currentWave}/{run.plan?.waves.length ?? "?"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
