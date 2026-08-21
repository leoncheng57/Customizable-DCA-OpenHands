// Compact mini-board of manager runs, shown on the Hub above the
// conversations list: one row per active run with per-worker phase chips.
// This strip is the ENTRY POINT for the feature — manager runs live inside
// the conversations surface, deliberately not in the navbar. The full
// dashboard lives at /openhands/runs/:id, reached from here.

import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  managerApi,
  PHASE_TONES,
  type BoardState,
  type RunRecord,
} from "../lib/manager-api.js";

interface RunWithBoard {
  run: RunRecord;
  board: BoardState | null;
}

const ACTIVE = new Set(["planning", "plan-ready", "active"]);

export function ActiveRunsStrip() {
  const [rows, setRows] = useState<RunWithBoard[] | null>(null);
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { items } = await managerApi.listRuns();
      setAvailable(true);
      const active = items.filter((r) => ACTIVE.has(r.status)).slice(0, 5);
      const boards = await Promise.all(
        active.map(async (run) => {
          try {
            return { run, board: await managerApi.board(run.id) };
          } catch {
            return { run, board: null };
          }
        }),
      );
      setRows(boards);
    } catch {
      // Manager feature unavailable (no DB / not allowlisted): stay hidden.
      setAvailable(false);
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!available || rows === null) return null;

  return (
    <div
      className="rounded-lg border border-[var(--color-border-default)]"
      data-testid="manager-active-runs"
    >
      <div className="flex items-center gap-3 border-b border-[var(--color-border-default)] px-4 py-2">
        <span className="text-sm font-semibold">Manager runs</span>
        <span className="flex-1" />
        <Link to="/openhands/runs" className="text-xs underline-offset-2 hover:underline">
          all runs →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
          No active runs. Start one from any conversation: discuss the goal,
          then click <strong>⬡ Promote to manager</strong> in its header — the
          manager plans file-disjoint waves and up to 8 parallel worker
          conversations deliver them as draft MRs.
        </p>
      ) : null}
      <ul>
        {rows.map(({ run, board }) => {
          const workers = board?.workers ?? [];
          const worst =
            workers.find((w) => w.phase === "blocked") ??
            workers.find((w) => w.stale);
          return (
            <li key={run.id} className="border-b border-[var(--color-border-default)] last:border-0">
              <Link
                to={`/openhands/runs/${run.id}`}
                className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm hover:bg-[var(--color-background-element)]"
              >
                <span className={worst ? "text-red-600" : ""} aria-hidden>
                  {worst ? "●" : "○"}
                </span>
                <span className="min-w-0 flex-1 truncate">{run.title}</span>
                {workers.map((w) => (
                  <span
                    key={w.id}
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      w.stale ? "bg-orange-100 text-orange-800" : PHASE_TONES[w.phase]
                    }`}
                    title={`${w.task}: ${w.phase}${w.blockReason ? ` — ${w.blockReason}` : ""}`}
                  >
                    {w.task}
                  </span>
                ))}
                <span className="text-xs text-[var(--color-text-muted)]">
                  {run.status} · wave {run.currentWave}/{run.plan?.waves.length ?? "?"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
