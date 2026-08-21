// Guards for pure helpers ported from the upstream internal implementation:
// EU model routing (setup.ts), project-path normalization (contracts.ts),
// merged-MR done fallback (monitor.ts derivePhase), and transcript redaction.
import { describe, expect, it } from "vitest";
import {
  isOpenAiModel,
  llmSettingsForModel,
  OPENAI_EU_BASE_URL_DEFAULT,
} from "../server/openhands/setup.js";
import {
  normalizeProjectPath,
  projectPathFromRepoUrl,
} from "../server/openhands/manager/contracts.js";
import { derivePhase } from "../server/openhands/manager/monitor.js";
import { redactSecrets } from "../server/redact-secrets.js";

describe("llmSettingsForModel (EU OpenAI routing)", () => {
  it("pins the EU base_url for openai/ ids", () => {
    expect(
      llmSettingsForModel(
        { openaiApiKey: "", openaiEuBaseUrl: "" },
        "openai/gpt-5.6-luna",
      ),
    ).toEqual({
      model: "openai/gpt-5.6-luna",
      base_url: OPENAI_EU_BASE_URL_DEFAULT,
    });
  });

  it("honors a configured OPENAI_BASE_URL override", () => {
    expect(
      llmSettingsForModel(
        { openaiApiKey: "secret", openaiEuBaseUrl: "https://example.test/v1" },
        "openai/gpt-5.6-terra",
      ),
    ).toEqual({
      model: "openai/gpt-5.6-terra",
      base_url: "https://example.test/v1",
      api_key: "secret",
    });
  });

  it("leaves anthropic ids on litellm's provider default", () => {
    expect(
      llmSettingsForModel(
        { openaiApiKey: "", openaiEuBaseUrl: "" },
        "anthropic/claude-sonnet-5",
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-5",
    });
    expect(isOpenAiModel("anthropic/claude-sonnet-5")).toBe(false);
  });
});

describe("normalizeProjectPath", () => {
  it("strips GitLab web-route suffixes", () => {
    expect(normalizeProjectPath("group/sub/repo/-/issues/42")).toBe("group/sub/repo");
    expect(normalizeProjectPath("group/repo")).toBe("group/repo");
  });

  it("degrades a pasted issue URL to its project path", () => {
    expect(projectPathFromRepoUrl("https://gitlab.com/group/repo/-/issues/42")).toBe("group/repo");
  });
});

describe("derivePhase merged-MR fallback", () => {
  it("treats a merged MR as done even when the agent errored", () => {
    expect(
      derivePhase({
        executionStatus: "error",
        branchExists: false,
        mrUrl: "https://gitlab.com/g/r/-/merge_requests/1",
        runCompleted: false,
        mrMerged: true,
      }),
    ).toEqual({ phase: "done", blockReason: null });
  });

  it("still blocks when finished without an MR", () => {
    expect(
      derivePhase({
        executionStatus: "finished",
        branchExists: false,
        mrUrl: null,
        runCompleted: false,
      }).phase,
    ).toBe("blocked");
  });
});

describe("redactSecrets (vendored)", () => {
  it("masks token-shaped values", () => {
    // Assembled at runtime so secret scanners don't flag the fixture itself.
    const fakeToken = ["glpat", "abc123def456ghi789jk"].join("-");
    const out = redactSecrets(`GITLAB_TOKEN=${fakeToken}`);
    expect(out).not.toContain(fakeToken);
  });
});
