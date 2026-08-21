// PR screenshot harness — one test per entry in `SHOTS` (tests/e2e/shots.ts),
// each producing a deterministic PNG in screenshots-out/, uploaded by CI as the
// `pr-screenshots` artifact and indexed in a sticky PR comment.
//
// Not part of the smoke suite despite sharing a testDir: playwright.config.ts
// absorbs every *.spec.ts under tests/e2e, so the split lives in the npm
// scripts — `test:e2e` is --grep-invert @shots, `screenshots` is --grep @shots.
// The tag sits on the describe below, so every generated test inherits it.
//
// Screenshots are evidence, not assertions: there is no golden-image
// comparison, a shot fails only when the page cannot reach its state, and the
// CI steps are continue-on-error (decision #9, evidence over gating). Missing
// shots are surfaced in the comment body by diffing the manifest against what
// landed on disk, NOT by failing the build — that way a partial capture still
// uploads the shots that did work.
//
// Determinism (the committed ad-hoc set had drifted 1280x1610 … 2560x116):
//   · fixed 1280x800, deviceScaleFactor 1 — the standard capture width;
//   · theme forced via localStorage BEFORE boot, because next-themes defaults
//     to "system" and an unseeded light/dark pair collapses into two identical
//     images on whatever the runner's OS preference happens to be;
//   · the conversation list is a fixture served by page.route(), never live.
import { test, type Page } from "@playwright/test";
import { CONVERSATIONS, LOCAL_FOLDERS, OUT_DIR, SHOTS, type Shot } from "./shots.js";

async function preparePage(page: Page, shot: Shot): Promise<void> {
  // Routed before any navigation so the palette's on-open fetch can never race
  // the real BFF response.
  await page.route("**/api/openhands/conversations", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { items: CONVERSATIONS } });
  });
  // Every other list-shaped endpoint the Hub renders must be a fixture too —
  // a LOCAL run has real project folders, repo names, and run titles, which
  // stay legible in full-page shots (even through the palette's backdrop).
  // CI's stack is seeded/empty, but the harness must be safe anywhere.
  await page.route("**/api/openhands/local-folders", (route) =>
    route.fulfill({ json: { items: LOCAL_FOLDERS } }),
  );
  await page.route("**/api/openhands/repos", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/openhands/suggested-issues*", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/openhands/manager/runs", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { items: [] } });
  });
  await page.addInitScript((t) => localStorage.setItem("theme", t), shot.theme);
}

async function openPalette(page: Page): Promise<void> {
  await page.goto("/openhands/native");
  await page.getByTestId("openhands-prompt").waitFor({ state: "visible" });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("openhands-command-palette").waitFor({ state: "visible" });
  // The footer reads "Loading conversations…" until the stubbed fetch lands;
  // waiting on it keeps the conversation rows present in every shot.
  await page.waitForFunction(() => !document.body.innerText.includes("Loading conversations…"));
}

test.describe("command palette @shots", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  for (const shot of SHOTS) {
    test(shot.name, async ({ page }) => {
      await preparePage(page, shot);
      await openPalette(page);
      if (shot.query) await page.getByTestId("openhands-palette-input").fill(shot.query);
      await shot.after?.(page);
      // Settle for the theme class and any row hover/active transition.
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT_DIR}/${shot.name}.png` });
    });
  }
});
