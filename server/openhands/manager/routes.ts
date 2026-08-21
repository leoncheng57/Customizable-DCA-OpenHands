/**
 * HTTP surface for manager/worker runs, mounted at /api/openhands/manager.
 *
 * Registered BEFORE the main BFF router so its own fail-closed allowlist gate
 * (same semantics as the BFF's) handles these paths. Endpoints are thin: all
 * behavior lives in the store / executor / monitor.
 *
 * There is deliberately NO merge endpoint.
 */

import type { Router as RouterT, Request, Response } from "express";
import type { AppDatabase } from "../../db.js";
import type { GitLabAuth } from "../../gitlab.js";
import type { OpenHandsBffConfig } from "../setup.js";
import { createUpstream } from "../upstream.js";
import { createManagerAgentClient } from "./agent-client.js";
import {
  buildPromotionPrompt,
  isGitHubRepo,
  projectPathFromRepoUrl as derivePath,
  REPO_HOSTS_HINT,
  validatePlan,
} from "./contracts.js";
import { ghFetchRepoSizeBytes } from "../../github.js";
import { inferConversationRepo } from "../repo-infer.js";
import { createExecutor } from "./executor.js";
import { createMonitor, type Monitor } from "./monitor.js";
import { createManagerStore, type ManagerStore } from "./store.js";
import type { BoardWorker, RunPlan, RunRecord } from "./types.js";
import {
  MAX_WORKERS_PER_WAVE,
  STALE_AFTER_MS,
  TERMINAL_RUN_STATUSES,
  phaseSortWeight,
} from "./types.js";

// Re-exported from contracts so existing imports keep working; the
// implementation lives there to stay import-cycle-free (monitor needs it too).
export { projectPathFromRepoUrl } from "./contracts.js";

/** An inferred repo smaller than this is flagged as a probable stub. */
const NEAR_EMPTY_REPO_BYTES = 64 * 1024;

/** Size-based advisory for the shared agent-server pod. */
export function sizeAdvisory(
  repoSizeBytes: number | null,
  workers: number,
): { level: "info" | "warn" | "confirm" | "unknown"; projectedBytes: number | null } {
  if (repoSizeBytes == null) return { level: "unknown", projectedBytes: null };
  const projected = repoSizeBytes * Math.max(workers, 1);
  if (projected > 15 * 1024 ** 3) return { level: "confirm", projectedBytes: projected };
  if (projected > 5 * 1024 ** 3) return { level: "warn", projectedBytes: projected };
  return { level: "info", projectedBytes: projected };
}

async function fetchRepoSizeBytes(
  auth: GitLabAuth,
  projectPath: string,
): Promise<number | null> {
  try {
    const res = await fetch(
      `${auth.baseUrl}/api/v4/projects/${encodeURIComponent(projectPath)}?statistics=true`,
      {
        headers: { "PRIVATE-TOKEN": auth.token },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      statistics?: { repository_size?: number };
    };
    const size = body.statistics?.repository_size;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
}

function toBoardWorker(
  w: Awaited<ReturnType<ManagerStore["listWorkers"]>>[number],
  now: number,
): BoardWorker {
  const ageSeconds = w.lastActivityAt
    ? Math.max(0, Math.round((now - Date.parse(w.lastActivityAt)) / 1000))
    : null;
  const stale =
    ageSeconds != null &&
    ageSeconds * 1000 > STALE_AFTER_MS &&
    w.phase !== "done" &&
    w.phase !== "pr-open" &&
    !(w.executionStatus && ["finished", "error", "stuck"].includes(w.executionStatus));
  return { ...w, ageSeconds, stale };
}

export interface ManagerFeature {
  router: RouterT;
  monitor: Monitor;
  shutdown(): void;
}

export async function setupManagerFeature(input: {
  cfg: OpenHandsBffConfig;
  db: AppDatabase;
}): Promise<ManagerFeature> {
  const { cfg, db } = input;
  const { Router, json } = await import("express");
  const router: RouterT = Router();
  router.use(json({ limit: "1mb" }));

  const store = await createManagerStore(db);
  const upstream = createUpstream({
    internalUrl: cfg.internalUrl,
    apiKey: cfg.apiKey,
    apiKeyFile: cfg.apiKeyFile,
  });
  const agent = createManagerAgentClient(upstream);
  const gitlabAuth: GitLabAuth = {
    baseUrl: cfg.gitlabBaseUrl,
    token: cfg.gitlabToken,
  };
  const githubToken = process.env.OPENHANDS_GITHUB_TOKEN ?? "";
  const executor = createExecutor({
    store,
    agent,
    workerModel: cfg.model,
    allowedModels: cfg.models,
  });
  const monitor = createMonitor({ store, agent, executor, gitlabAuth, githubToken });
  monitor.start();

  const configured = Boolean(cfg.internalUrl && (cfg.apiKey || cfg.apiKeyFile));
  const isAllowlisted = (req: Request): boolean => {
    const email = req.user?.email?.toLowerCase();
    return Boolean(email && cfg.allowedEmails.includes(email));
  };

  // Fail-closed gate, same semantics as the BFF's.
  router.use((req: Request, res: Response, next) => {
    if (!configured) {
      res.status(503).json({ error: "OpenHands BFF is not configured" });
      return;
    }
    if (!isAllowlisted(req)) {
      res.status(403).json({ error: "Not allowlisted for OpenHands" });
      return;
    }
    next();
  });

  async function loadRun(req: Request, res: Response): Promise<RunRecord | null> {
    const run = await store.getRun(String(req.params.id));
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return null;
    }
    return run;
  }

  router.get("/runs", async (_req, res) => {
    const runs = await store.listRuns();
    res.json({ items: runs });
  });

  // Role map for the Hub conversations list: one call annotates every listed
  // conversation (manager pill + collapsed worker nesting) with no N+1.
  router.get("/conversation-roles", async (_req, res) => {
    res.json({ roles: await store.listConversationRoles() });
  });

  // Which run does a conversation belong to? Lets the native conversation
  // view surface a "manager of run X" / "worker of run X" banner, keeping the
  // manager experience inside the conversations UI.
  router.get("/conversations/:id/run", async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: "invalid conversation id" });
      return;
    }
    const membership = await store.findRunByConversation(id);
    if (!membership) {
      res.status(404).json({ error: "not part of a run" });
      return;
    }
    const run = await store.getRun(membership.runId);
    res.json({ ...membership, title: run?.title ?? null, status: run?.status ?? null });
  });

  router.get("/repo-stats", async (req, res) => {
    const repoUrl = String(req.query.repoUrl ?? "");
    const workers = Math.min(
      Number(req.query.workers) || MAX_WORKERS_PER_WAVE,
      MAX_WORKERS_PER_WAVE,
    );
    const projectPath = derivePath(repoUrl);
    if (!projectPath) {
      res.status(400).json({ error: "invalid repoUrl" });
      return;
    }
    const repoSizeBytes = isGitHubRepo(repoUrl)
      ? githubToken
        ? await ghFetchRepoSizeBytes({ token: githubToken }, projectPath)
        : null
      : await fetchRepoSizeBytes(gitlabAuth, projectPath);
    res.json({
      projectPath,
      repoSizeBytes,
      ...sizeAdvisory(repoSizeBytes, workers),
    });
  });

  router.post("/runs", async (req, res) => {
    const body = req.body as {
      title?: string;
      repoUrl?: string;
      baseBranch?: string;
      goal?: string;
      plan?: RunPlan;
      maxWorkersPerWave?: number;
      /** Promote this existing conversation into the run's manager. */
      managerConversationId?: string;
    };
    // Promotion is the creation path: runs start from an existing
    // conversation. The transcript is the goal context, so the goal note is
    // optional when promoting.
    const promoteId = String(body.managerConversationId ?? "").trim();
    if (!promoteId || !/^[0-9a-f-]{36}$/i.test(promoteId)) {
      res.status(400).json({
        error: "managerConversationId is required: promote an existing conversation into a manager",
      });
      return;
    }
    // repoUrl is optional (one-click promote). When supplied it must be valid;
    // when absent the repo is inferred from the conversation, and when even
    // that fails the run is created with a null repo — the manager is asked to
    // resolve it in its proposed plan, and approval is gated until it exists.
    let repoUrl: string | null = null;
    let inferred = false;
    if (body.repoUrl !== undefined && String(body.repoUrl).trim() !== "") {
      repoUrl = String(body.repoUrl).trim();
      if (!derivePath(repoUrl)) {
        res.status(400).json({ error: `invalid repoUrl (https URL on ${REPO_HOSTS_HINT} required)` });
        return;
      }
    }
    // A conversation may belong to at most one LIVE run. Terminal runs
    // (completed/failed/cancelled) release their conversations, so a manager
    // whose run ended can be promoted again into a fresh run — its accumulated
    // planning context is not stranded (issue #265, gap C).
    const membership = await store.findRunByConversation(promoteId);
    if (membership) {
      const priorRun = await store.getRun(membership.runId);
      const priorTerminal =
        priorRun != null && TERMINAL_RUN_STATUSES.has(priorRun.status);
      if (!priorTerminal) {
        res.status(409).json({
          error: `conversation is already the ${membership.role} of run ${membership.runId}`,
        });
        return;
      }
    }
    const conversation = await agent.getConversation(promoteId);
    if (!conversation) {
      res.status(404).json({ error: "conversation not found on the agent-server" });
      return;
    }
    if (repoUrl === null) {
      repoUrl = await inferConversationRepo(upstream, promoteId);
      inferred = repoUrl !== null;
    }
    const goal = String(body.goal ?? "").trim();
    if (goal.length > 20_000) {
      res.status(400).json({ error: "goal note too long (max 20000 chars)" });
      return;
    }
    const baseBranch = String(body.baseBranch ?? "main").trim() || "main";
    const maxWorkers = Math.min(
      Math.max(Number(body.maxWorkersPerWave) || MAX_WORKERS_PER_WAVE, 1),
      MAX_WORKERS_PER_WAVE,
    );
    const manualPlan = body.plan ?? null;
    if (manualPlan) {
      const planError = validatePlan(manualPlan);
      if (planError) {
        res.status(400).json({ error: `invalid plan: ${planError}` });
        return;
      }
      const oversized = manualPlan.waves.find((w) => w.workers.length > maxWorkers);
      if (oversized) {
        res.status(400).json({
          error: `wave ${oversized.index} exceeds maxWorkersPerWave (${maxWorkers})`,
        });
        return;
      }
      // A manual plan skips the manager's planning phase entirely, so there is
      // no later chance to resolve the repository (propose_plan is ignored
      // outside planning). Adopt the plan's own repoUrl (already validated) or
      // refuse — otherwise the run would be born plan-ready-but-unapprovable
      // (Gitar finding on this MR).
      if (repoUrl === null && manualPlan.repoUrl) {
        repoUrl = manualPlan.repoUrl;
      }
      if (repoUrl === null) {
        res.status(400).json({
          error:
            "a manual plan requires a repository: no repoUrl was supplied, none could be inferred from the conversation, and the plan carries none — add repoUrl to the request or the plan",
        });
        return;
      }
    }
    const projectPath = repoUrl === null ? null : derivePath(repoUrl);

    const run = await store.createRun({
      title:
        String(body.title ?? "").trim() ||
        String(conversation.title ?? "").trim() ||
        goal.slice(0, 80) ||
        `run ${promoteId.slice(0, 8)}`,
      repoUrl,
      projectPath,
      repoInferred: inferred,
      baseBranch,
      goal,
      status: manualPlan ? "plan-ready" : "planning",
      plan: manualPlan,
      maxWorkersPerWave: maxWorkers,
      createdBy: req.user?.email ?? "unknown",
    });
    await store.addActivity(
      run.id,
      "human",
      `conversation ${promoteId} promoted to manager` +
        (manualPlan ? " with a manual plan" : "; manager drafting plan") +
        (repoUrl === null
          ? "; no repository resolved yet (the manager must identify it)"
          : inferred
            ? `; repo inferred from the conversation: ${repoUrl}`
            : ""),
    );
    // Inference sanity check (best-effort, non-blocking): an inferred repo
    // that exists but is nearly empty is usually a stub or moved project —
    // surface a loud note so the human verifies before approving the plan
    // (issue #265, gap A).
    if (inferred && repoUrl && projectPath) {
      const sizePromise = isGitHubRepo(repoUrl)
        ? githubToken
          ? ghFetchRepoSizeBytes({ token: githubToken }, projectPath)
          : Promise.resolve(null)
        : fetchRepoSizeBytes(gitlabAuth, projectPath);
      void sizePromise
        .then(async (size) => {
          if (size != null && size < NEAR_EMPTY_REPO_BYTES) {
            await store.addRunNote(
              run.id,
              `The inferred repository ${repoUrl} looks nearly empty (~${Math.max(1, Math.round(size / 1024))} KB) — it may be a stub or a moved project. Verify it before approving; the manager can correct it via the plan's repoUrl.`,
            );
          }
        })
        .catch(() => {});
    }

    // ORDER MATTERS: pin the event cursor to the conversation's newest event
    // BEFORE sending the promotion prompt, so fenced blocks that may already
    // exist in the transcript are never executed retroactively. Only events
    // after this point are eligible manager commands. Any failure here
    // cancels the just-created run (never orphan a stuck "planning" row) and
    // aborts with 502 (Gitar findings, MR !1340).
    try {
      const recent = await agent.listRecentEvents(promoteId, 1);
      const newestEventId =
        typeof recent[0]?.id === "string" ? (recent[0].id as string) : null;
      if (recent.length > 0 && newestEventId == null) {
        throw new Error(
          "could not pin the manager event cursor (newest event has no id); aborting to avoid retroactive command execution",
        );
      }
      await store.updateRun(run.id, {
        managerConversationId: promoteId,
        managerEventCursor: newestEventId,
      });
      const currentRun = (await store.getRun(run.id))!;
      await agent.sendMessage(
        promoteId,
        buildPromotionPrompt({ run: currentRun, hasManualPlan: Boolean(manualPlan) }),
      );
      await store.addActivity(run.id, "executor", "promotion prompt delivered to the manager");
    } catch (err) {
      await store.updateRun(run.id, { status: "cancelled" });
      await store.addActivity(run.id, "executor", `promotion failed, run cancelled: ${String(err)}`);
      res.status(502).json({ error: `promotion failed: ${String(err)}` });
      return;
    }

    const created = await store.getRun(run.id);
    res.status(201).json(created);
  });

  router.get("/runs/:id", async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const now = Date.now();
    const workers = (await store.listWorkers(run.id))
      .map((w) => toBoardWorker(w, now))
      .sort((a, b) => phaseSortWeight(a) - phaseSortWeight(b) || a.task.localeCompare(b.task));
    const activity = await store.listActivity(run.id);
    const managerExecutionStatus = monitor.managerStatus(run.id);
    res.json({
      run,
      workers,
      activity,
      managerExecutionStatus,
      managerNeedsAttention:
        managerExecutionStatus === "error" || managerExecutionStatus === "stuck",
      defaultWorkerModel: cfg.model,
    });
  });

  router.post("/runs/:id/approve", async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (run.status !== "plan-ready" || !run.plan) {
      res.status(409).json({ error: `run is ${run.status}; nothing to approve` });
      return;
    }
    // One-click promote can create a run without a repository; workers cannot
    // clone or open MRs without one, so approval is gated until it exists
    // (the manager resolves it via the repoUrl field of its proposed plan).
    if (!run.repoUrl || !run.projectPath) {
      res.status(409).json({
        error:
          "the run has no repository resolved yet — ask the manager to re-propose the plan with a repoUrl before approving",
      });
      return;
    }
    await store.addActivity(run.id, "human", "plan approved");
    const result = await executor.launchWave(run, 1);
    if (run.managerConversationId) {
      agent
        .sendMessage(
          run.managerConversationId,
          `EXECUTOR RESULT: the human approved the plan. ${result.message}`,
        )
        .catch(() => {});
    }
    const updated = await store.getRun(run.id);
    res.status(result.ok ? 200 : 502).json({ result, run: updated });
  });

  // Reject a pending plan: the run returns to planning and the manager is
  // told why, so it can revise and re-emit propose_plan. Without this, the
  // only "no" available at the approval card was abandoning the whole run
  // (issue #265, gap B).
  router.post("/runs/:id/reject-plan", async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (run.status !== "plan-ready") {
      res.status(409).json({ error: `run is ${run.status}; there is no pending plan to reject` });
      return;
    }
    const reason = String((req.body as { reason?: string })?.reason ?? "")
      .trim()
      .slice(0, 2_000);
    await store.updateRun(run.id, { status: "planning", plan: null });
    await store.addActivity(
      run.id,
      "human",
      `plan rejected${reason ? `: ${reason}` : ""}; run returned to planning`,
    );
    if (run.managerConversationId) {
      agent
        .sendMessage(
          run.managerConversationId,
          `EXECUTOR RESULT: the human REJECTED the plan${reason ? ` — ${reason}` : ""}. The run is back in planning: revise and re-emit propose_plan.`,
        )
        .catch(() => {});
    }
    const updated = await store.getRun(run.id);
    res.json({ ok: true, message: "plan rejected; the manager was asked to revise it", run: updated });
  });

  router.post("/runs/:id/nudge", async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const { task, message, model } = req.body as {
      task?: string;
      message?: string;
      model?: string;
    };
    if (!task || !message) {
      res.status(400).json({ error: "task and message are required" });
      return;
    }
    if (model !== undefined && (typeof model !== "string" || model.trim() === "")) {
      res.status(400).json({ error: "model, when present, must be a non-empty string" });
      return;
    }
    const result = await executor.nudgeWorker(
      run,
      String(task),
      String(message),
      "human",
      model?.trim(),
    );
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.post("/runs/:id/cancel", async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const result = await executor.cancelRun(run);
    res.json(result);
  });

  // Manual monitor kick — used by tests and local smoke; harmless (idempotent).
  router.post("/runs/:id/tick", async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    await monitor.tick();
    res.json({ ok: true });
  });

  return {
    router,
    monitor,
    shutdown: () => monitor.stop(),
  };
}
