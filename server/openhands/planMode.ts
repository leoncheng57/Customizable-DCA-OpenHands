// Plan mode: research-first conversations where the agent explores freely but
// every write is gated behind an explicit approval, mirroring Claude Code's
// "plan" permission mode and opencode's "plan" agent.
//
// Enforcement is the agent-server's confirmation machinery, not prompt trust:
// the conversation is created with a ConfirmRisky policy plus the
// LLMSecurityAnalyzer, so LOW-risk (read-only) actions run unprompted while
// MEDIUM/HIGH/UNKNOWN-risk actions park the run in `waiting_for_confirmation`
// until the user approves or rejects them (SDK ≥1.40 — same contract the
// pinned agent-canvas image ships). Approving the plan switches the policy to
// NeverConfirm mid-conversation via POST /{id}/confirmation_policy, which is
// exactly the Build behaviour, so "plan → build" needs no new conversation.

export type ConversationMode = "build" | "plan";

/** Parse the client-supplied mode; null = invalid (fail the request). */
export function parseConversationMode(input: unknown): ConversationMode | null {
  if (input === undefined || input === null || input === "") return "build";
  if (input === "build" || input === "plan") return input;
  return null;
}

/**
 * Confirmation policy for a mode. Plan gates MEDIUM and riskier (ConfirmRisky
 * compares reflexively, so threshold MEDIUM confirms MEDIUM and HIGH) and
 * treats UNKNOWN as unsafe — an action the LLM did not risk-label must not
 * slip through the write gate.
 */
export function confirmationPolicyForMode(mode: ConversationMode): Record<string, unknown> {
  return mode === "plan"
    ? { kind: "ConfirmRisky", threshold: "MEDIUM", confirm_unknown: true }
    : { kind: "NeverConfirm" };
}

/**
 * Analyzer that populates per-action `security_risk` from the LLM's own
 * assessment. Without it every action stays UNKNOWN and ConfirmRisky would
 * degrade into AlwaysConfirm (read-only exploration would prompt too).
 */
export function securityAnalyzerForMode(mode: ConversationMode): Record<string, unknown> | null {
  return mode === "plan" ? { kind: "LLMSecurityAnalyzer" } : null;
}

/**
 * Classify a conversation's live mode from the upstream `confirmation_policy`
 * on GET /conversations/:id — the policy IS the mode, so there is no separate
 * state to persist or drift.
 */
export function modeFromConfirmationPolicy(policy: unknown): ConversationMode {
  const kind = typeof (policy as { kind?: unknown })?.kind === "string" ? (policy as { kind: string }).kind : "";
  return kind === "" || kind === "NeverConfirm" ? "build" : "plan";
}

/**
 * Prepended to the initial task in plan mode. The confirmation policy is the
 * hard gate; this preamble makes the agent lean into researching and writing
 * a reviewable plan instead of bouncing off rejected write attempts.
 */
export const PLAN_MODE_PREAMBLE = [
  "PLAN MODE — research first, do not implement yet.",
  "Explore the workspace with read-only commands, then present a concrete implementation plan:",
  "the goal, the relevant files, step-by-step changes, and how to verify them.",
  "Do NOT create, modify, or delete any files, and do NOT run commands that change state",
  "(installs, builds that write artifacts, git commits); write actions require explicit user",
  "approval in this mode and will be held. End your reply with the plan and wait — the user",
  "will review it and either refine it with you or approve it, unlocking implementation.",
].join(" ");

/** Follow-up message delivered when the user approves the plan. */
export const PLAN_APPROVED_MESSAGE =
  "The plan is approved — plan mode is off and write actions no longer need approval. Implement the plan now.";

/** Wrap the user's task with the plan-mode preamble when applicable. */
export function taskForMode(mode: ConversationMode, task: string): string {
  return mode === "plan" ? `${PLAN_MODE_PREAMBLE}\n\n${task}` : task;
}
