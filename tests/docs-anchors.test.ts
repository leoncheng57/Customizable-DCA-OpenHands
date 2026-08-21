// In-page anchors in the Contributing reader (DocPage's DocHeading + the
// slugifier in client/lib/doc-links.ts).
//
// The bug this locks down: DocPage had a branch for `href="#…"` but never
// emitted a single heading `id`, so every one of the corpus's own
// cross-references scrolled nowhere. Fixing the renderer is only half of it —
// the anchors must also keep RESOLVING as the prose changes, and they must
// keep matching GitHub, which renders the same files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, docByHref, docRoute, DOCS_BASE, slugifyHeading } from "../client/lib/docs.js";

const ROOT = join(__dirname, "..");

/** Headings as DocPage sees them: markdown ATX headings outside fenced code
 * blocks, with inline markup flattened the way `nodeText` flattens the
 * rendered React tree (`` `code` `` → code, `[a](b)` → a, `**b**` → b). */
function headings(markdown: string): { level: number; text: string; slug: string }[] {
  const out: { level: number; text: string; slug: string }[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2]
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_)/g, "");
    out.push({ level: m[1].length, text, slug: slugifyHeading(text) });
  }
  return out;
}

const CORPUS = DOCS.map((doc) => ({
  doc,
  body: readFileSync(join(ROOT, doc.path), "utf8"),
}));

describe("slugifyHeading", () => {
  // Fixtures are real GitHub anchors for the corpus's own headings.
  it.each([
    ["Known limitations (beta)", "known-limitations-beta"],
    ["Verifying a release", "verifying-a-release"],
    ["Releases", "releases"],
    ["The primitives (`client/ds/`)", "the-primitives-clientds"],
    ["HTTPS via `tailscale serve`", "https-via-tailscale-serve"],
    ["Screenshots in PRs (the `@shots` harness)", "screenshots-in-prs-the-shots-harness"],
    // Stripped punctuation leaves its spaces behind → doubled hyphens, exactly
    // as github-slugger does. Collapsing them would break copied anchors.
    ["Packaging & install — the single-click distribution", "packaging--install--the-single-click-distribution"],
    ["  Trimmed  ", "trimmed"],
    ["Under_scores and-dashes kept", "under_scores-and-dashes-kept"],
    ["Ünïcode stays", "ünïcode-stays"],
    ["🚀 emoji dropped", "-emoji-dropped"],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(slugifyHeading(input)).toBe(expected);
  });

  it("is idempotent on its own output", () => {
    for (const { body } of CORPUS) {
      for (const h of headings(body)) expect(slugifyHeading(h.slug)).toBe(h.slug);
    }
  });
});

describe("docRoute", () => {
  it("builds index, doc and fragment routes off one prefix", () => {
    expect(docRoute()).toBe(DOCS_BASE);
    expect(docRoute("testing")).toBe(`${DOCS_BASE}/testing`);
    expect(docRoute("cicd", "#releases")).toBe(`${DOCS_BASE}/cicd#releases`);
  });

  it("matches the routes declared in main.tsx", () => {
    const main = readFileSync(join(ROOT, "client/main.tsx"), "utf8");
    expect(main).toContain(`path="${DOCS_BASE}"`);
    expect(main).toContain(`path="${DOCS_BASE}/:slug"`);
  });
});

describe("corpus anchors", () => {
  // Stateless slugification is only safe while headings are unique per doc:
  // two identical headings would silently produce two identical ids and the
  // anchor would always land on the first. GitHub disambiguates with -1/-2;
  // rather than replicate that, keep the invariant and fail loudly.
  it("no document repeats a heading slug", () => {
    for (const { doc, body } of CORPUS) {
      const slugs = headings(body).map((h) => h.slug);
      const dupes = slugs.filter((s, i) => s && slugs.indexOf(s) !== i);
      expect([...new Set(dupes)], `${doc.path} has duplicate heading anchors`).toEqual([]);
    }
  });

  it("every heading produces a non-empty id", () => {
    for (const { doc, body } of CORPUS) {
      for (const h of headings(body)) {
        expect(h.slug, `${doc.path}: heading ${JSON.stringify(h.text)} slugifies to nothing`).not.toBe("");
      }
    }
  });

  // The payoff: every `](#frag)` and `](other.md#frag)` in the corpus must hit
  // a real heading. This is what turns "anchors render" into "anchors work",
  // and it fails the build when prose is renamed out from under a link.
  it("every in-corpus fragment link resolves to a heading in its target doc", () => {
    const slugsByPath = new Map(CORPUS.map(({ doc, body }) => [doc.path, new Set(headings(body).map((h) => h.slug))]));
    let checked = 0;
    for (const { doc, body } of CORPUS) {
      for (const m of body.matchAll(/\]\((?!https?:\/\/)([^)\s]*)#([^)\s]+)\)/g)) {
        const [, path, fragment] = m;
        const targetPath = path === "" ? doc.path : docByHref(`${path}#${fragment}`)?.path;
        // Fragments into non-doc files (e.g. a .yml on GitHub) aren't ours.
        if (!targetPath) continue;
        checked += 1;
        expect(
          slugsByPath.get(targetPath),
          `${doc.path} links to ${path || "(self)"}#${fragment} but that doc isn't in the registry`,
        ).toBeDefined();
        expect(
          [...slugsByPath.get(targetPath)!],
          `${doc.path} links to ${path || "(self)"}#${fragment}, which matches no heading there`,
        ).toContain(fragment);
      }
    }
    // Guard against the matcher silently going blind.
    expect(checked, "expected the corpus to contain fragment links").toBeGreaterThan(0);
  });
});
