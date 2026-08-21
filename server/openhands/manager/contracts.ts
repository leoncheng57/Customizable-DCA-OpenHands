/**
 * Prompt templating for manager and worker conversations, plus the fenced
 * JSON command protocol.
 *
 * The manager conversation issues commands as fenced blocks:
 *
 *   ```manager-command
 *   { "command": "nudge_worker", "task": "alert-dedupe", "message": "..." }
 *   ```
 *
 * The monitor parses these from the manager's messages, validates them
 * server-side, executes them, and replies with an EXECUTOR RESULT message.
 * This keeps the trust boundary in deterministic code: the manager has no
 * capability that is not an explicitly validated command, and there is no
 * merge command at all.
 */

import type {
  ManagerCommand,
  RunPlan,
  RunRecord,
  WaveSpec,
  WorkerSpec,
} from "./types.js";
import {
  INSPECT_MODES,
  MANAGER_COMMAND_NAMES,
  MAX_WORKERS_PER_WAVE,
} from "./types.js";

const COMMAND_FENCE_RE = /```manager-command\s*\n([\s\S]*?)```/g;

/** Extract and structurally validate manager commands from message text. */
export function parseManagerCommands(text: string): {
  commands: ManagerCommand[];
  errors: string[];
} {
  const commands: ManagerCommand[] = [];
  const errors: string[] = [];
  for (const match of text.matchAll(COMMAND_FENCE_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch (err) {
      errors.push(`unparseable manager-command block: ${String(err)}`);
      continue;
    }
    const candidate = parsed as Record<string, unknown>;
    const name = candidate?.command;
    if (
      typeof name !== "string" ||
      !(MANAGER_COMMAND_NAMES as readonly string[]).includes(name)
    ) {
      errors.push(`unknown manager command: ${String(name)}`);
      continue;
    }
    const err = validateCommandShape(candidate);
    if (err) {
      errors.push(err);
      continue;
    }
    commands.push(candidate as unknown as ManagerCommand);
  }
  return { commands, errors };
}

function validateCommandShape(c: Record<string, unknown>): string | null {
  switch (c.command) {
    case "propose_plan": {
      const planErr = validatePlan(c.plan as RunPlan | undefined);
      return planErr ? `propose_plan: ${planErr}` : null;
    }
    case "launch_wave":
      return typeof c.wave === "number" && Number.isInteger(c.wave) && c.wave >= 1
        ? null
        : "launch_wave: wave must be a positive integer";
    case "nudge_worker": {
      if (
        typeof c.task !== "string" ||
        c.task.length === 0 ||
        typeof c.message !== "string" ||
        c.message.length === 0
      ) {
        return "nudge_worker: task and message are required strings";
      }
      if (c.model !== undefined && (typeof c.model !== "string" || c.model.length === 0)) {
        return "nudge_worker: model, when present, must be a non-empty string";
      }
      return null;
    }
    case "inspect_worker": {
      if (typeof c.task !== "string" || c.task.length === 0) {
        return "inspect_worker: task is a required string";
      }
      if (
        c.mode !== undefined &&
        !(INSPECT_MODES as readonly string[]).includes(c.mode as string)
      ) {
        return `inspect_worker: mode must be one of ${INSPECT_MODES.join(", ")}`;
      }
      return null;
    }
    case "request_human":
      return typeof c.reason === "string" && c.reason.length > 0
        ? null
        : "request_human: reason is required";
    case "complete_run":
      return typeof c.summary === "string" && c.summary.length > 0
        ? null
        : "complete_run: summary is required";
    default:
      return `unknown command ${String(c.command)}`;
  }
}

const TASK_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const BRANCH_RE = /^[\w./-]{3,120}$/;
// Host allowlist for run repositories. GitHub is first-class alongside the
// GitLab hosts (the monitor joins branches/PRs through a REST adapter per
// host); override with OPENHANDS_REPO_URL_PATTERN for anything else.
const REPO_RE = (() => {
  const pattern = process.env.OPENHANDS_REPO_URL_PATTERN;
  if (pattern) {
    try {
      return new RegExp(pattern);
    } catch {
      /* invalid pattern → default, matching the BFF's behavior */
    }
  }
  return /^https:\/\/(gitlab\.com|github\.com)\/[\w./-]+$/;
})();
export const REPO_HOSTS_HINT = "gitlab.com or github.com";

/** True when the run's repository lives on github.com. */
export function isGitHubRepo(repoUrl: string | null | undefined): boolean {
  if (!repoUrl) return false;
  try {
    return new URL(repoUrl).hostname === "github.com";
  } catch {
    return false;
  }
}

/**
 * GitLab web routes append "/-/<section>/..." (issues, merge_requests, tree…)
 * after the project path; strip that so a pasted issue/MR URL degrades to the
 * project it belongs to instead of producing a path no API call can resolve.
 */
export function normalizeProjectPath(path: string): string {
  const cut = path.indexOf("/-/");
  return cut === -1 ? path : path.slice(0, cut);
}

/** "https://gitlab.com/group/sub/repo" -> "group/sub/repo" (null when invalid). */
export function projectPathFromRepoUrl(repoUrl: string): string | null {
  if (!REPO_RE.test(repoUrl)) return null;
  const path = normalizeProjectPath(
    new URL(repoUrl).pathname.replace(/^\/+|\/+$|\.git$/g, ""),
  );
  return path.length > 0 ? path : null;
}

/** Structural validation of a run plan (manual or manager-proposed). */
export function validatePlan(plan: RunPlan | undefined | null): string | null {
  if (!plan || !Array.isArray(plan.waves) || plan.waves.length === 0) {
    return "plan must contain at least one wave";
  }
  if (plan.repoUrl !== undefined && (typeof plan.repoUrl !== "string" || !REPO_RE.test(plan.repoUrl))) {
    return `repoUrl must be an https URL on ${REPO_HOSTS_HINT}`;
  }
  const seenTasks = new Set<string>();
  const seenBranches = new Set<string>();
  for (const [i, wave] of plan.waves.entries()) {
    if (wave.index !== i + 1) return `wave ${i + 1} has index ${wave.index}`;
    if (typeof wave.baseBranch !== "string" || !BRANCH_RE.test(wave.baseBranch)) {
      return `wave ${wave.index}: invalid baseBranch`;
    }
    if (!Array.isArray(wave.workers) || wave.workers.length === 0) {
      return `wave ${wave.index} has no workers`;
    }
    if (wave.workers.length > MAX_WORKERS_PER_WAVE) {
      return `wave ${wave.index} exceeds the ${MAX_WORKERS_PER_WAVE}-worker cap`;
    }
    for (const w of wave.workers) {
      if (typeof w.task !== "string" || !TASK_SLUG_RE.test(w.task)) {
        return `wave ${wave.index}: invalid task slug "${String(w.task)}"`;
      }
      if (seenTasks.has(w.task)) return `duplicate task "${w.task}"`;
      seenTasks.add(w.task);
      if (typeof w.branch !== "string" || !BRANCH_RE.test(w.branch)) {
        return `task ${w.task}: invalid branch`;
      }
      if (seenBranches.has(w.branch)) return `duplicate branch "${w.branch}"`;
      seenBranches.add(w.branch);
      if (typeof w.contract !== "string" || w.contract.length < 20) {
        return `task ${w.task}: contract is required (>= 20 chars)`;
      }
    }
  }
  return null;
}

/** The worker's opening message: clone instructions + contract + rules. */
export function buildWorkerPrompt(input: {
  run: RunRecord;
  wave: WaveSpec;
  worker: WorkerSpec;
}): string {
  const { run, wave, worker } = input;
  // Defensive: the approval gate guarantees a resolved repo before any wave
  // launches; a null here means a caller bypassed it.
  if (!run.repoUrl) {
    throw new Error("cannot build a worker prompt: the run has no repository resolved");
  }
  const owns = worker.ownsPaths?.length
    ? `\nYou OWN these paths: ${worker.ownsPaths.join(", ")}.`
    : "";
  const offLimits = worker.offLimitsPaths?.length
    ? `\nDo NOT modify: ${worker.offLimitsPaths.join(", ")}.`
    : "";
  return [
    `You are the "${worker.task}" worker in a manager/worker parallel run.`,
    ``,
    `Setup:`,
    `1. Clone ${run.repoUrl} into the workspace (plain \`git clone\` — https credentials are preconfigured) and cd into it.`,
    `2. Check out the base ref: \`git checkout ${wave.baseBranch}\` (fetch it first if needed).`,
    `3. Create your branch: \`git checkout -b ${worker.branch}\`.`,
    ``,
    `Your contract:`,
    worker.contract,
    owns + offLimits,
    ``,
    `Rules (non-negotiable):`,
    `- Work ONLY within your ownership boundary.`,
    `- Run the repository's verification gate (lint, typecheck, tests) before committing.`,
    `- Commit with a clear message, then push: \`git push -u origin ${worker.branch}\`.`,
    isGitHubRepo(run.repoUrl)
      ? `- Open a DRAFT pull request against ${wave.baseBranch} using \`gh pr create --draft\` (gh is authenticated), otherwise print the exact PR-creation URL. Include an honest verification section.`
      : `- Open a DRAFT merge request against ${wave.baseBranch} using \`glab\` if available, otherwise print the exact MR-creation URL. Include an honest verification section.`,
    `- NEVER merge anything. NEVER push ${run.baseBranch} or any branch that is not yours.`,
    `- If you cannot proceed (missing credential, scope conflict, destructive action needed), STOP and clearly state what blocks you — do not guess around it.`,
    `- When done, print a short summary with the branch, MR URL, and residual risks, then stop.`,
  ].join("\n");
}

/**
 * The prompt sent when PROMOTING an existing conversation into a manager:
 * the conversation so far IS the goal context, so the plan should be drawn
 * from it (plus the optional extra note the human typed while promoting).
 */
export function buildPromotionPrompt(input: {
  run: RunRecord;
  hasManualPlan: boolean;
}): string {
  const { run, hasManualPlan } = input;
  const hasRepo = Boolean(run.repoUrl);
  const goalNote =
    run.goal.trim().length > 0
      ? `Additional note from the human while promoting:\n${run.goal}\n`
      : "";
  const planPart = hasManualPlan
    ? [
        `The human attached a plan while promoting: ${JSON.stringify(run.plan)}`,
        `A human will approve it before anything launches; you do not need to`,
        `propose one. Acknowledge briefly and stop.`,
      ]
    : [
        `Derive the goal from THIS CONVERSATION so far${goalNote ? " and the note above" : ""},`,
        `then partition it into FILE-DISJOINT tasks. ${
          hasRepo
            ? `If you have not already
explored the repository in this conversation, clone ${run.repoUrl}
and study its layout first.`
            : `No repository is recorded for
this run yet: determine the repository from THIS CONVERSATION (the repo you
have been working on or discussing) and include its https URL as a top-level
"repoUrl" field in the propose_plan JSON below. Only https URLs on
${REPO_HOSTS_HINT.replace(", or ", " or ")} are accepted.`
        } Tasks that must touch the same file`,
        `belong in a later wave, stacked on the branch that owns that file.`,
        ``,
        `Propose the plan by emitting exactly one fenced command block:`,
        "```manager-command",
        `{ "command": "propose_plan", "rationale": "<why this partition>",`,
        ...(hasRepo ? [] : [`  "repoUrl": "<https repo url>",`]),
        `  "plan": { "waves": [ { "index": 1, "baseBranch": "${run.baseBranch}",`,
        `    "workers": [ { "task": "<slug>", "branch": "<branch>",`,
        `      "contract": "<deliverable, ownership boundaries, verification gate>",`,
        `      "ownsPaths": ["..."], "offLimitsPaths": ["..."] } ] } ] } }`,
        "```",
        `Constraints: at most ${run.maxWorkersPerWave} workers per wave; task`,
        `slugs are lowercase-kebab; contracts must name exact paths owned.`,
        `A human approves the plan before anything launches. Until then the`,
        `plan is NOT frozen: if scope changes during review (or the human`,
        `rejects the plan), re-emit propose_plan — it replaces the pending plan.`,
      ];
  return [
    `PROMOTION: this conversation is now the MANAGER of a parallel coding-agent`,
    `run. You plan and decide; you never implement. A deterministic executor`,
    `launches workers, monitors them, and validates every command you issue.`,
    ``,
    hasRepo
      ? `Repository: ${run.repoUrl} (base branch: ${run.baseBranch})`
      : `Repository: not resolved yet (base branch: ${run.baseBranch}) — you must identify it (see below).`,
    goalNote,
    ...planPart,
    ``,
    `From now on the executor wakes you with TRIGGER messages (worker blocked,`,
    `wave complete, run review). Respond to those with exactly one`,
    `\`\`\`manager-command block: nudge_worker {task, message, model?} ·`,
    `launch_wave {wave} · inspect_worker {task, mode?} (READ-ONLY view into a`,
    `worker's transcript; mode: recent | last-message | last-error | last-tool) ·`,
    `request_human {reason} · complete_run {summary}.`,
    `A nudge's optional "model" switches that worker's LLM for its next steps`,
    `(allowlisted models only).`,
    `There is no merge command; humans merge. Do not emit command blocks`,
    `outside fences. Keep responses short.`,
  ].join("\n");
}

/** Structured trigger message the monitor sends to wake the manager. */
export function buildTriggerMessage(input: {
  kind: string;
  detail: string;
  boardSummary: string;
}): string {
  return [
    `TRIGGER: ${input.kind}`,
    input.detail,
    ``,
    `Board:`,
    input.boardSummary,
    ``,
    `Respond with exactly one \`\`\`manager-command block (nudge_worker /`,
    `launch_wave / inspect_worker / request_human / complete_run). If no`,
    `action is needed, reply "no action" without a command block.`,
  ].join("\n");
}
