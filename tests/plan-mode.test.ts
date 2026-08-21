import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAN_APPROVED_MESSAGE,
  PLAN_MODE_PREAMBLE,
  confirmationPolicyForMode,
  modeFromConfirmationPolicy,
  parseConversationMode,
  securityAnalyzerForMode,
  taskForMode,
} from "../server/openhands/planMode.js";
import { conversationMode } from "../client/lib/planMode.js";

describe("parseConversationMode", () => {
  it("defaults to build when the field is absent", () => {
    expect(parseConversationMode(undefined)).toBe("build");
    expect(parseConversationMode(null)).toBe("build");
    expect(parseConversationMode("")).toBe("build");
  });

  it("accepts the two explicit modes", () => {
    expect(parseConversationMode("build")).toBe("build");
    expect(parseConversationMode("plan")).toBe("plan");
  });

  it("rejects anything else (fail the request, not silently build)", () => {
    expect(parseConversationMode("PLAN")).toBeNull();
    expect(parseConversationMode("yolo")).toBeNull();
    expect(parseConversationMode(42)).toBeNull();
    expect(parseConversationMode({ mode: "plan" })).toBeNull();
  });
});

describe("confirmationPolicyForMode", () => {
  it("build runs free (NeverConfirm)", () => {
    expect(confirmationPolicyForMode("build")).toEqual({ kind: "NeverConfirm" });
  });

  it("plan gates MEDIUM+ writes and treats unlabeled actions as unsafe", () => {
    expect(confirmationPolicyForMode("plan")).toEqual({
      kind: "ConfirmRisky",
      threshold: "MEDIUM",
      confirm_unknown: true,
    });
  });
});

describe("securityAnalyzerForMode", () => {
  it("plan needs the LLM analyzer so read-only actions stay unprompted", () => {
    expect(securityAnalyzerForMode("plan")).toEqual({ kind: "LLMSecurityAnalyzer" });
  });

  it("build sends none", () => {
    expect(securityAnalyzerForMode("build")).toBeNull();
  });
});

describe("taskForMode", () => {
  it("prefixes the plan preamble in plan mode only", () => {
    expect(taskForMode("plan", "add dark mode")).toBe(`${PLAN_MODE_PREAMBLE}\n\nadd dark mode`);
    expect(taskForMode("build", "add dark mode")).toBe("add dark mode");
  });

  it("preamble forbids implementation and asks for a reviewable plan", () => {
    expect(PLAN_MODE_PREAMBLE).toMatch(/PLAN MODE/);
    expect(PLAN_MODE_PREAMBLE).toMatch(/Do NOT create, modify, or delete/);
    expect(PLAN_APPROVED_MESSAGE).toMatch(/approved/i);
  });
});

// Server- and client-side mode classification must agree: the policy IS the
// mode, and both sides derive it the same way.
describe("mode from confirmation policy", () => {
  const cases: Array<[unknown, "build" | "plan"]> = [
    [{ kind: "NeverConfirm" }, "build"],
    [undefined, "build"],
    [null, "build"],
    [{}, "build"],
    [{ kind: "ConfirmRisky", threshold: "MEDIUM" }, "plan"],
    [{ kind: "AlwaysConfirm" }, "plan"],
  ];

  it("server classification", () => {
    for (const [policy, expected] of cases) {
      expect(modeFromConfirmationPolicy(policy)).toBe(expected);
    }
  });

  it("client classification matches the server", () => {
    for (const [policy, expected] of cases) {
      expect(conversationMode(policy as { kind?: string } | null | undefined)).toBe(expected);
    }
  });

  it("round-trips the policies the create route emits", () => {
    expect(modeFromConfirmationPolicy(confirmationPolicyForMode("plan"))).toBe("plan");
    expect(modeFromConfirmationPolicy(confirmationPolicyForMode("build"))).toBe("build");
  });
});

// Plan mode used to announce itself four times over: a header badge, a blue
// banner, an "Approve plan & build" button and an "Exit plan mode" button —
// all of which duplicated the composer's Build⇄Plan toggle and cost vertical
// space the pinned composer needs. The toggle is now the single control and
// the amber composer is the single signal. These are source-level assertions:
// ConversationPage pulls in the whole app (router, SSE, api client), so
// rendering it in vitest would test the harness, not the chrome.
describe("conversation plan chrome", () => {
  const source = readFileSync(join(__dirname, "..", "client", "pages", "Conversation.tsx"), "utf8");

  it("drops the badge, banner and approve/exit buttons", () => {
    for (const gone of ["plan-mode-badge", "plan-mode-banner", "approve-plan-button", "Exit plan mode", "approvePlan"]) {
      expect(source, `${gone} should be gone — the composer toggle replaced it`).not.toContain(gone);
    }
  });

  it("keeps the composer toggle as the only mode control", () => {
    expect(source).toContain('data-testid="composer-mode-toggle"');
    expect(source).toContain('data-testid="composer-mode-build"');
    expect(source).toContain('data-testid="composer-mode-plan"');
  });

  it("signals plan mode with amber composer chrome, not sky", () => {
    expect(source).toContain('"data-plan-mode": "true"');
    expect(source).toContain("border-t-amber-500");
    expect(source).toContain("bg-amber-500/15");
    // Sky was the old badge/toggle colour; amber is the warning tone that
    // matches "your writes are gated".
    expect(source).not.toContain("sky-500");
  });

  // Plan mode gates writes; the generic approve/reject prompt is what unblocks
  // them turn by turn. Removing the plan banner must not have taken it out.
  it("leaves the waiting_for_confirmation approve/reject flow intact", () => {
    expect(source).toContain("respondToConfirmation");
    expect(source).toContain("waiting_for_confirmation");
  });

  // The conversation column is the only pinned-footer route: the transcript
  // scrolls, the composer and status bar do not.
  it("pins the composer and status bar inside a self-contained column", () => {
    expect(source).toContain("h-full min-h-0 flex-col overflow-hidden");
    expect(source).toContain("shrink-0 px-3 pb-3 sm:px-6");
    // The old magic-pixel viewport maths is what pushed the composer off-screen.
    expect(source).not.toContain("h-[calc(100vh-2.25rem)]");
  });
});
