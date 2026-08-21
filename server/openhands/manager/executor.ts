/**
 * Deterministic executor — the only component with effects.
 *
 * Everything the manager conversation "does" terminates here as a validated
 * command; everything the human does through the API terminates here too.
 * The executor launches worker conversations, delivers nudges, gates waves,
 * and records every effect in the activity log. It has NO merge capability.
 */

import type { ManagerAgentClient } from "./agent-client.js";
import type { ManagerStore } from "./store.js";
import type { InspectMode, ManagerCommand, RunRecord, WaveSpec } from "./types.js";
import { buildWorkerPrompt } from "./contracts.js";
import { renderTranscript } from "./transcript.js";

export interface ExecutorDeps {
  store: ManagerStore;
  agent: ManagerAgentClient;
  /** Model used for worker conversations. */
  workerModel: string;
  /** Models a nudge may switch a worker to (the configured allowlist). */
  allowedModels: string[];
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

export interface Executor {
  /** Launch one wave's workers (validated). Idempotent per wave. */
  launchWave(run: RunRecord, waveIndex: number): Promise<CommandResult>;
  /** Deliver a nudge into a worker's conversation, optionally switching its model first. */
  nudgeWorker(
    run: RunRecord,
    task: string,
    message: string,
    actor: "manager" | "human",
    model?: string,
  ): Promise<CommandResult>;
  /**
   * READ-ONLY view into a worker's transcript. Never writes to the worker's
   * conversation — the returned message is what the manager receives.
   */
  inspectWorker(
    run: RunRecord,
    task: string,
    mode?: InspectMode,
  ): Promise<CommandResult>;
  /** Apply a validated manager command. */
  applyManagerCommand(
    run: RunRecord,
    command: ManagerCommand,
  ): Promise<CommandResult>;
  /** Mark the run complete (workers to done). */
  completeRun(run: RunRecord, summary: string): Promise<CommandResult>;
  cancelRun(run: RunRecord): Promise<CommandResult>;
}

function waveOf(run: RunRecord, index: number): WaveSpec | null {
  return run.plan?.waves.find((w) => w.index === index) ?? null;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { store, agent, workerModel, allowedModels } = deps;
  /** Serializes launches per run: approve endpoint vs manager launch_wave. */
  const launchesInFlight = new Set<string>();

  async function doLaunchWave(
    run: RunRecord,
    waveIndex: number,
  ): Promise<CommandResult> {
    if (!run.plan) return { ok: false, message: "run has no approved plan" };
    // Defensive: the approve endpoint 409s while the repo is unresolved, but
    // a manager launch_wave command reaches here directly — workers cannot
    // clone or open MRs without a repository.
    if (!run.repoUrl || !run.projectPath) {
      return { ok: false, message: "run has no repository resolved yet" };
    }
    if (run.status !== "active" && run.status !== "plan-ready") {
        return { ok: false, message: `run is ${run.status}, not launchable` };
      }
      const wave = waveOf(run, waveIndex);
      if (!wave) return { ok: false, message: `no wave ${waveIndex} in plan` };
      if (waveIndex !== run.currentWave + 1) {
        return {
          ok: false,
          message: `wave ${waveIndex} is not next (current: ${run.currentWave})`,
        };
      }
      if (wave.workers.length > run.maxWorkersPerWave) {
        return {
          ok: false,
          message: `wave ${waveIndex} exceeds the ${run.maxWorkersPerWave}-worker cap`,
        };
      }
      // Gate: every earlier-wave worker must have an MR (or be done).
      const existing = await store.listWorkers(run.id);
      const unfinished = existing.filter(
        (w) =>
          w.waveIndex < waveIndex && w.phase !== "pr-open" && w.phase !== "done",
      );
      if (unfinished.length > 0) {
        return {
          ok: false,
          message: `wave ${waveIndex} gated: ${unfinished
            .map((w) => `${w.task}(${w.phase})`)
            .join(", ")} not at pr-open`,
        };
      }

      await store.updateRun(run.id, { status: "active", currentWave: waveIndex });
      const launched: string[] = [];
      const failed: string[] = [];
      for (const spec of wave.workers) {
        const already = await store.getWorkerByTask(run.id, spec.task);
        if (already?.conversationId) {
          launched.push(`${spec.task} (already launched)`);
          continue;
        }
        const record =
          already ??
          (await store
            .createWorker({
              runId: run.id,
              waveIndex,
              task: spec.task,
              branch: spec.branch,
              contract: spec.contract,
            })
            .catch(async () => {
              // Lost a race on UNIQUE(run_id, task): load the winner's row
              // instead of 500ing (Gitar finding, MR !1340).
              const winner = await store.getWorkerByTask(run.id, spec.task);
              if (!winner) {
                throw new Error(`could not create or load worker ${spec.task}`);
              }
              return winner;
            }));
        try {
          const conversationId = await agent.createConversation({
            initialMessage: buildWorkerPrompt({ run, wave, worker: spec }),
            model: workerModel,
          });
          await store.updateWorker(record.id, {
            conversationId,
            phase: "working",
            executionStatus: "running",
            lastActivityAt: new Date().toISOString(),
            model: workerModel,
          });
          launched.push(spec.task);
        } catch (err) {
          await store.updateWorker(record.id, {
            phase: "blocked",
            blockReason: `launch failed: ${String(err)}`,
          });
          failed.push(`${spec.task}: ${String(err)}`);
        }
      }
      const message =
        `wave ${waveIndex} launched: ${launched.join(", ") || "none"}` +
        (failed.length ? `; FAILED: ${failed.join("; ")}` : "");
      await store.addActivity(run.id, "executor", message);
      return { ok: failed.length === 0, message };
  }

  const executor: Executor = {
    async launchWave(run, waveIndex) {
      // Serialize per run: the human approve endpoint and a manager
      // launch_wave command can race (Gitar finding, MR !1340).
      if (launchesInFlight.has(run.id)) {
        return { ok: false, message: "a launch is already in progress for this run" };
      }
      launchesInFlight.add(run.id);
      try {
        return await doLaunchWave(run, waveIndex);
      } finally {
        launchesInFlight.delete(run.id);
      }
    },

    async nudgeWorker(run, task, message, actor, model) {
      const worker = await store.getWorkerByTask(run.id, task);
      if (!worker) return { ok: false, message: `no worker "${task}" in run` };
      if (!worker.conversationId) {
        return { ok: false, message: `worker "${task}" has no conversation` };
      }
      if (model !== undefined && !allowedModels.includes(model)) {
        return {
          ok: false,
          message: `model "${model}" is not in the configured allowlist (${allowedModels.join(", ")})`,
        };
      }
      // Switch BEFORE delivering the nudge so the reply is produced by the
      // requested model; a failed switch aborts the nudge entirely (never
      // deliver a message that claims a model change that did not happen).
      if (model !== undefined) {
        try {
          await agent.switchModel(worker.conversationId, model);
        } catch (err) {
          const note = `model switch for ${task} failed (${actor}): ${String(err)}`;
          await store.addActivity(run.id, "executor", note);
          return { ok: false, message: note };
        }
        await store.updateWorker(worker.id, { model });
      }
      await agent.sendMessage(
        worker.conversationId,
        `MANAGER NUDGE:\n${message}`,
      );
      // A nudge restarts the loop; clear a blocked flag so the monitor can
      // re-derive the phase from fresh state.
      if (worker.phase === "blocked") {
        await store.updateWorker(worker.id, {
          phase: "working",
          blockReason: null,
        });
      }
      const note =
        `nudge delivered to ${task} (${actor})` +
        (model !== undefined ? ` [model → ${model}]` : "") +
        `: ${message.slice(0, 200)}`;
      await store.addActivity(run.id, "executor", note);
      return { ok: true, message: note };
    },

    async inspectWorker(run, task, mode = "recent") {
      // getWorkerByTask is scoped to run.id, so a task slug from a different
      // run's worker never resolves here — cross-run isolation is preserved.
      const worker = await store.getWorkerByTask(run.id, task);
      if (!worker) return { ok: false, message: `no worker "${task}" in run` };
      if (!worker.conversationId) {
        return { ok: false, message: `worker "${task}" has no conversation` };
      }
      const events = await agent.listRecentEvents(worker.conversationId, 100);
      const view = renderTranscript(events, mode);
      const header = [
        `WORKER TRANSCRIPT — task: ${task} · branch: ${worker.branch} · phase: ${worker.phase} · mode: ${mode}`,
        `READ-ONLY — use nudge_worker to influence the worker.`,
        ``,
      ].join("\n");
      await store.addActivity(
        run.id,
        "executor",
        `inspected ${task} (mode: ${mode})`,
      );
      return { ok: true, message: `${header}${view}` };
    },

    async applyManagerCommand(run, command) {
      switch (command.command) {
        case "propose_plan":
          // Plans are stored by the monitor while planning or plan-ready;
          // once a wave has launched, changing the plan requires human action.
          return { ok: false, message: "propose_plan handled by planning flow" };
        case "launch_wave":
          return executor.launchWave(run, command.wave);
        case "nudge_worker":
          return executor.nudgeWorker(
            run,
            command.task,
            command.message,
            "manager",
            command.model,
          );
        case "inspect_worker":
          return executor.inspectWorker(run, command.task, command.mode);
        case "request_human": {
          await store.addRunNote(run.id, `MANAGER REQUESTS HUMAN: ${command.reason}`);
          const note = `manager requested human attention: ${command.reason}`;
          await store.addActivity(run.id, "manager", note);
          return { ok: true, message: note };
        }
        case "complete_run":
          return executor.completeRun(run, command.summary);
      }
    },

    async completeRun(run, summary) {
      const workers = await store.listWorkers(run.id);
      const notReady = workers.filter(
        (w) => w.phase !== "pr-open" && w.phase !== "done",
      );
      if (notReady.length > 0) {
        return {
          ok: false,
          message: `cannot complete: ${notReady
            .map((w) => `${w.task}(${w.phase})`)
            .join(", ")} not at pr-open`,
        };
      }
      for (const w of workers) {
        if (w.phase !== "done") await store.updateWorker(w.id, { phase: "done" });
      }
      await store.updateRun(run.id, { status: "completed" });
      await store.addRunNote(run.id, `SUMMARY: ${summary}`);
      await store.addActivity(run.id, "manager", `run completed: ${summary}`);
      return { ok: true, message: "run completed" };
    },

    async cancelRun(run) {
      await store.updateRun(run.id, { status: "cancelled" });
      await store.addActivity(run.id, "human", "run cancelled");
      return { ok: true, message: "run cancelled" };
    },
  };

  return executor;
}
