import { describe, expect, it } from "vitest";
import {
  isGitHubRepo,
  projectPathFromRepoUrl,
  validatePlan,
  buildWorkerPrompt,
} from "../server/openhands/manager/contracts.js";
import { mapCheckRunsToPipelineStatus, mapPullToMrSummary } from "../server/github.js";
import type { RunRecord, RunPlan } from "../server/openhands/manager/types.js";

const GH_URL = "https://github.com/leoncheng57/Customizable-DCA-OpenHands";

const basePlan: RunPlan = {
  waves: [
    {
      index: 1,
      baseBranch: "main",
      workers: [{ task: "do-thing", branch: "feat/do-thing", contract: "Deliver the thing with tests and verification." }],
    },
  ],
};

describe("manager github support", () => {
  it("accepts github.com repo URLs", () => {
    expect(projectPathFromRepoUrl(GH_URL)).toBe("leoncheng57/Customizable-DCA-OpenHands");
    expect(projectPathFromRepoUrl("https://gitlab.com/group/repo")).toBe("group/repo");
    expect(projectPathFromRepoUrl("https://example.com/x/y")).toBeNull();
    expect(validatePlan({ ...basePlan, repoUrl: GH_URL })).toBeNull();
    expect(validatePlan({ ...basePlan, repoUrl: "https://example.com/x/y" })).toContain("repoUrl");
  });

  it("detects github hosts", () => {
    expect(isGitHubRepo(GH_URL)).toBe(true);
    expect(isGitHubRepo("https://gitlab.com/g/r")).toBe(false);
    expect(isGitHubRepo(null)).toBe(false);
    expect(isGitHubRepo("not a url")).toBe(false);
  });

  it("worker prompt says PR + gh for github, MR + glab for gitlab", () => {
    const run = { repoUrl: GH_URL, baseBranch: "main" } as unknown as RunRecord;
    const wave = basePlan.waves[0];
    const worker = wave.workers[0];
    const ghPrompt = buildWorkerPrompt({ run, wave, worker });
    expect(ghPrompt).toContain("pull request");
    expect(ghPrompt).toContain("gh pr create");
    const glRun = { ...run, repoUrl: "https://gitlab.com/g/r" } as unknown as RunRecord;
    const glPrompt = buildWorkerPrompt({ run: glRun, wave, worker });
    expect(glPrompt).toContain("merge request");
    expect(glPrompt).toContain("glab");
  });
});

describe("github adapter mapping", () => {
  it("maps PR states to gitlab vocabulary", () => {
    expect(mapPullToMrSummary({ number: 5, state: "open" }).state).toBe("opened");
    expect(mapPullToMrSummary({ number: 5, state: "closed", merged_at: "2026-01-01T00:00:00Z" }).state).toBe("merged");
    expect(mapPullToMrSummary({ number: 5, state: "closed", merged_at: null }).state).toBe("closed");
    const full = mapPullToMrSummary({
      number: 7,
      html_url: "https://github.com/o/r/pull/7",
      head: { ref: "feat/x" },
      title: "t",
      state: "open",
      user: { login: "leon" },
    });
    expect(full).toMatchObject({ iid: 7, web_url: "https://github.com/o/r/pull/7", source_branch: "feat/x", author: { username: "leon" } });
  });

  it("collapses check runs to one pipeline status", () => {
    expect(mapCheckRunsToPipelineStatus([])).toBeNull();
    expect(mapCheckRunsToPipelineStatus([{ status: "in_progress" }])).toBe("running");
    expect(mapCheckRunsToPipelineStatus([{ status: "completed", conclusion: "success" }])).toBe("success");
    expect(
      mapCheckRunsToPipelineStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failed");
    expect(mapCheckRunsToPipelineStatus([{ status: "completed", conclusion: "cancelled" }])).toBe("canceled");
    expect(mapCheckRunsToPipelineStatus([{ status: "completed", conclusion: "skipped" }])).toBe("skipped");
  });
});
