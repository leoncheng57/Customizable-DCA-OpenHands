import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorktreeCommand,
  localWorkingDir,
  removeWorktreeCommand,
} from "../server/openhands/setup.js";

const ROOT = "/home/openhands/workspace/local";

describe("localWorkingDir", () => {
  it("accepts simple folder names", () => {
    expect(localWorkingDir("my-project")).toBe(`${ROOT}/my-project`);
    expect(localWorkingDir("Org Repo 2")).toBe(`${ROOT}/Org Repo 2`);
    expect(localWorkingDir("a/b/c")).toBe(`${ROOT}/a/b/c`);
  });

  it("trims surrounding slashes and whitespace", () => {
    expect(localWorkingDir(" /foo/ ")).toBe(`${ROOT}/foo`);
  });

  it("rejects traversal and absolute escapes", () => {
    expect(localWorkingDir("..")).toBeNull();
    expect(localWorkingDir("../etc")).toBeNull();
    expect(localWorkingDir("a/../../b")).toBeNull();
    expect(localWorkingDir("a/..")).toBeNull();
    // Leading slashes are trimmed, so an "absolute" path is reinterpreted as
    // relative — it stays INSIDE the projects mount, never the host root.
    expect(localWorkingDir("/etc/passwd")).toBe(`${ROOT}/etc/passwd`);
  });

  it("rejects dotfile and hidden segments", () => {
    expect(localWorkingDir(".git")).toBeNull();
    expect(localWorkingDir("repo/.git")).toBeNull();
    expect(localWorkingDir(".hidden/x")).toBeNull();
  });

  it("rejects tricky characters", () => {
    expect(localWorkingDir("a\\b")).toBeNull();
    expect(localWorkingDir("a\0b")).toBeNull();
    expect(localWorkingDir("a//b")).toBeNull(); // empty segment
    expect(localWorkingDir("-flag")).toBeNull(); // must start with word char
    expect(localWorkingDir("trail ")).toBe(`${ROOT}/trail`); // outer trim
    expect(localWorkingDir("in ner/ok")).toBe(`${ROOT}/in ner/ok`);
  });

  it("rejects oversize inputs", () => {
    expect(localWorkingDir("x".repeat(600))).toBeNull();
    expect(localWorkingDir(Array(10).fill("a").join("/"))).toBeNull(); // > 8 segments
  });

  it("rejects empty", () => {
    expect(localWorkingDir("")).toBeNull();
    expect(localWorkingDir("   ")).toBeNull();
    expect(localWorkingDir("///")).toBeNull();
  });
});

describe("worktree commands", () => {
  it("creates the sessions parent and a detached worktree from the selected checkout's HEAD", () => {
    expect(createWorktreeCommand("/workspace/local/my repo", "/workspace/sessions/id")).toBe(
      "mkdir -p '/workspace/sessions' && git -C '/workspace/local/my repo' worktree add --detach '/workspace/sessions/id' HEAD",
    );
  });

  it("quotes source and target paths and force-removes rejected worktrees", () => {
    expect(removeWorktreeCommand("/workspace/local/a'b", "/workspace/sessions/x; rm -rf /")).toBe(
      "git -C '/workspace/local/a'\\''b' worktree remove --force '/workspace/sessions/x; rm -rf /'",
    );
  });

  it("creates and removes a real isolated Git worktree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openhands-worktree-test-"));
    const source = path.join(root, "source repo");
    const target = path.join(root, "sessions", "session-id");
    try {
      mkdirSync(source);
      execFileSync("git", ["init", "-q", source]);
      execFileSync("git", ["-C", source, "config", "user.name", "OpenHands Test"]);
      execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", source, "config", "commit.gpgSign", "false"]);
      writeFileSync(path.join(source, "tracked.txt"), "committed\n");
      execFileSync("git", ["-C", source, "add", "tracked.txt"]);
      execFileSync("git", ["-C", source, "commit", "-qm", "initial"]);

      execFileSync("sh", ["-c", createWorktreeCommand(source, target)], { stdio: "ignore" });
      expect(existsSync(path.join(target, "tracked.txt"))).toBe(true);

      execFileSync("sh", ["-c", removeWorktreeCommand(source, target)], { stdio: "ignore" });
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
