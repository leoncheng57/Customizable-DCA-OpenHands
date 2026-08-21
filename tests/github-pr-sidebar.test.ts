import { describe, expect, it } from "vitest";
import { extractMrUrls, type TranscriptItem, type TranscriptEvent } from "../client/lib/events.js";
import {
  parsePullRequestUrl,
  mapPullToMrInfo,
  mapIssueCommentToMrComment,
  mapCheckRunToJob,
} from "../server/github.js";

function ev(partial: Partial<TranscriptEvent>): TranscriptEvent {
  return { id: "e1", kind: "tool", label: "terminal", text: "", timestamp: "2024-01-01T00:00:00Z", ...partial };
}

describe("extractMrUrls — GitHub PR detection", () => {
  it("detects GitHub PR URLs in tool output alongside GitLab MRs", () => {
    const items: TranscriptItem[] = [
      {
        type: "toolCall",
        tool: ev({ id: "t1", text: "gh pr create" }),
        output: ev({ id: "o1", kind: "observation", text: "https://github.com/leoncheng57/Customizable-DCA-OpenHands/pull/42" }),
      },
      {
        type: "event",
        event: ev({ id: "e2", kind: "message", text: "also see https://gitlab.com/group/repo/-/merge_requests/7" }),
      },
    ];
    expect(extractMrUrls(items)).toEqual([
      "https://github.com/leoncheng57/Customizable-DCA-OpenHands/pull/42",
      "https://gitlab.com/group/repo/-/merge_requests/7",
    ]);
  });

  it("strips trailing tab segments/punctuation and dedupes", () => {
    const items: TranscriptItem[] = [
      { type: "event", event: ev({ id: "e1", kind: "message", text: "PR at https://github.com/o/r/pull/9/files." }) },
      { type: "event", event: ev({ id: "e2", kind: "message", text: "(https://github.com/o/r/pull/9)" }) },
    ];
    expect(extractMrUrls(items)).toEqual(["https://github.com/o/r/pull/9"]);
  });

  it("finds PR URLs in the final response", () => {
    expect(extractMrUrls([], "Opened https://github.com/o/r/pull/3")).toEqual([
      "https://github.com/o/r/pull/3",
    ]);
  });

  it("ignores non-PR github.com URLs", () => {
    expect(extractMrUrls([], "https://github.com/o/r/issues/3")).toEqual([]);
  });
});

describe("parsePullRequestUrl", () => {
  it("parses owner/repo and number", () => {
    expect(parsePullRequestUrl("https://github.com/o/r/pull/12")).toEqual({
      host: "github.com",
      projectPath: "o/r",
      iid: 12,
    });
  });

  it("tolerates tab segments, query, fragment, trailing slash", () => {
    expect(parsePullRequestUrl("https://github.com/o/r/pull/12/files?w=1#x")?.iid).toBe(12);
    expect(parsePullRequestUrl("https://github.com/o/r/pull/12/")?.iid).toBe(12);
  });

  it("rejects non-PR and malformed URLs", () => {
    expect(parsePullRequestUrl("https://github.com/o/r/issues/12")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/o/r/pull/0")).toBeNull();
    expect(parsePullRequestUrl("not a url")).toBeNull();
  });
});

describe("mapPullToMrInfo", () => {
  const base = { number: 5, html_url: "https://github.com/o/r/pull/5", title: "Fix", body: "desc" };

  it("maps open + mergeable to opened/can_be_merged", () => {
    const info = mapPullToMrInfo("o/r", { ...base, state: "open", mergeable: true }, null);
    expect(info).toMatchObject({ iid: 5, state: "opened", mergeStatus: "can_be_merged", description: "desc" });
  });

  it("distinguishes merged from closed via merged_at", () => {
    expect(mapPullToMrInfo("o/r", { ...base, state: "closed", merged_at: "2024-01-02T00:00:00Z" }, null).state).toBe("merged");
    expect(mapPullToMrInfo("o/r", { ...base, state: "closed", merged_at: null }, null).state).toBe("closed");
  });

  it("reports checking while GitHub recomputes mergeability", () => {
    expect(mapPullToMrInfo("o/r", { ...base, state: "open", mergeable: null }, null).mergeStatus).toBe("checking");
    expect(mapPullToMrInfo("o/r", { ...base, state: "open", mergeable: false }, null).mergeStatus).toBe("cannot_be_merged");
  });
});

describe("mapIssueCommentToMrComment", () => {
  it("maps author/body/createdAt with resolved=false", () => {
    expect(
      mapIssueCommentToMrComment({ id: 1, user: { login: "alice" }, body: "hi", created_at: "2024-01-01T00:00:00Z" }),
    ).toEqual({ id: 1, author: "alice", body: "hi", createdAt: "2024-01-01T00:00:00Z", resolved: false });
  });
});

describe("mapCheckRunToJob", () => {
  it("maps completed success with duration", () => {
    const job = mapCheckRunToJob({
      name: "build",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/o/r/runs/1",
      started_at: "2024-01-01T00:00:00Z",
      completed_at: "2024-01-01T00:01:30Z",
    });
    expect(job).toEqual({ name: "build", status: "success", webUrl: "https://github.com/o/r/runs/1", duration: 90 });
  });

  it("maps in-progress to running and null duration", () => {
    expect(mapCheckRunToJob({ name: "test", status: "in_progress" })).toMatchObject({ status: "running", duration: null });
  });

  it("maps failure/cancelled/skipped conclusions", () => {
    expect(mapCheckRunToJob({ status: "completed", conclusion: "failure" }).status).toBe("failed");
    expect(mapCheckRunToJob({ status: "completed", conclusion: "cancelled" }).status).toBe("canceled");
    expect(mapCheckRunToJob({ status: "completed", conclusion: "skipped" }).status).toBe("skipped");
  });
});
