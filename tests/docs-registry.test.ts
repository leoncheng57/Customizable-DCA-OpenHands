// Keeps the Contributing doc registry (client/lib/docs.ts) and the markdown
// corpus in lockstep: every file in docs/ (plus CONTRIBUTING.md) must have a
// registry card, every registry entry must point at a real file, and the
// slugs/routes must be well-formed. Catches the classic drift failure where
// someone adds a doc that never shows up in the app.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, docByHref, docBySlug, loadDocSource } from "../client/lib/docs.js";

const ROOT = join(__dirname, "..");

describe("docs registry", () => {
  it("registers every markdown file in docs/", () => {
    const files = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"));
    const registered = new Set(DOCS.map((d) => d.path));
    const missing = files.filter((f) => !registered.has(`docs/${f}`));
    expect(missing, `docs without a registry entry in client/lib/docs.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("includes the root CONTRIBUTING.md", () => {
    expect(DOCS.some((d) => d.path === "CONTRIBUTING.md")).toBe(true);
  });

  it("every registry entry points at an existing file with a heading", () => {
    for (const doc of DOCS) {
      const body = readFileSync(join(ROOT, doc.path), "utf8");
      expect(body.startsWith("# "), `${doc.path} should start with an H1`).toBe(true);
    }
  });

  it("slugs are unique and URL-safe", () => {
    const slugs = DOCS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("resolves doc-relative links the way DocPage renders them", () => {
    expect(docByHref("architecture.md")?.slug).toBe("architecture");
    expect(docByHref("docs/testing.md")?.slug).toBe("testing");
    expect(docByHref("../CONTRIBUTING.md")?.slug).toBe("contributing");
    expect(docByHref("risk-map.md#dimensions")?.slug).toBe("risk-map");
    expect(docByHref("../.github/risk-map.yml")).toBeUndefined();
    expect(docByHref("https://docs.openhands.dev")).toBeUndefined();
  });

  it("internal .md links inside the corpus all resolve to registered docs", () => {
    for (const doc of DOCS) {
      const body = readFileSync(join(ROOT, doc.path), "utf8");
      for (const m of body.matchAll(/\]\((?!https?:\/\/|#)([^)]+\.md)(#[^)]*)?\)/g)) {
        const href = m[1];
        // Non-doc markdown (e.g. tests/e2e/README.md) is allowed — it just
        // won't render in-app. Only docs/-or-root targets must be registered.
        if (/(^|\/)(docs\/)?[a-z0-9-]+\.md$/i.test(href) && !href.includes("tests/")) {
          expect(docByHref(href), `${doc.path} links to unregistered doc: ${href}`).toBeTruthy();
        }
      }
    }
  });

  it("docBySlug round-trips", () => {
    for (const doc of DOCS) expect(docBySlug(doc.slug)).toBe(doc);
  });

  // A beta badge in the UI is a promise that the page says WHY. Without this
  // the badge and the prose drift apart the first time someone edits one.
  it("beta docs carry a beta notice and a known-limitations section", () => {
    for (const doc of DOCS.filter((d) => d.status === "beta")) {
      const body = readFileSync(join(ROOT, doc.path), "utf8");
      expect(body, `${doc.path} is status:beta but has no beta notice`).toMatch(/Status: beta/i);
      expect(body, `${doc.path} is status:beta but has no known-limitations section`).toMatch(
        /^## Known limitations \(beta\)$/m,
      );
    }
  });

  it("marks packaging as beta while the package is not at dev parity", () => {
    expect(docBySlug("packaging")?.status).toBe("beta");
  });

  // Regression guard for the eager-bundle rewrite of loadDocSource: every
  // registry entry (root CONTRIBUTING.md + all docs/*.md) must resolve to
  // real, non-empty bundled markdown — not just a filesystem-readable file.
  // Catches drift between DOCS paths and the import.meta.glob patterns in
  // client/lib/docs.ts before it ever reaches the browser.
  it("every DOCS entry has loadable bundled content matching the file on disk", async () => {
    for (const doc of DOCS) {
      const bundled = await loadDocSource(doc);
      expect(typeof bundled, `${doc.path} did not resolve to a string`).toBe("string");
      expect(bundled.length, `${doc.path} resolved to empty content`).toBeGreaterThan(0);
      const onDisk = readFileSync(join(ROOT, doc.path), "utf8");
      expect(bundled, `${doc.path} bundled content diverges from the file on disk`).toBe(onDisk);
    }
  });

  it("loadDocSource rejects a doc whose path isn't bundled", async () => {
    const fake = { slug: "nope", path: "docs/does-not-exist.md", title: "x", blurb: "x", category: "history" as const };
    await expect(loadDocSource(fake)).rejects.toThrow(/doc source not bundled/);
  });
});
