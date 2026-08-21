// Layout containment — browser tier, no LLM calls.
//
// The bug these guard: the shell used to grow the document and the
// conversation page reserved space for the nav with a magic `100vh - 2.25rem`
// subtraction. Any disagreement between that constant and the real nav height
// (or mobile browser chrome eating viewport) pushed the composer and the
// status bar below the fold, with no document scrollbar to reach them. The
// fix is structural — a 100dvh flex column whose only scroller is the
// transcript — so the assertions here are geometric, not class-name checks
// (tests/plan-mode.test.ts already covers the classes at source level).
//
// Both viewports matter: 1280×800 is the desktop default and ~390×740 is a
// phone, where dvh and vh actually diverge.
import { expect, test, type Page } from "@playwright/test";

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 740 };
type Viewport = typeof DESKTOP;

/** Distance from the viewport top to an element's bottom edge, in CSS px. */
async function bottomEdge(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no layout box`);
  return box.y + box.height;
}

/** Elements that actually overflow their own box, by data-testid or tag. */
function scrollers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        if (el.scrollHeight <= el.clientHeight + 1) return false;
        const overflowY = getComputedStyle(el).overflowY;
        return overflowY === "auto" || overflowY === "scroll";
      })
      .map((el) => el.dataset.testid ?? el.tagName.toLowerCase()),
  );
}

async function documentScrolls(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  );
}

test.describe("shell containment", () => {
  // Applies to every route, so it is checked on one that needs no agent run.
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`the document never scrolls; the routed main does (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/openhands/contributing");
      await expect(page.getByTestId("app-main")).toBeVisible();
      // Contributing is a long page — if the shell leaked, this is where it
      // would show up as a document scrollbar.
      await expect(page.getByTestId("contributing-map")).toBeVisible();

      expect(await documentScrolls(page)).toBe(false);

      // The overflow moved into main, so the nav band above it stays pinned.
      const main = await page.getByTestId("app-main").evaluate((el) => ({
        clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      expect(main.overflowY).toBe("auto");
      expect(main.clientHeight).toBeLessThanOrEqual(viewport.height);
    });
  }

  // Changes is the other page that sizes itself to the viewport rather than to
  // its content. Not a regression guard — it passed before this branch too,
  // because a flex item gets shrunk back to the column's height regardless of
  // what its `h-*` claims. It is here as the standing invariant for the class
  // of bug this branch fixes: a viewport-sized page must fit the shell.
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`the standalone changes page fits the shell (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/openhands/changes");
      await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
      expect(await documentScrolls(page)).toBe(false);
      const main = await page.getByTestId("app-main").evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(main.scrollHeight).toBeLessThanOrEqual(main.clientHeight + 1);
    });
  }
});

test.describe("conversation page", () => {
  // The smoke suite must never start an agent run (tests/e2e/README.md), and
  // the BFF has no way to create a conversation without one, so this reuses a
  // conversation the environment already has. Fresh CI has none and skips;
  // any developer machine that has run the app once gets the coverage.
  let conversationId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/api/openhands/conversations");
    if (!res.ok()) return;
    const { items } = (await res.json()) as { items?: Array<{ id?: string }> };
    conversationId = items?.[0]?.id ?? null;
  });

  /**
   * Navigate and wait for transcript content. Measuring an empty transcript
   * proves nothing: the composer only gets pushed off-screen once there is
   * content to push it. Events arrive by fetch and then stream in over SSE,
   * so waiting on the transcript's first child is not enough — that resolves
   * on the wrapper, before any event has rendered.
   */
  async function open(page: Page, viewport: Viewport): Promise<void> {
    await page.setViewportSize(viewport);
    await page.goto(`/openhands/native/conversations/${conversationId}`);
    await expect(page.getByTestId("openhands-followup")).toBeVisible();
    await expect(page.locator("[data-event-id]").first()).toBeVisible({ timeout: 15_000 });
  }

  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`composer and status bar stay on screen (${name})`, async ({ page }) => {
      test.skip(!conversationId, "no existing conversation to render (fresh environment)");
      await open(page, viewport);

      // The regression, stated directly: both bottom edges are reachable
      // without scrolling anything.
      expect(await bottomEdge(page, "openhands-followup")).toBeLessThanOrEqual(viewport.height);
      expect(await bottomEdge(page, "openhands-status-bar")).toBeLessThanOrEqual(viewport.height);

      // The status bar is the last row of the column, flush with the bottom.
      expect(viewport.height - (await bottomEdge(page, "openhands-status-bar"))).toBeLessThanOrEqual(1);

      expect(await documentScrolls(page)).toBe(false);
    });
  }

  test("the transcript is the only scroller", async ({ page }) => {
    test.skip(!conversationId, "no existing conversation to render (fresh environment)");
    // The phone viewport leaves the transcript a few hundred px, so any real
    // conversation overflows it — which is the point: the overflow has to land
    // in the transcript and nowhere else. Polled because events keep streaming
    // in after first paint, and a transcript that has not filled yet reports
    // no overflow at all.
    await open(page, PHONE);
    await expect
      .poll(() => scrollers(page), {
        timeout: 15_000,
        message: "the transcript should be the page's only scrolling region",
      })
      .toEqual(["openhands-transcript"]);
  });

  test("the status bar shows the whole working dir", async ({ page }) => {
    test.skip(!conversationId, "no existing conversation to render (fresh environment)");
    await open(page, DESKTOP);
    const res = await page.request.get(`/api/openhands/conversations/${conversationId}`);
    const workingDir = ((await res.json()) as { workspace?: { working_dir?: string } }).workspace?.working_dir;
    test.skip(!workingDir, "conversation has no workspace working_dir");

    const folder = page.getByTestId("status-bar-folder");
    await expect(folder).toBeVisible();
    // Rendered in full, not elided to a basename or an ellipsis: sibling
    // worktrees share a basename, so only the full path identifies the
    // checkout the agent is editing.
    await expect(folder).toContainText(workingDir!);
    await expect(folder).not.toHaveClass(/\btruncate\b/);
    // On a desktop track the whole path fits without scrolling at all.
    expect(await folder.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // One line: the bar is a status line, not a paragraph.
    expect(await folder.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(24);
  });

  // Plan mode's only chrome is the composer: an amber top border and an amber
  // Plan segment. tests/plan-mode.test.ts checks the classes are present; only
  // a browser can check they actually paint. They did not, before this branch:
  // Tailwind emits the `border-<color>` shorthand after `border-t-<color>`, so
  // the base border colour silently beat the accent and the manager's cyan
  // strip never appeared. A class-level test cannot see that.
  test("plan mode paints an amber top border on the composer", async ({ page }) => {
    test.skip(!conversationId, "no existing conversation to render (fresh environment)");
    const setMode = (mode: "build" | "plan") =>
      page.request.post(`/api/openhands/conversations/${conversationId}/mode`, { data: { mode } });
    const restore = await page.request
      .get(`/api/openhands/conversations/${conversationId}`)
      .then(async (r) => ((await r.json()) as { confirmation_policy?: { kind?: string } }).confirmation_policy?.kind)
      .then((kind) => (kind && kind !== "NeverConfirm" ? "plan" : "build") as "build" | "plan");
    try {
      expect((await setMode("plan")).ok()).toBe(true);
      await open(page, DESKTOP);
      const composer = page.locator('[data-plan-mode="true"]');
      await expect(composer).toHaveCount(1);
      const border = await composer.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.borderTopWidth, top: s.borderTopColor, side: s.borderLeftColor };
      });
      expect(border.width).toBe("2px");
      // The precise statement of the cascade bug: when the accent loses, the
      // top border is simply the same grey as every other side.
      expect(border.top).not.toBe(border.side);
    } finally {
      await setMode(restore);
    }
  });

  test("a path too wide for the bar is scrolled to its tail, not its head", async ({ page }) => {
    test.skip(!conversationId, "no existing conversation to render (fresh environment)");
    await open(page, PHONE);
    const folder = page.getByTestId("status-bar-folder");
    const cell = await folder.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      height: el.getBoundingClientRect().height,
    }));
    test.skip(cell.scrollWidth <= cell.clientWidth + 1, "path already fits at this width");
    // Still one line — wrapping a 70-char path into a 90px cell is what makes
    // the "slim" status bar 124px tall.
    expect(cell.height).toBeLessThan(24);
    // Anchored at the end: the shared /home/openhands/workspace prefix
    // identifies nothing, the trailing worktree/session folder identifies
    // everything, so that is what a too-narrow cell must show.
    expect(cell.scrollLeft).toBeGreaterThanOrEqual(cell.scrollWidth - cell.clientWidth - 1);
  });
});
