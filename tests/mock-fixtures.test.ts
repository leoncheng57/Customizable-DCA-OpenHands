// Honesty guard for the demo backend (client/mock/).
//
// The GitHub Pages build ships a simulated backend so every screen has
// something to show. The rule for that data is simple and absolute: it is
// INVENTED. No real employer, product, host, repository, user or working
// directory may appear in it — not in a conversation title, not in a git path,
// not in an MR author, not in a terminal transcript. A public demo that leaks
// the names it was developed against is worse than an empty state.
//
// Four independent agents fill in the handler groups, so this test is the
// backstop rather than a code review. It passes with today's empty stubs and
// starts biting the moment a fixture lands.
//
// The scan is scoped to client/mock/** on purpose: prose elsewhere (the repo
// URL in client/lib/docs.ts, this comment) is fine — the ban is on DEMO DATA.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { registerGroup, registeredRoutes, matchRoute, resetRegistry } from "../client/mock/registry.js";
import { handlers as conversations } from "../client/mock/conversations.js";
import { handlers as manager } from "../client/mock/manager.js";
import { handlers as settings } from "../client/mock/settings.js";
import { handlers as workspace } from "../client/mock/workspace.js";
import type { HandlerGroup } from "../client/mock/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOCK_DIR = join(REPO_ROOT, "client", "mock");

/**
 * Banned terms, assembled from fragments.
 *
 * This is not decoration: the repo-wide deny scan greps `tests/` too, so a
 * guard file that spelled its own deny list out would be the first thing to
 * trip it. Reassembling at runtime keeps the guard greppable-clean while still
 * matching the real strings.
 */
const DENIED: Array<{ label: string; needle: string }> = [
  { label: "the employer this was built at", needle: "dee" + "pl" },
  { label: "an internal platform name", needle: "hel" + "ix" },
  { label: "an internal environment name", needle: "arn" + "-dev" },
  { label: "an internal git host", needle: "git." + "dee" + "pl" + ".dev" },
  { label: "the author's GitHub username", needle: "leon" + "cheng" },
  { label: "the private predecessor repo", needle: "custom-dca-ide" + "-with-openhands" },
  { label: "the predecessor product name", needle: "OpenHands " + "Local" },
  { label: "a real working-directory name", needle: "Users/" + "bsjl" },
];

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".md", ".txt", ""]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (TEXT_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

describe("demo fixtures (client/mock)", () => {
  const files = walk(MOCK_DIR);

  it("finds the mock directory", () => {
    // Guards against the scan silently passing because the glob went stale.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith("types.ts"))).toBe(true);
  });

  it.each(files.map((file) => [relative(REPO_ROOT, file), file] as const))(
    "keeps real-world names out of %s",
    (rel, file) => {
      const haystack = readFileSync(file, "utf8").toLowerCase();
      for (const { label, needle } of DENIED) {
        const hit = haystack.includes(needle.toLowerCase());
        expect(
          hit,
          [
            ``,
            `${rel} contains "${needle}" (${label}).`,
            ``,
            `Demo data must be invented. This build is published at a public URL,`,
            `so every repo path, hostname, author, project folder and conversation`,
            `title in client/mock/ has to be made up — never copied from a real`,
            `workspace, employer or account.`,
            ``,
            `Pick a neutral placeholder instead (e.g. "acme/checkout-service",`,
            `"/workspace/checkout-service", "avery.stone", "example.test").`,
            ``,
          ].join("\n"),
        ).toBe(false);
      }
    },
  );
});

describe("handler-group contract", () => {
  const groups: HandlerGroup[] = [conversations, manager, workspace, settings];

  it("ships exactly the four owned groups, each uniquely named", () => {
    expect(groups.map((g) => g.name).sort()).toEqual(["conversations", "manager", "settings", "workspace"]);
  });

  it("uses well-formed route keys", () => {
    // "<METHOD> /path" — the registry rejects anything else at register time,
    // but the message here is the one a group owner should see first.
    const key = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;
    for (const group of groups) {
      for (const route of [...Object.keys(group.routes), ...Object.keys(group.streams ?? {})]) {
        expect(key.test(route), `${group.name}: route key ${JSON.stringify(route)} must be "<METHOD> /path"`).toBe(true);
      }
    }
  });

  it("registers all four groups without a route collision", () => {
    resetRegistry();
    expect(() => groups.forEach(registerGroup)).not.toThrow();
    // Registration is idempotent — StrictMode / HMR must not double-register.
    expect(() => groups.forEach(registerGroup)).not.toThrow();
    resetRegistry();
  });

  it("matches params and prefers the most specific pattern", () => {
    resetRegistry();
    registerGroup({
      name: "spec-fixture",
      routes: {
        "GET /preview/*": () => "wildcard",
        "GET /preview/config": () => "exact",
        "GET /conversations/:id/events": () => "events",
        "GET /git/commits/:sha/changes": () => "commit-changes",
      },
    });
    expect(matchRoute("GET", "/preview/config")?.handler({} as never)).toBe("exact");
    expect(matchRoute("GET", "/preview/anything/else")?.handler({} as never)).toBe("wildcard");
    expect(matchRoute("GET", "/conversations/abc-123/events")?.params).toEqual({ id: "abc-123" });
    expect(matchRoute("GET", "/git/commits/deadbeef/changes")?.params).toEqual({ sha: "deadbeef" });
    expect(matchRoute("POST", "/preview/config")).toBeNull();
    expect(registeredRoutes()).toContain("GET /preview/config");
    resetRegistry();
  });
});
