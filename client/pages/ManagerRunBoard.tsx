// The per-run dashboard: worst-first worker board, plan approval, manager
// state, nudges, and the collapsible activity log. Polls every 5s (this app
// is deliberately poll-only). Worker rows link to the existing native
// conversation view, which provides transcript/diff/terminal for free.

import React, { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { CollapsibleCard } from "../ds/card.js";
import {
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../ds/table.js";
import {
  formatAge,
  managerApi,
  PHASE_TONES,
  type BoardState,
  type BoardWorker,
} from "../lib/manager-api.js";
import { PlanRepoAdvisory } from "../components/RunPanel.js";
import { RunStatusPill } from "./ManagerRuns.js";

export function PhasePill({ worker }: { worker: BoardWorker }) {
  const label = worker.stale ? `${worker.phase} · stale` : worker.phase;
  const tone = worker.stale
    ? "bg-orange-100 text-orange-800"
    : PHASE_TONES[worker.phase] ?? "bg-gray-100 text-gray-700";
  return (
    <span
      data-testid={`manager-phase-${worker.task}`}
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

/** Short display name for a model id, e.g. "anthropic/claude-x" → "claude-x". */
export function shortModelName(model: string): string {
  const tail = model.split("/").pop();
  return tail && tail.length > 0 ? tail : model;
}

/** Truncated last-AI-message preview; click toggles full wrapped text. */
function LastMessagePreview({ worker }: { worker: BoardWorker }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  if (!worker.lastAgentMessage) {
    return <span className="text-xs text-[var(--color-text-muted)]">–</span>;
  }
  return (
    <button
      type="button"
      data-testid={`manager-last-message-${worker.task}`}
      title={expanded ? "Collapse" : worker.lastAgentMessage}
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      className={`block max-w-[24rem] cursor-pointer text-left text-xs text-[var(--color-text-muted)] ${
        expanded ? "whitespace-normal break-words" : "truncate"
      }`}
    >
      {worker.lastAgentMessage}
    </button>
  );
}

function WorkerRow({
  worker,
  onNudge,
}: {
  worker: BoardWorker;
  onNudge: (task: string) => void;
}) {
  return (
    <TR data-testid={`manager-worker-${worker.task}`}>
      <TD>
        <div className="flex flex-col gap-0.5">
          {worker.conversationId ? (
            <Link
              className="text-sm font-medium text-[var(--color-text-link,inherit)] underline-offset-2 hover:underline"
              to={`/openhands/native/conversations/${worker.conversationId}`}
            >
              {worker.task}
            </Link>
          ) : (
            <span className="text-sm font-medium">{worker.task}</span>
          )}
          {worker.blockReason ? (
            <span className="text-xs text-red-600">{worker.blockReason}</span>
          ) : null}
        </div>
      </TD>
      <TD>
        <PhasePill worker={worker} />
      </TD>
      <TD
        className="font-mono text-xs"
        data-testid={`manager-model-${worker.task}`}
        title={worker.model ?? undefined}
      >
        {worker.model ? shortModelName(worker.model) : "–"}
      </TD>
      <TD>
        <LastMessagePreview worker={worker} />
      </TD>
      <TD className="text-xs">{formatAge(worker.ageSeconds)}</TD>
      <TD className="font-mono text-xs">{worker.branch}</TD>
      <TD className="text-xs">{worker.ciStatus ?? "–"}</TD>
      <TD className="text-xs">
        {worker.mrUrl ? (
          <a className="underline" href={worker.mrUrl} target="_blank" rel="noreferrer">
            !{worker.mrIid ?? "MR"}
          </a>
        ) : (
          "–"
        )}
      </TD>
      <TD>
        <Button
          size="sm"
          variant="ghost"
          data-testid={`manager-nudge-${worker.task}`}
          onClick={() => onNudge(worker.task)}
        >
          Nudge
        </Button>
      </TD>
    </TR>
  );
}

export function ManagerRunBoardPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBoard(await managerApi.board(id));
      setError(null);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const approve = useCallback(async () => {
    setBusy(true);
    try {
      const res = await managerApi.approve(id);
      setNotice(res.result.message);
      await refresh();
    } catch (err) {
      setNotice(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }, [id, refresh]);

  const reject = useCallback(async () => {
    const reason = window.prompt(
      "Reject the pending plan? The run returns to planning and the manager revises. Optional reason (sent to the manager):",
    );
    if (reason === null) return; // cancelled
    setBusy(true);
    try {
      const res = await managerApi.rejectPlan(id, reason);
      setNotice(res.message);
      await refresh();
    } catch (err) {
      setNotice(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }, [id, refresh]);

  const nudge = useCallback(
    async (task: string) => {
      const message = window.prompt(`Nudge for worker "${task}":`);
      if (!message) return;
      const model =
        window.prompt(
          `Optional: switch "${task}" to another model (leave blank to keep the current one):`,
          "",
        ) ?? "";
      try {
        const res = await managerApi.nudge(id, task, message, model.trim() || undefined);
        setNotice(res.message);
        await refresh();
      } catch (err) {
        setNotice(String((err as Error).message ?? err));
      }
    },
    [id, refresh],
  );

  const cancel = useCallback(async () => {
    if (!window.confirm("Cancel this run? Workers keep their branches; nothing is deleted.")) return;
    await managerApi.cancel(id);
    await refresh();
  }, [id, refresh]);

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="danger">{error}</Alert>
      </div>
    );
  }
  if (!board) {
    return <div className="p-6 text-sm text-[var(--color-text-muted)]">Loading run…</div>;
  }

  const { run, workers, activity } = board;
  const totalWaves = run.plan?.waves.length ?? 0;
  const blocked = workers.filter((w) => w.phase === "blocked").length;
  const staleCount = workers.filter((w) => w.stale).length;
  const gatedWaves = run.plan?.waves.filter((w) => w.index > run.currentWave) ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6" data-testid="manager-board-page">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/openhands/runs" className="text-sm underline-offset-2 hover:underline">
          ← Runs
        </Link>
        <h1 className="text-lg font-semibold">{run.title}</h1>
        <RunStatusPill status={run.status} />
        <span className="text-xs text-[var(--color-text-muted)]">
          wave {run.currentWave}/{totalWaves} · base {run.baseBranch}
          {board.defaultWorkerModel ? (
            <>
              {" · model "}
              <span className="font-mono" data-testid="manager-default-model" title={board.defaultWorkerModel}>
                {shortModelName(board.defaultWorkerModel)}
              </span>
            </>
          ) : null}
          {" "}· {workers.length} workers · {blocked} blocked · {staleCount} stale
        </span>
        <span className="flex-1" />
        {run.status === "active" || run.status === "planning" || run.status === "plan-ready" ? (
          <Button size="sm" variant="danger" onClick={() => void cancel()} data-testid="manager-cancel-run">
            Cancel run
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span>
          manager:{" "}
          {run.managerConversationId ? (
            <Link
              className="underline"
              to={`/openhands/native/conversations/${run.managerConversationId}`}
              data-testid="manager-transcript-link"
            >
              {board.managerExecutionStatus ?? "idle"} — open transcript
            </Link>
          ) : (
            "none (executor-only run)"
          )}
        </span>
      </div>

      {board.managerNeedsAttention ? (
        <Alert variant="warning">
          The manager conversation ended in an error state. Monitoring continues
          deterministically; open the manager transcript to unblock it, or drive
          the run with human nudges/approvals.
        </Alert>
      ) : null}
      {run.notes.length > 0 ? (
        <Alert variant="info">
          <ul className="list-disc pl-4">
            {run.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {notice ? <Alert variant="info">{notice}</Alert> : null}

      {run.status === "planning" ? (
        <Alert variant="info">
          The manager is drafting a wave plan. This board updates automatically
          when the plan is proposed.
        </Alert>
      ) : null}

      {run.status === "plan-ready" && run.plan ? (
        <section className="rounded-lg border border-[var(--color-border-default)] p-4">
          <h2 className="mb-2 text-sm font-semibold">Proposed plan — awaiting your approval</h2>
          <div className="text-xs">
            <PlanRepoAdvisory run={run} />
          </div>
          {run.plan.waves.map((wave) => (
            <div key={wave.index} className="mb-2">
              <div className="text-xs font-semibold">
                Wave {wave.index} (base: <span className="font-mono">{wave.baseBranch}</span>)
              </div>
              <ul className="ml-4 list-disc text-xs">
                {wave.workers.map((w) => (
                  <li key={w.task}>
                    <span className="font-mono">{w.task}</span> → <span className="font-mono">{w.branch}</span>
                    {w.ownsPaths?.length ? ` · owns ${w.ownsPaths.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button data-testid="manager-approve-plan" disabled={busy} onClick={() => void approve()}>
              {busy ? "Launching…" : "Approve plan & launch wave 1"}
            </Button>
            <Button
              variant="secondary"
              data-testid="manager-reject-plan"
              disabled={busy}
              onClick={() => void reject()}
              title="Return the run to planning; the manager revises and re-proposes"
            >
              Reject plan
            </Button>
          </div>
        </section>
      ) : null}

      {workers.length > 0 ? (
        <Table data-testid="manager-board-table">
          <THead>
            <TR>
              <TH>Worker</TH>
              <TH>Phase</TH>
              <TH>Model</TH>
              <TH>Last message</TH>
              <TH>Age</TH>
              <TH>Branch</TH>
              <TH>CI</TH>
              <TH>MR</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {workers.map((w) => (
              <WorkerRow key={w.id} worker={w} onNudge={(task) => void nudge(task)} />
            ))}
          </TBody>
        </Table>
      ) : null}

      {gatedWaves.length > 0 && run.status === "active" ? (
        <div className="rounded border border-dashed border-[var(--color-border-default)] p-3 text-xs text-[var(--color-text-muted)]">
          {gatedWaves.map((w) => (
            <div key={w.index}>
              Wave {w.index} (gated): {w.workers.map((x) => x.task).join(", ")} — base{" "}
              <span className="font-mono">{w.baseBranch}</span>
            </div>
          ))}
        </div>
      ) : null}

      <CollapsibleCard title="Activity log" defaultOpen={false}>
        <ul className="flex flex-col gap-1 font-mono text-xs" data-testid="manager-activity-log">
          {activity.map((a) => (
            <li key={a.id}>
              <span className="text-[var(--color-text-muted)]">
                {new Date(a.createdAt).toLocaleTimeString()} {a.actor.padEnd(8)}
              </span>{" "}
              {a.message}
            </li>
          ))}
          {activity.length === 0 ? (
            <li className="text-[var(--color-text-muted)]">no activity yet</li>
          ) : null}
        </ul>
      </CollapsibleCard>
    </div>
  );
}
