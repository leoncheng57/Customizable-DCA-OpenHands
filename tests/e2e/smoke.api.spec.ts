// API-tier smoke tests — no LLM calls. Everything here exercises the BFF
// against a live agent-canvas container without ever starting an agent run.
import { expect, test } from "@playwright/test";

const LOCAL_REPO = "/home/openhands/workspace/local/demo-project";

test.describe("status & auth", () => {
  test("status reports a configured, allowlisted deployment", async ({ request }) => {
    const res = await request.get("/api/openhands/status");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.allowlisted).toBe(true);
    expect(body.server?.version).toBeTruthy();
    expect(Array.isArray(body.models)).toBe(true);
  });

  test("non-allowlisted identity is rejected (fail-closed)", async ({ request }) => {
    const res = await request.get("/api/openhands/conversations", {
      headers: { "x-forwarded-email": "stranger@evil.example" },
    });
    expect(res.status()).toBe(403);
  });

  test("manager routes carry their own gate", async ({ request }) => {
    const res = await request.get("/api/openhands/manager/runs", {
      headers: { "x-forwarded-email": "stranger@evil.example" },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe("local folders", () => {
  test("lists the seeded project", async ({ request }) => {
    const res = await request.get("/api/openhands/local-folders");
    expect(res.status()).toBe(200);
    const { items } = await res.json();
    expect(items).toContainEqual({ name: "demo-project", path: "demo-project" });
  });

  test("create rejects traversal localPath", async ({ request }) => {
    for (const localPath of ["../etc", "a/../../b", ".git", "demo/.hidden", "a\\b"]) {
      const res = await request.post("/api/openhands/conversations", {
        data: { prompt: "hi", localPath },
      });
      expect(res.status(), `localPath=${JSON.stringify(localPath)}`).toBe(400);
    }
  });

  test("create rejects localPath + repoUrl together", async ({ request }) => {
    const res = await request.post("/api/openhands/conversations", {
      data: { prompt: "hi", localPath: "demo-project", repoUrl: "https://gitlab.com/x/y" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("mutually exclusive");
  });

  test("create rejects a disallowed repo host", async ({ request }) => {
    const res = await request.post("/api/openhands/conversations", {
      data: { prompt: "hi", repoUrl: "https://example.com/x/y" },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("workspace read endpoints (agent-server backed)", () => {
  test("git changes work against the mounted local project", async ({ request }) => {
    const res = await request.get(`/api/openhands/git/changes?repo=${encodeURIComponent(LOCAL_REPO)}`);
    expect(res.status()).toBe(200);
  });

  test("git commits list the seed commit", async ({ request }) => {
    const res = await request.get(`/api/openhands/git/commits?repo=${encodeURIComponent(LOCAL_REPO)}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("init");
  });

  test("path traversal in repo param is rejected", async ({ request }) => {
    const res = await request.get(`/api/openhands/git/changes?repo=${encodeURIComponent("/etc")}`);
    expect(res.status()).toBe(400);
  });

  test("disk usage responds", async ({ request }) => {
    const res = await request.get("/api/openhands/disk");
    expect(res.status()).toBe(200);
    expect(await res.json()).toBeTruthy();
  });

  test("files tree lists the mounted local project", async ({ request }) => {
    const res = await request.get(`/api/openhands/files/tree?path=${encodeURIComponent(LOCAL_REPO)}`);
    expect(res.status()).toBe(200);
  });

  test("terminal command audit responds", async ({ request }) => {
    const res = await request.get("/api/openhands/terminal/commands");
    expect(res.status()).toBe(200);
  });
});

test.describe("tools & health", () => {
  test("aggregated tools health reports a healthy terminal and integrations", async ({ request }) => {
    const res = await request.get("/api/openhands/tools");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.server.health).toBe("ok");
    const terminal = body.tools.find((t: { id: string }) => t.id === "terminal");
    expect(terminal?.health).toBe("ok");
    const fileEditor = body.tools.find((t: { id: string }) => t.id === "file_editor");
    expect(fileEditor?.health).toBe("ok");
    const ids = body.integrations.map((i: { id: string }) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining(["github", "gitlab", "ntfy", "manager-db", "gh-cli", "glab-cli", "acli"]),
    );
    // MCP entries surface from agent settings with a health verdict each.
    for (const entry of body.mcp) {
      expect(["ok", "unknown", "error"]).toContain(entry.health);
    }
    // Every entry carries a valid health state.
    for (const entry of [...body.tools, ...body.integrations]) {
      expect(["ok", "unknown", "error"]).toContain(entry.health);
    }
  });

  // Global skill toggles (decision #17). Read-only here: the suite must not
  // mutate the shared agent-server's default profile, so writes are only
  // probed through their validation errors.
  test("skills settings expose the effective toggle state and the load_* sources", async ({ request }) => {
    const res = await request.get("/api/openhands/skills");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.skills)).toBe(true);
    expect(Array.isArray(body.disabledSkills)).toBe(true);
    // The three source flags are always present, even on a stock profile where
    // they are all false (which is why the UI distinguishes "loading off" from
    // "nothing installed").
    for (const key of ["user", "public", "project"]) {
      expect(typeof body.sources[key]).toBe("boolean");
    }
    expect(body.loadingDisabled).toBe(!body.sources.user && !body.sources.public && !body.sources.project);
    // "could not enumerate" is a distinct state from "there are none".
    expect(typeof body.loadedUnavailable).toBe("boolean");
    for (const skill of body.skills) {
      expect(typeof skill.name).toBe("string");
      // The merged effective boolean is exactly install-level AND not denied.
      expect(skill.enabled).toBe(skill.installEnabled && !skill.denied);
      expect(skill.denied).toBe(body.disabledSkills.includes(skill.name));
      // Every row is actionable: installed, auto-loaded, or a denied ghost.
      expect(typeof skill.autoLoaded).toBe("boolean");
      expect(skill.installed || skill.autoLoaded || skill.denied).toBe(true);
      // The upstream skill body must never reach the client.
      expect(skill).not.toHaveProperty("content");
    }
  });

  test("skills PATCH rejects malformed bodies without touching upstream", async ({ request }) => {
    for (const data of [{}, { unknownField: 1 }, { skills: { "../../settings": false } }, { skills: { pdf: "yes" } }]) {
      const res = await request.patch("/api/openhands/skills", { data });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });
});
