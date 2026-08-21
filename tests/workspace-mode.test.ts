import { describe, expect, it } from "vitest";
import {
  activeLocalFolderUses,
  workspaceMode,
  LOCAL_WORKSPACE_ROOT,
  SESSIONS_WORKSPACE_ROOT,
} from "../client/lib/workspace.js";

describe("workspaceMode", () => {
  it("classifies a local project folder and extracts the relative name", () => {
    expect(workspaceMode(`${LOCAL_WORKSPACE_ROOT}/my-project`)).toEqual({
      kind: "local",
      folder: "my-project",
    });
    expect(workspaceMode(`${LOCAL_WORKSPACE_ROOT}/nested/repo`)).toEqual({
      kind: "local",
      folder: "nested/repo",
    });
  });

  it("treats the projects root itself as local with an empty folder", () => {
    expect(workspaceMode(LOCAL_WORKSPACE_ROOT)).toEqual({ kind: "local", folder: "" });
  });

  it("classifies a per-conversation sessions dir as isolated", () => {
    expect(workspaceMode(`${SESSIONS_WORKSPACE_ROOT}/abc-123`)).toEqual({ kind: "session" });
    expect(workspaceMode(SESSIONS_WORKSPACE_ROOT)).toEqual({ kind: "session" });
  });

  it("returns unknown for missing or out-of-tree paths", () => {
    expect(workspaceMode(undefined)).toEqual({ kind: "unknown" });
    expect(workspaceMode(null)).toEqual({ kind: "unknown" });
    expect(workspaceMode("")).toEqual({ kind: "unknown" });
    expect(workspaceMode("/etc/passwd")).toEqual({ kind: "unknown" });
    // A sibling that merely shares a prefix must not be mistaken for local.
    expect(workspaceMode(`${LOCAL_WORKSPACE_ROOT}-evil/x`)).toEqual({ kind: "unknown" });
  });
});

describe("activeLocalFolderUses", () => {
  const local = (folder: string) => ({ working_dir: `${LOCAL_WORKSPACE_ROOT}/${folder}` });

  it("groups only active conversations by their local folder", () => {
    const uses = activeLocalFolderUses([
      { id: "a", title: "fix login", execution_status: "running", workspace: local("foo") },
      { id: "b", title: "add tests", execution_status: "waiting_for_confirmation", workspace: local("foo") },
      { id: "c", title: "done work", execution_status: "finished", workspace: local("foo") },
      { id: "d", title: "other", execution_status: "running", workspace: local("bar") },
    ]);
    expect(uses.get("foo")).toEqual([
      { id: "a", title: "fix login" },
      { id: "b", title: "add tests" },
    ]);
    expect(uses.get("bar")).toEqual([{ id: "d", title: "other" }]);
  });

  it("ignores session and unknown workspaces", () => {
    const uses = activeLocalFolderUses([
      { id: "s", execution_status: "running", workspace: { working_dir: `${SESSIONS_WORKSPACE_ROOT}/x` } },
      { id: "u", execution_status: "running", workspace: null },
    ]);
    expect(uses.size).toBe(0);
  });

  it("defaults a missing title to null", () => {
    const uses = activeLocalFolderUses([
      { id: "a", execution_status: "running", workspace: local("foo") },
    ]);
    expect(uses.get("foo")).toEqual([{ id: "a", title: null }]);
  });
});
