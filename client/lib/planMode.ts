// Plan/Build mode, client side. The mode is not client state: it is derived
// from the conversation's upstream confirmation policy (NeverConfirm = build,
// anything gated = plan), so the badge and the approve-plan flow can never
// drift from what the agent-server actually enforces.

export type ConversationMode = "build" | "plan";

export function conversationMode(
  policy: { kind?: string } | null | undefined,
): ConversationMode {
  const kind = policy?.kind ?? "";
  return kind === "" || kind === "NeverConfirm" ? "build" : "plan";
}
