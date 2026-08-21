// Registry for the Contributing section. The markdown files (root
// CONTRIBUTING.md + docs/*.md) are the single source of truth — readable on
// GitHub AND rendered in-app by DocPage.tsx. They are bundled *eagerly* as raw
// strings at build time via import.meta.glob({ eager: true }), so the prod
// server needs no filesystem access, there is no per-doc lazy-import chunk
// that can fail to resolve at runtime, and dev edits still hot-reload.
// tests/docs-registry.test.ts enforces that this registry and the docs/
// directory stay in sync.

export const REPO_URL = "https://github.com/leoncheng57/Customizable-DCA-OpenHands";

// Route prefix + heading-anchor slugs live in lib/doc-links.ts (no imports, so
// bundle-cheap consumers like lib/palette.ts can use them without dragging the
// eager markdown glob below into the main chunk). Re-exported here so doc-page
// call sites need only one import.
export { DOCS_BASE, docRoute, slugifyHeading } from "./doc-links.js";

export type DocCategory = "start" | "architecture" | "guides" | "history";

/** Maturity of the *feature* a doc describes, not of the prose. "beta" means
 * the thing works end-to-end but has known gaps, so the page carries a badge
 * and the doc itself must spell those gaps out. */
export type DocStatus = "beta";

export interface DocMeta {
  slug: string;
  /** Repo-relative path — also the GitHub blob-link target. */
  path: string;
  title: string;
  blurb: string;
  category: DocCategory;
  status?: DocStatus;
}

export const DOCS: DocMeta[] = [
  {
    slug: "contributing",
    path: "CONTRIBUTING.md",
    title: "Contributing",
    blurb: "Entry point: setup, checks to run, conventions, and the guide index.",
    category: "start",
  },
  {
    slug: "architecture",
    path: "docs/architecture.md",
    title: "Architecture",
    blurb: "Topology, conversation lifecycle, BFF ↔ agent-server contract, preview proxy.",
    category: "architecture",
  },
  {
    slug: "openhands",
    path: "docs/openhands.md",
    title: "How OpenHands works",
    blurb: "The agent underneath: SDK, agent-server API, agent-canvas image — with links into the official docs.",
    category: "architecture",
  },
  {
    slug: "folder-structure",
    path: "docs/folder-structure.md",
    title: "Folder structure",
    blurb: "Annotated tree — what lives where, and where new code goes.",
    category: "architecture",
  },
  {
    slug: "risk-map",
    path: "docs/risk-map.md",
    title: "Risk map",
    blurb: "Every area scored on security, stability, blast radius, and LLM cost.",
    category: "architecture",
  },
  {
    slug: "extending",
    path: "docs/extending.md",
    title: "Extending & forking",
    blurb: "Copy this repo and build your own coding-agent IDE — every seam documented.",
    category: "guides",
  },
  {
    slug: "testing",
    path: "docs/testing.md",
    title: "Testing",
    blurb: "Five tiers, cheapest first — from typecheck to one paid real-LLM run.",
    category: "guides",
  },
  {
    slug: "design-system",
    path: "docs/design-system.md",
    title: "Design system",
    blurb: "Vendored primitives, theme tokens, Tailwind v4 conventions.",
    category: "guides",
  },
  {
    slug: "cicd",
    path: "docs/cicd.md",
    title: "CI/CD",
    blurb: "The GitHub Actions pipeline, including per-PR risk labels.",
    category: "guides",
  },
  {
    slug: "packaging",
    path: "docs/packaging.md",
    title: "Packaging & install",
    blurb: "The single-click distribution: image + bundle, install/operate, cutting and verifying a release.",
    category: "guides",
    status: "beta",
  },
  {
    slug: "agent-sessions",
    path: "docs/agent-sessions.md",
    title: "Agent sessions",
    blurb: "Self-development: the agent improving this app from inside it.",
    category: "guides",
  },
  {
    slug: "reading-paths",
    path: "docs/reading-paths.md",
    title: "Reading paths",
    blurb: "What an agent — or a new human — actually opens, in what order, for each kind of change.",
    category: "guides",
  },
  {
    slug: "llms",
    path: "docs/llms.md",
    title: "LLMs",
    blurb: "Models, keys, the server-side allowlist, and spend control.",
    category: "guides",
  },
  {
    slug: "debugging",
    path: "docs/debugging.md",
    title: "Logs & debugging",
    blurb: "Where every layer logs + a symptom-indexed playbook.",
    category: "guides",
  },
  {
    slug: "adding-tools",
    path: "docs/adding-tools.md",
    title: "Adding tools",
    blurb: "Give the agent CLIs, MCP servers, and credentials — mostly without code.",
    category: "guides",
  },
  {
    slug: "mobile",
    path: "docs/mobile.md",
    title: "Mobile & Tailscale",
    blurb: "Phone access over your tailnet: dev/release paths, macOS firewall, HTTPS, add-to-home-screen.",
    category: "guides",
  },
  {
    slug: "decisions",
    path: "docs/decisions.md",
    title: "Decisions log",
    blurb: "Append-only record of durable choices and why.",
    category: "history",
  },
];

export const CATEGORY_LABELS: Record<DocCategory, string> = {
  start: "Start here",
  architecture: "Architecture",
  guides: "Guides",
  history: "History",
};

export function docBySlug(slug: string): DocMeta | undefined {
  return DOCS.find((d) => d.slug === slug);
}

/** Resolve a repo-relative markdown link (as written inside the docs, e.g.
 * "architecture.md", "../CONTRIBUTING.md", "docs/testing.md") to a doc slug,
 * or undefined when it isn't a registered doc. */
export function docByHref(href: string): DocMeta | undefined {
  const clean = href.split("#")[0].replace(/^(\.\/|\.\.\/)+/, "").replace(/^docs\//, "");
  if (!clean.endsWith(".md")) return undefined;
  return DOCS.find((d) => d.path === clean || d.path === `docs/${clean}`);
}

// Raw markdown, bundled eagerly (no per-doc dynamic import). Keys are
// import-relative ("../../docs/foo.md"); values are the file contents as
// plain strings, resolved at build time.
const docFiles = {
  ...import.meta.glob("../../docs/*.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../CONTRIBUTING.md", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

/** Kept async for call-site compatibility (DocPage awaits it), even though
 * the source is already in memory post-bundle. */
export async function loadDocSource(meta: DocMeta): Promise<string> {
  const source = docFiles[`../../${meta.path}`];
  if (source === undefined) throw new Error(`doc source not bundled: ${meta.path}`);
  return source;
}
