// Slim banner shown on a conversation that belongs to a manager run — this is
// how the manager stays a plain OpenHands conversation while still exposing
// its run: open the manager (or a worker) like any conversation, chat with it
// natively, and jump to the run board from here.

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { managerApi, type RunStatus } from "../lib/manager-api.js";

export interface RunMembership {
  runId: string;
  role: "manager" | "worker";
  task?: string;
  title: string | null;
  status: RunStatus | null;
}

/**
 * Run membership of a conversation, polled every 15s: `undefined` while
 * loading, `null` when the conversation belongs to no run. Polling (rather
 * than fetch-once) lets a just-promoted conversation flip to its manager
 * skin without a reload.
 */
export function useRunMembership(
  conversationId: string,
  refreshKey = 0,
): RunMembership | null | undefined {
  const [membership, setMembership] = useState<RunMembership | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setMembership(undefined);
    if (!conversationId) return;
    const load = () => {
      managerApi
        .conversationRun(conversationId)
        .then((m) => {
          // m is null only on a definitive 404 ("not part of a run").
          if (!cancelled) setMembership(m);
        })
        .catch(() => {
          // Transient error: keep the previous state — a flickering manager
          // must not be offered a Promote button (Gitar finding, MR !1340).
        });
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [conversationId, refreshKey]);

  return membership;
}

export function RunBanner({ membership }: { membership: RunMembership | null | undefined }) {
  if (!membership) return null;

  return (
    <div
      data-testid="manager-run-banner"
      className="border-b border-[var(--color-border-default)] bg-[var(--color-background-secondary)] px-6 py-1.5"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-2 text-xs">
        <span aria-hidden>🧭</span>
        <span className="min-w-0 truncate">
          {membership.role === "manager" ? (
            <>
              This conversation is the <strong>manager</strong> of run{" "}
              <strong>{membership.title ?? membership.runId}</strong>
            </>
          ) : (
            <>
              This conversation is worker <strong>{membership.task}</strong> of run{" "}
              <strong>{membership.title ?? membership.runId}</strong>
            </>
          )}
          {membership.status ? ` (${membership.status})` : null}
        </span>
        <span className="flex-1" />
        <Link
          to={`/openhands/runs/${membership.runId}`}
          className="whitespace-nowrap underline underline-offset-2"
          data-testid="manager-run-banner-link"
        >
          Open run board →
        </Link>
      </div>
    </div>
  );
}
