// The declared set of PR screenshots — data only, no Playwright runtime import
// (the `Page` import is type-only, so `scripts/shots-manifest.ts` can pull this
// module in under plain tsx without booting a browser).
//
// This array is the single source of truth for a shot's identity. It is read
// twice: `screenshots.spec.ts` generates one test per entry, and the manifest
// script writes the same list to disk BEFORE Playwright starts. That ordering
// matters — the CI comment diffs declared-against-produced, so the declaration
// has to survive a run that crashes before any test executes. A manifest
// emitted from inside the run could only ever describe a run that got far
// enough to emit it.
//
// Naming: `<area>-<subject>[-<variant>]`, lower-case and hyphenated, matching
// the convention in docs/testing.md.
// `area` is the feature under test (`palette`); for a future full-page shot it
// is effectively the route (`hub`, `terminal`), at which point the semantic and
// route-derived schemes converge. The name is also the filename stem and the
// Playwright test title — declared here once, never repeated.
import type { Page } from "@playwright/test";

export interface Shot {
  /** Filename stem AND test title. Lower-case, hyphenated, unique. */
  name: string;
  /** One line, rendered in the sticky PR comment. Say what the shot PROVES,
   *  not what it depicts — a reviewer downloading a zip needs the "so what". */
  description: string;
  theme: "light" | "dark";
  /** Typed into the palette input after it opens. */
  query?: string;
  /** Anything further: assert an end state, navigate, wait on a selector. */
  after?: (page: Page) => Promise<void>;
}

/** Invented, publishable conversation fixture. Titles are chosen so the shots
 *  demonstrate ranking across kinds — several word-match "con" and "plan" the
 *  way real session titles do — plus one untitled entry to exercise the
 *  id-fallback label. Never real data: CI has an empty agent-canvas and a local
 *  run has real titles, so neither is comparable or safe to publish. */
export const CONVERSATIONS = [
  { id: "a1b2c3d4-0001-4000-8000-000000000001", title: "Fix login flake in CI", execution_status: "finished" },
  { id: "a1b2c3d4-0002-4000-8000-000000000002", title: "Add config validation to setup", execution_status: "running" },
  { id: "a1b2c3d4-0003-4000-8000-000000000003", title: "Plan the release checklist", execution_status: "paused" },
  { id: "a1b2c3d4-0004-4000-8000-000000000004", title: "Convert docs to markdown", execution_status: "finished" },
  { id: "a1b2c3d4-0005-4000-8000-000000000005", title: null, execution_status: "idle" },
];

/** Invented, publishable project-folder fixture for the Hub grid. A local run
 *  has REAL folder names on disk — legible in full-page shots even through the
 *  palette backdrop — so the grid must never render live data. */
export const LOCAL_FOLDERS = [
  { name: "demo-project", path: "/projects/demo-project" },
  { name: "customizable-dca-openhands", path: "/projects/customizable-dca-openhands" },
  { name: "sample-api", path: "/projects/sample-api" },
];

export const SHOTS: Shot[] = [
  {
    name: "palette-blank-light",
    description: "Blank query is *no filter*, not *no results* — nav, theme action, docs, conversations in natural order",
    theme: "light",
  },
  {
    name: "palette-blank-dark",
    description: "Dark theme — colours come only from `var(--color-*)`, and the action row flips to *Switch to light mode*",
    theme: "dark",
  },
  {
    name: "palette-ranked-query",
    description: '`con` — the full ranking ladder: title-prefix hits (nav before doc on the kind tie-break) above word-prefix hits',
    theme: "light",
    query: "con",
  },
  {
    name: "palette-conversation-match",
    description: "`plan` — conversations from the on-open fetch, with a doc lifted above them by the same kind tie-break",
    theme: "light",
    query: "plan",
  },
  {
    name: "palette-no-match",
    description: "Empty state when nothing matches",
    theme: "light",
    query: "zzzznope",
    after: (page) => page.getByTestId("openhands-palette-empty").waitFor({ state: "visible" }),
  },
  {
    name: "palette-enter-navigates",
    description: "Enter on the top hit navigates and closes the palette — here `risk map` → the Risk map doc",
    theme: "light",
    query: "risk map",
    after: async (page) => {
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/openhands\/contributing\/risk-map$/);
      await page.getByTestId("doc-body").waitFor({ state: "visible" });
    },
  },
];

/** Where shots and the manifest land. Deliberately OUTSIDE Playwright's default
 *  `outputDir` (`test-results/`), which Playwright deletes at the start of every
 *  run — the previous location meant running the smoke suite after the harness
 *  silently destroyed the shots, and would have deleted the manifest before
 *  Playwright could even read it. */
export const OUT_DIR = "screenshots-out";
export const MANIFEST_PATH = `${OUT_DIR}/manifest.json`;
