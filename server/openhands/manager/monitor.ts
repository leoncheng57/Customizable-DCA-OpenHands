/**
 * Deterministic monitor — polls, derives, triggers. Never decides.
 *
 * Each tick, for every active run:
 *   1. Workers: read agent-server execution status + GitLab branch/MR/CI and
 *      DERIVE the phase (never self-reported). Persist transitions to the
 *      activity log.
 *   2. Manager conversation: parse new events for fenced manager-commands,
 *      validate, execute through the executor, and reply with an
 *      EXECUTOR RESULT message.
 *   3. Wake triggers: worker-blocked / worker-stale / wave-complete /
 *      run-review — sent as structured messages to the manager conversation,
 *      debounced, and never while the manager is mid-turn.
 *
 * Monitoring never depends on manager health: a dead manager conversation
 * surfaces as managerNeedsAttention on the board while polling continues.
 */

import type { GitLabAuth } from "../../gitlab.js";
import {
  findMergeRequests,
  headShaOf,
  listMergeRequestPipelines,
} from "../../gitlab.js";
import {
  ghFindPullRequests,
  ghHeadShaOf,
  ghListPullRequestPipelines,
} from "../../github.js";
import type { ConversationEvent, ManagerAgentClient } from "./agent-client.js";
import {
  buildTriggerMessage,
  isGitHubRepo,
  normalizeProjectPath,
  parseManagerCommands,
  projectPathFromRepoUrl,
  REPO_HOSTS_HINT,
  validatePlan,
} from "./contracts.js";
import type { Executor } from "./executor.js";
import type { ManagerStore } from "./store.js";
import type {
  RunRecord,
  TriggerKind,
  WorkerPhase,
  WorkerRecord,
} from "./types.js";
import {
  LAST_AGENT_MESSAGE_MAX_CHARS,
  STALE_AFTER_MS,
  TERMINAL_EXECUTION_STATUSES,
} from "./types.js";

/** GitLab pipeline statuses that no longer change. */
export const CI_TERMINAL_STATUSES = new Set([
  "success",
  "failed",
  "canceled",
  "skipped",
]);

export interface MonitorDeps {
  store: ManagerStore;
  agent: ManagerAgentClient;
  executor: Executor;
  gitlabAuth: GitLabAuth;
  /** Token for github.com runs; joins are skipped for GitHub repos without it. */
  githubToken?: string;
  /** Poll interval; default 10s. */
  intervalMs?: number;
  /** Min gap between identical triggers; default 5 minutes. */
  triggerDebounceMs?: number;
  now?: () => number;
}

export interface Monitor {
  start(): void;
  stop(): void;
  /** One full pass over all active runs (exposed for tests + manual kick). */
  tick(): Promise<void>;
  /** Last observed manager execution status per run id. */
  managerStatus(runId: string): string | null;
}

/** Extract assistant text from a raw agent-server event, tolerantly. */
export function extractAgentText(event: ConversationEvent): string | null {
  const msg = event.llm_message as
    | { role?: string; content?: unknown }
    | undefined;
  if (!msg || msg.role !== "assistant") return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? String((c as { text: string }).text)
          : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

/** Collapse whitespace and truncate with an ellipsis for board previews. */
export function truncatePreview(
  text: string,
  maxChars = LAST_AGENT_MESSAGE_MAX_CHARS,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Derive a worker phase from observed substrate + GitLab signals. */
export function derivePhase(input: {
  executionStatus: string | null;
  branchExists: boolean;
  mrUrl: string | null;
  runCompleted: boolean;
  mrMerged?: boolean;
}): { phase: WorkerPhase; blockReason: string | null } {
  const { executionStatus, branchExists, mrUrl, runCompleted } = input;
  if (runCompleted) return { phase: "done", blockReason: null };
  // A merged MR is terminal success regardless of agent status — the branch
  // is typically auto-deleted on merge, so the usual signals disappear.
  if (input.mrMerged) return { phase: "done", blockReason: null };
  if (executionStatus === "error" || executionStatus === "stuck") {
    return {
      phase: "blocked",
      blockReason: `agent ${executionStatus}`,
    };
  }
  if (executionStatus === "waiting_for_confirmation") {
    return { phase: "blocked", blockReason: "agent awaiting confirmation" };
  }
  if (mrUrl) return { phase: "pr-open", blockReason: null };
  if (executionStatus === "finished") {
    return branchExists
      ? { phase: "blocked", blockReason: "agent finished without opening an MR" }
      : { phase: "blocked", blockReason: "agent finished without pushing its branch" };
  }
  if (branchExists) return { phase: "pushed", blockReason: null };
  if (executionStatus === "running" || executionStatus === "paused" || executionStatus === "idle") {
    return { phase: "working", blockReason: null };
  }
  return { phase: "assigned", blockReason: null };
}

export function isWorkerStale(
  worker: Pick<WorkerRecord, "phase" | "lastActivityAt" | "executionStatus">,
  now: number,
): boolean {
  if (worker.phase === "done" || worker.phase === "pr-open") return false;
  if (worker.executionStatus && TERMINAL_EXECUTION_STATUSES.has(worker.executionStatus)) {
    return false;
  }
  if (!worker.lastActivityAt) return false;
  return now - Date.parse(worker.lastActivityAt) > STALE_AFTER_MS;
}

export function boardSummaryLine(workers: WorkerRecord[]): string {
  return workers
    .map(
      (w) =>
        `${w.task}: ${w.phase}${w.blockReason ? ` (${w.blockReason})` : ""}` +
        (w.mrUrl ? ` MR=${w.mrUrl}` : ""),
    )
    .join("\n");
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const {
    store,
    agent,
    executor,
    gitlabAuth,
    githubToken,
    intervalMs = 10_000,
    triggerDebounceMs = 5 * 60 * 1000,
    now = () => Date.now(),
  } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const lastTriggerAt = new Map<string, number>(); // `${runId}|${kind}|${key}`
  const managerStatuses = new Map<string, string | null>();

  async function sendTrigger(
    run: RunRecord,
    kind: TriggerKind,
    key: string,
    detail: string,
    workers: WorkerRecord[],
  ): Promise<void> {
    if (!run.managerConversationId) return;
    const debounceKey = `${run.id}|${kind}|${key}`;
    const last = lastTriggerAt.get(debounceKey) ?? 0;
    if (now() - last < triggerDebounceMs) return;
    // Never interrupt a mid-turn manager; the next tick retries.
    if (managerStatuses.get(run.id) === "running") return;
    lastTriggerAt.set(debounceKey, now());
    try {
      await agent.sendMessage(
        run.managerConversationId,
        buildTriggerMessage({
          kind,
          detail,
          boardSummary: boardSummaryLine(workers),
        }),
      );
      await store.addActivity(run.id, "monitor", `trigger → manager: ${kind} (${key})`);
    } catch (err) {
      await store.addActivity(
        run.id,
        "monitor",
        `trigger delivery failed (${kind}): ${String(err)}`,
      );
    }
  }

  async function refreshWorker(
    run: RunRecord,
    worker: WorkerRecord,
  ): Promise<WorkerRecord> {
    if (!worker.conversationId || worker.phase === "done") return worker;

    let executionStatus = worker.executionStatus;
    let lastActivityAt = worker.lastActivityAt;
    const conv = await agent.getConversation(worker.conversationId);
    if (conv) {
      executionStatus = conv.execution_status ?? executionStatus;
      lastActivityAt = conv.updated_at ?? lastActivityAt;
    }

    // Last-AI-message preview for the board (issue #267). Only re-read the
    // event log when the conversation shows fresh activity (or nothing is
    // cached yet) — with 8 workers per wave, unconditional per-tick event
    // fetches would be pure overhead on idle conversations.
    let lastAgentMessage = worker.lastAgentMessage;
    if (lastActivityAt !== worker.lastActivityAt || lastAgentMessage == null) {
      try {
        const events = await agent.listRecentEvents(worker.conversationId, 20);
        for (const event of events) {
          const text = extractAgentText(event);
          if (text) {
            lastAgentMessage = truncatePreview(text);
            break;
          }
        }
      } catch {
        /* best-effort preview: keep the previous one */
      }
    }

    // Forge joins (branch head, MR/PR discovery, CI) only while they can
    // still change the answer — and only when the run has a resolved project
    // at all (a one-click promotion may still be repo-less while planning).
    // Host-branched: GitLab REST for gitlab hosts, the GitHub adapter for
    // github.com. A GitHub run without a token simply skips joins (phases
    // then derive from execution status alone).
    const github = isGitHubRepo(run.repoUrl);
    const ghAuth = githubToken ? { token: githubToken } : null;
    // Older runs may have persisted a projectPath polluted with a "/-/…"
    // web-route suffix (e.g. a pasted issue URL); normalize at every use so
    // their forge joins still resolve.
    const projectPath = run.projectPath ? normalizeProjectPath(run.projectPath) : null;
    const canJoin = projectPath && (!github || ghAuth !== null);
    let branchExists = worker.phase === "pushed" || worker.phase === "pr-open";
    let mrUrl = worker.mrUrl;
    let mrIid = worker.mrIid;
    let ciStatus = worker.ciStatus;
    let mrMerged = false;
    if (!mrUrl && canJoin && projectPath) {
      const sha = github
        ? await ghHeadShaOf(ghAuth!, projectPath, worker.branch)
        : await headShaOf(gitlabAuth, projectPath, worker.branch);
      branchExists = sha != null;
      if (branchExists) {
        const mrs = github
          ? await ghFindPullRequests(ghAuth!, projectPath, {
              source_branch: worker.branch,
              state: "opened",
              per_page: 1,
            })
          : await findMergeRequests(gitlabAuth, projectPath, {
              source_branch: worker.branch,
              state: "opened",
              per_page: 1,
            });
        if (mrs[0]) {
          mrUrl = mrs[0].web_url;
          mrIid = mrs[0].iid;
        }
      }
      // No open MR/PR and the agent already stopped: it may simply have
      // merged (GitLab auto-deletes source branches; GitHub folds "merged"
      // into "closed"), which would otherwise derive a bogus "blocked". One
      // extra lookup only in that terminal case.
      if (!mrUrl && TERMINAL_EXECUTION_STATUSES.has(executionStatus ?? "")) {
        const merged = github
          ? (
              await ghFindPullRequests(ghAuth!, projectPath, {
                source_branch: worker.branch,
                state: "all",
                per_page: 5,
              })
            ).filter((pr) => pr.state === "merged")
          : await findMergeRequests(gitlabAuth, projectPath, {
              source_branch: worker.branch,
              state: "merged",
              per_page: 1,
            });
        if (merged[0]) {
          mrUrl = merged[0].web_url;
          mrIid = merged[0].iid;
          mrMerged = true;
        }
      }
    }
    // Skip re-polling CI once it has settled (Gitar finding: with 8 workers
    // per wave, per-tick pipeline polls for finished MRs approach rate limits).
    if (
      mrIid != null &&
      canJoin &&
      projectPath &&
      !mrMerged &&
      !(ciStatus && CI_TERMINAL_STATUSES.has(ciStatus))
    ) {
      const pipelines = github
        ? await ghListPullRequestPipelines(ghAuth!, projectPath, mrIid)
        : await listMergeRequestPipelines(gitlabAuth, projectPath, mrIid);
      ciStatus = pipelines?.[0]?.status ?? ciStatus;
    }

    const derived = derivePhase({
      executionStatus,
      branchExists,
      mrUrl,
      runCompleted: false,
      mrMerged,
    });

    const changed =
      derived.phase !== worker.phase ||
      derived.blockReason !== worker.blockReason ||
      executionStatus !== worker.executionStatus ||
      mrUrl !== worker.mrUrl ||
      ciStatus !== worker.ciStatus ||
      lastActivityAt !== worker.lastActivityAt ||
      lastAgentMessage !== worker.lastAgentMessage;
    if (!changed) return worker;

    const updated = await store.updateWorker(worker.id, {
      phase: derived.phase,
      blockReason: derived.blockReason,
      executionStatus,
      mrUrl,
      mrIid,
      ciStatus,
      lastActivityAt,
      lastAgentMessage,
    });
    if (derived.phase !== worker.phase) {
      await store.addActivity(
        run.id,
        "monitor",
        `${worker.task}: ${worker.phase} → ${derived.phase}` +
          (derived.blockReason ? ` (${derived.blockReason})` : ""),
      );
    }
    return updated ?? worker;
  }

  async function processManagerEvents(run: RunRecord): Promise<RunRecord> {
    if (!run.managerConversationId) return run;
    const conv = await agent.getConversation(run.managerConversationId);
    managerStatuses.set(run.id, conv?.execution_status ?? null);
    if (conv?.execution_status === "running") return run; // wait for the turn

    const events = await agent.listRecentEvents(run.managerConversationId, 100);
    // events are newest-first; process oldest-first after the cursor.
    const ordered = [...events].reverse();
    const cursor = run.managerEventCursor;
    // If the cursor event has scrolled out of the fetch window (a busy manager
    // turn can emit >100 events), everything fetched is NEWER than the cursor:
    // process the whole window instead of stalling forever waiting for an id
    // that will never reappear (Gitar finding, MR !1340).
    const cursorInWindow =
      cursor == null || ordered.some((e) => e.id === cursor);
    if (!cursorInWindow) {
      await store.addActivity(
        run.id,
        "monitor",
        "manager event cursor fell out of the fetch window; processing the full window",
      );
    }
    let cursorSeen = cursor == null || !cursorInWindow;
    let newestId = cursor;
    let currentRun = run;

    for (const event of ordered) {
      const eventId = typeof event.id === "string" ? event.id : null;
      if (!cursorSeen) {
        if (eventId === cursor) cursorSeen = true;
        continue;
      }
      if (eventId) newestId = eventId;
      const text = extractAgentText(event);
      if (!text) continue;
      const { commands, errors } = parseManagerCommands(text);
      for (const parseError of errors) {
        await store.addActivity(run.id, "monitor", `manager command rejected: ${parseError}`);
      }
      for (const command of commands) {
        if (command.command === "propose_plan") {
          // A plan may be proposed while planning and RE-proposed while
          // plan-ready (replacing the pending, not-yet-approved plan): scope
          // routinely changes during human review, and freezing the plan at
          // plan-ready dead-ends the run (issue #265, gap B).
          const replacingPending = currentRun.status === "plan-ready";
          if (currentRun.status !== "planning" && !replacingPending) {
            await store.addActivity(
              run.id,
              "monitor",
              `propose_plan ignored: run is ${currentRun.status} (plans can only be proposed while planning or plan-ready)`,
            );
            continue;
          }
          const planError = validatePlan(command.plan);
          if (planError) {
            await store.addActivity(run.id, "monitor", `plan rejected: ${planError}`);
            await agent.sendMessage(
              run.managerConversationId,
              `EXECUTOR RESULT: plan rejected — ${planError}. Fix and re-emit propose_plan.`,
            );
            continue;
          }
          // One-click promote: a repo-less run relies on the manager to name
          // the repository. Accept it from the plan (or the command's top
          // level), derive the project path, and persist both with the plan.
          // A repo-less run whose plan STILL carries no valid repoUrl is
          // rejected outright — storing it as plan-ready would dead-end the
          // run (approval is gated on a resolved repo). When the run's repo
          // was merely INFERRED, a differing plan repoUrl overrides it: the
          // manager's explicit resolution beats the promotion-time guess
          // (issue #265, gap A). A human-supplied repo is never overridden.
          const proposedRepoRaw = command.plan.repoUrl ?? command.repoUrl;
          const proposedRepo =
            typeof proposedRepoRaw === "string" ? proposedRepoRaw : null;
          let repoPatch:
            | { repoUrl: string; projectPath: string; repoInferred: boolean }
            | undefined;
          let repoNote = "";
          if (currentRun.repoUrl == null) {
            const derivedPath = proposedRepo ? projectPathFromRepoUrl(proposedRepo) : null;
            if (proposedRepo && derivedPath) {
              repoPatch = { repoUrl: proposedRepo, projectPath: derivedPath, repoInferred: false };
              repoNote = `; repository resolved: ${proposedRepo}`;
            } else {
              await store.addActivity(
                run.id,
                "monitor",
                `plan rejected: the run has no repository and the plan carries no valid repoUrl (got: ${proposedRepo ?? "none"})`,
              );
              await agent.sendMessage(
                run.managerConversationId,
                `EXECUTOR RESULT: plan rejected — this run has no repository resolved. Re-emit propose_plan including a "repoUrl" field with the https URL of the repository (${REPO_HOSTS_HINT}).`,
              );
              continue;
            }
          } else if (proposedRepo && proposedRepo !== currentRun.repoUrl) {
            const derivedPath = projectPathFromRepoUrl(proposedRepo);
            if (derivedPath && currentRun.repoInferred) {
              repoPatch = { repoUrl: proposedRepo, projectPath: derivedPath, repoInferred: false };
              repoNote = `; repository corrected: ${currentRun.repoUrl} (inferred) → ${proposedRepo}`;
            } else {
              await store.addActivity(
                run.id,
                "monitor",
                derivedPath
                  ? `plan's repoUrl (${proposedRepo}) ignored: the run's repository was supplied by a human (${currentRun.repoUrl}) and is never overridden`
                  : `plan's repoUrl (${proposedRepo}) ignored: not a valid https URL on ${REPO_HOSTS_HINT}`,
              );
            }
          }
          currentRun =
            (await store.updateRun(run.id, {
              plan: command.plan,
              status: "plan-ready",
              ...(repoPatch ?? {}),
            })) ?? currentRun;
          await store.addActivity(
            run.id,
            "manager",
            `plan ${replacingPending ? "re-proposed, replacing the pending plan" : "proposed"} (${command.plan.waves.length} wave(s)); awaiting human approval` +
              repoNote,
          );
          continue;
        }
        const result = await executor.applyManagerCommand(currentRun, command);
        await agent.sendMessage(
          run.managerConversationId,
          `EXECUTOR RESULT (${command.command}): ${result.ok ? "OK" : "REJECTED"} — ${result.message}`,
        );
        currentRun = (await store.getRun(run.id)) ?? currentRun;
      }
    }

    if (newestId !== cursor) {
      currentRun =
        (await store.updateRun(run.id, { managerEventCursor: newestId })) ??
        currentRun;
    }
    return currentRun;
  }

  async function tickRun(run: RunRecord): Promise<void> {
    let currentRun = await processManagerEvents(run);

    if (currentRun.status !== "active") return;

    const workers = await store.listWorkers(currentRun.id);
    const waveWorkers = workers.filter(
      (w) => w.waveIndex === currentRun.currentWave,
    );
    const refreshed: WorkerRecord[] = [];
    for (const worker of waveWorkers) {
      refreshed.push(await refreshWorker(currentRun, worker));
    }

    const allWorkers = workers.map(
      (w) => refreshed.find((r) => r.id === w.id) ?? w,
    );

    for (const worker of refreshed) {
      if (worker.phase === "blocked") {
        await sendTrigger(
          currentRun,
          "worker-blocked",
          worker.task,
          `Worker "${worker.task}" is blocked: ${worker.blockReason ?? "unknown"}.`,
          allWorkers,
        );
      } else if (isWorkerStale(worker, now())) {
        await sendTrigger(
          currentRun,
          "worker-stale",
          worker.task,
          `Worker "${worker.task}" has shown no activity for over ${Math.round(STALE_AFTER_MS / 60000)} minutes (status: ${worker.executionStatus ?? "unknown"}).`,
          allWorkers,
        );
      }
    }

    const waveDone =
      refreshed.length > 0 &&
      refreshed.every((w) => w.phase === "pr-open" || w.phase === "done");
    if (!waveDone) return;
    const totalWaves = currentRun.plan?.waves.length ?? 0;
    if (currentRun.currentWave < totalWaves) {
      await sendTrigger(
        currentRun,
        "wave-complete",
        `wave-${currentRun.currentWave}`,
        `Wave ${currentRun.currentWave} is complete (all workers at pr-open). Wave ${currentRun.currentWave + 1} is ready to launch — review the MRs, then emit launch_wave.`,
        allWorkers,
      );
    } else {
      await sendTrigger(
        currentRun,
        "run-review",
        "final",
        `All ${totalWaves} wave(s) are complete. Review the MRs and emit complete_run with a summary (or nudge/request_human).`,
        allWorkers,
      );
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void this.tick();
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const runs = await store.listActiveRuns();
        for (const run of runs) {
          try {
            await tickRun(run);
          } catch (err) {
            await store.addActivity(
              run.id,
              "monitor",
              `monitor tick failed: ${String(err)}`,
            );
          }
        }
      } finally {
        inFlight = false;
      }
    },
    managerStatus(runId) {
      return managerStatuses.get(runId) ?? null;
    },
  };
}
