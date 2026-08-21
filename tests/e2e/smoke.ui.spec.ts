// Browser-tier smoke tests — no LLM calls. Verifies the vendored UI renders
// against the live stack: homepage (hub with the project-folder grid), both
// workspace modes, terminal and manager-runs pages.
import { expect, test } from "@playwright/test";

test("homepage redirects to the hub", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/openhands\/native$/);
  await expect(page.getByTestId("openhands-prompt")).toBeVisible();
});

test("hub shows the project-folder grid by default (local mode)", async ({ page }) => {
  await page.goto("/openhands/native");
  await expect(page.getByTestId("openhands-project-grid")).toBeVisible();
  await expect(page.getByTestId("openhands-project-demo-project")).toBeVisible();
  // Repo cloner is demoted: input only appears after switching modes.
  await expect(page.getByTestId("openhands-repo")).toHaveCount(0);
  await page.getByTestId("openhands-workspace-mode").selectOption("repo");
  await expect(page.getByTestId("openhands-repo")).toBeVisible();
});

test("new local sessions default to isolated worktrees and remember the toggle", async ({ page }) => {
  await page.goto("/openhands/native");
  const toggle = page.getByTestId("openhands-new-session-worktree");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.reload();
  await expect(page.getByTestId("openhands-new-session-worktree")).not.toBeChecked();
});

test("picking a project folder enables Start", async ({ page }) => {
  await page.goto("/openhands/native");
  await page.getByTestId("openhands-prompt").fill("smoke test prompt");
  // Start disabled until a folder is picked (localUnresolved guard).
  await expect(page.getByRole("button", { name: "Start agent" })).toBeDisabled();
  await page.getByTestId("openhands-project-demo-project").click();
  await expect(page.getByTestId("openhands-local-folder")).toContainText("demo-project");
  await expect(page.getByRole("button", { name: "Start agent" })).toBeEnabled();
  // Clicking again deselects.
  await page.getByTestId("openhands-project-demo-project").click();
  await expect(page.getByRole("button", { name: "Start agent" })).toBeDisabled();
});

test("project grid filter narrows the list", async ({ page }) => {
  await page.goto("/openhands/native");
  // Wait for the folder list to load before probing for the filter input.
  await expect(page.getByTestId("openhands-project-demo-project")).toBeVisible();
  const filter = page.getByTestId("openhands-project-filter");
  // Filter only renders for roots with >12 folders — skip otherwise.
  if ((await filter.count()) === 0) test.skip();
  await filter.fill("demo-proj");
  await expect(page.getByTestId("openhands-project-demo-project")).toBeVisible();
  const buttons = page.getByTestId("openhands-project-grid").locator("button");
  expect(await buttons.count()).toBeLessThan(5);
});

test("model select is populated", async ({ page }) => {
  await page.goto("/openhands/native");
  const options = page.getByTestId("openhands-model-select").locator("option");
  await expect(options.first()).toBeAttached(); // waits for /status to populate the list
  expect(await options.count()).toBeGreaterThan(0);
});

test("terminal page renders the shared command audit", async ({ page }) => {
  await page.goto("/openhands/terminal");
  await expect(page.getByText(/terminal|command/i).first()).toBeVisible();
});

test("manager runs page renders", async ({ page }) => {
  await page.goto("/openhands/runs");
  await expect(page.getByText(/run/i).first()).toBeVisible();
});

test("pinned project surfaces first in the grid", async ({ page }) => {
  await page.goto("/openhands/native");
  const grid = page.getByTestId("openhands-project-grid");
  await expect(page.getByTestId("openhands-project-demo-project")).toBeVisible();
  // Default pin seed puts this repo first.
  const firstCard = grid.locator("[data-pinned]").first();
  await expect(firstCard).toHaveAttribute("data-pinned", "true");
  await expect(firstCard).toContainText("customizable-dca-openhands");
  // Unpin → card loses pinned state; re-pin restores it (localStorage round-trip).
  await page.getByTestId("openhands-pin-customizable-dca-openhands").click();
  await expect(grid.locator("[data-pinned='true']")).toHaveCount(0);
  await page.getByTestId("openhands-pin-customizable-dca-openhands").click();
  await expect(grid.locator("[data-pinned='true']").first()).toContainText("customizable-dca-openhands");
});

test("notification channels: browser sound toggles independently of ntfy", async ({ page }) => {
  await page.goto("/openhands/notifications");
  const ntfy = page.getByTestId("channel-ntfy");
  const sound = page.getByTestId("channel-sound");
  await expect(sound).toBeVisible();
  // Sound is per-browser, default off.
  await expect(sound).not.toBeChecked();
  await sound.check();
  await expect(sound).toBeChecked();
  // ntfy checkbox state is untouched by the sound toggle (independent channels).
  const ntfyBefore = await ntfy.isChecked();
  // Persisted across reload via localStorage.
  await page.reload();
  await expect(page.getByTestId("channel-sound")).toBeChecked();
  expect(await page.getByTestId("channel-ntfy").isChecked()).toBe(ntfyBefore);
  // Reset for idempotent re-runs.
  await page.getByTestId("channel-sound").uncheck();
  await expect(page.getByTestId("channel-sound")).not.toBeChecked();
});

test("browser notification prefs: per-event filter and volume persist locally", async ({ page }) => {
  await page.goto("/openhands/notifications");
  const idleEvent = page.getByTestId("browser-event-idle");
  await expect(idleEvent).toBeChecked(); // all events default on
  await idleEvent.uncheck();
  // Volume slider is gated on the sound channel being enabled.
  await expect(page.getByTestId("sound-volume")).toBeDisabled();
  await page.getByTestId("channel-sound").check();
  const volume = page.getByTestId("sound-volume");
  await expect(volume).toBeEnabled();
  await volume.fill("0.2");
  // Both persist across reload via localStorage.
  await page.reload();
  await expect(page.getByTestId("browser-event-idle")).not.toBeChecked();
  await expect(page.getByTestId("sound-volume")).toHaveValue("0.2");
  // Desktop channel renders (permission-gated, so only assert presence).
  await expect(page.getByTestId("channel-desktop")).toBeVisible();
  // Reset for idempotent re-runs.
  await page.getByTestId("browser-event-idle").check();
  await page.getByTestId("channel-sound").uncheck();
});

test("contributing index renders the system map, cards, and about-redirect", async ({ page }) => {
  await page.goto("/openhands/about"); // pre-rename URL must redirect
  await expect(page).toHaveURL(/\/openhands\/contributing$/);
  await expect(page.getByRole("heading", { name: "Contributing" })).toBeVisible();
  await expect(page.getByTestId("contributing-map")).toBeVisible();
  await expect(page.getByTestId("doc-card-architecture")).toBeVisible();
  await expect(page.getByTestId("doc-card-risk-map")).toBeVisible();
});

test("doc page renders markdown with source banner, GitHub link, and mermaid", async ({ page }) => {
  await page.goto("/openhands/contributing/architecture");
  const banner = page.getByTestId("doc-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("docs/architecture.md");
  await expect(page.getByTestId("doc-github-link")).toHaveAttribute(
    "href",
    /github\.com\/.+\/blob\/main\/docs\/architecture\.md$/,
  );
  // Markdown body rendered (h1 from the doc), centered column.
  await expect(page.getByTestId("doc-body").getByRole("heading", { name: "Architecture" })).toBeVisible();
  // Mermaid fences render to SVG.
  await expect(page.getByTestId("doc-mermaid").first().locator("svg")).toBeVisible({ timeout: 15_000 });
  // Doc-to-doc markdown links navigate in-app.
  await page.getByTestId("doc-body").getByRole("link", { name: "decisions.md" }).first().click();
  await expect(page).toHaveURL(/\/openhands\/contributing\/decisions$/);
});

test("command palette opens on Cmd/Ctrl+K, filters, and navigates", async ({ page }) => {
  await page.goto("/openhands/native");
  await expect(page.getByTestId("openhands-prompt")).toBeVisible();

  const palette = page.getByTestId("openhands-command-palette");
  await expect(palette).toHaveCount(0);

  // ControlOrMeta maps to Cmd on macOS runners and Ctrl elsewhere.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  const input = page.getByTestId("openhands-palette-input");
  await expect(input).toBeFocused();
  // Blank query lists everything: nav + theme action + every doc.
  expect(await page.getByTestId("openhands-palette-option").count()).toBeGreaterThan(5);

  // Escape closes without navigating.
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/openhands\/native$/);

  // Typing narrows to the ranked shortlist; Enter opens the top hit.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("risk map");
  const options = page.getByTestId("openhands-palette-option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Risk map");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/openhands\/contributing\/risk-map$/);
  await expect(palette).toHaveCount(0);

  // No-match state, and the backdrop closes the palette.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("openhands-palette-input").fill("zzzznope");
  await expect(page.getByTestId("openhands-palette-empty")).toBeVisible();
  await page.getByTestId("openhands-palette-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(palette).toHaveCount(0);
});

test("tools page renders live health entries", async ({ page }) => {
  await page.goto("/openhands/tools");
  await expect(page.getByTestId("tools-server")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tool-terminal")).toBeVisible();
  await expect(page.getByTestId("integration-github")).toBeVisible();
  await expect(page.getByTestId("tools-recheck")).toBeEnabled();
});

// Skills are globally togglable (decision #17). Read-only assertions: the
// smoke suite shares one agent-server, so it must not flip the real profile.
test("tools page exposes global skill toggles and source switches", async ({ page }) => {
  await page.goto("/openhands/tools");
  await expect(page.getByTestId("tools-skills")).toBeVisible({ timeout: 15_000 });
  for (const source of ["user", "public", "project"]) {
    await expect(page.getByTestId(`skill-source-${source}`)).toBeEnabled();
  }
  // With every source off the empty state must say so rather than claiming
  // there is nothing installed — the two are different problems.
  const loadingOff = page.getByTestId("skills-loading-off");
  if (await loadingOff.count()) {
    await expect(loadingOff).toContainText("Skill loading is off");
  }
  // Any listed skill renders as a real checkbox, not a status dot.
  const toggles = page.locator('[data-testid^="skill-toggle-"]');
  for (let i = 0; i < (await toggles.count()); i += 1) {
    await expect(toggles.nth(i)).toHaveAttribute("type", "checkbox");
  }
});
