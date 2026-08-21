// Skill toggles, client side. Whether a skill is on is NOT client state: it is
// derived from the two upstream facts the BFF hands over — the install-level
// `enabled` flag and the global `agent_context.disabled_skills` deny-list — so
// a checkbox can never drift from what the agent-server actually loads.
//
// `skillEffectiveEnabled` below is a DELIBERATE duplicate of the function of
// the same name in server/openhands/skills.ts, exactly as this file's sibling
// client/lib/planMode.ts duplicates `modeFromConfirmationPolicy`. The reasons
// are the same:
//
//   * The server is the source of truth; this is a re-derivation, not a
//     second implementation of policy. If the two ever disagree the *server*
//     is right and this file is the bug.
//   * Sharing the module would drag the server's upstream request/response
//     types into the browser bundle for four lines of boolean logic.
//   * Drift is prevented by test, not by import: tests/skills.test.ts asserts
//     one shared case table against BOTH copies, so any divergence fails CI.
//
// Keep the bodies identical. If you change one, change the other and extend
// the shared case table.

/** EFFECTIVE state: install-level enabled AND not on the deny-list. */
export function skillEffectiveEnabled(
  skill: { name?: string | null; enabled?: boolean | null } | null | undefined,
  disabledSkills: readonly string[] | null | undefined,
): boolean {
  const name = typeof skill?.name === "string" ? skill.name : "";
  if (name === "") return false;
  const installEnabled = skill?.enabled !== false;
  const denied = (disabledSkills ?? []).includes(name);
  return installEnabled && !denied;
}
