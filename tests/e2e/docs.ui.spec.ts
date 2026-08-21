// Browser-tier coverage for the Contributing doc viewer — no LLM calls.
// Guards the failure this suite was written for: a doc page that renders its
// banner but never its markdown, because the raw source was fetched through a
// per-document lazy import that the built bundle could not resolve. The whole
// corpus is bundled eagerly (client/lib/docs.ts), so EVERY registered doc must
// paint a body in the built app — the root CONTRIBUTING.md (a repo-root file
// reached from client/ via "../..") and the nested docs/*.md alike.
import { expect, test, type Page } from "@playwright/test";

const FAILED_TO_LOAD = /Failed to load this doc/i;

/** Registry as the built app sees it: the index cards carry both the slug
 * (test id) and the repo-relative path (mono footer), so this stays in sync
 * with client/lib/docs.ts without importing a Vite-only module into Node. */
async function readDocIndex(page: Page): Promise<{ slug: string; path: string }[]> {
  await page.goto("/openhands/contributing");
  const cards = page.locator('a[data-testid^="doc-card-"]');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  const docs: { slug: string; path: string }[] = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const slug = (await card.getAttribute("data-testid"))!.replace("doc-card-", "");
    const path = (await card.locator(".font-mono").innerText()).trim();
    docs.push({ slug, path });
  }
  return docs;
}

/** A doc page is "loaded" only when the markdown body is on screen with real
 * headings — banner-only is exactly the regression under test. */
async function expectDocRendered(page: Page, path: string) {
  const body = page.getByTestId("doc-body");
  await expect(body, `${path} rendered no markdown body`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(FAILED_TO_LOAD), `${path} showed the load-failure fallback`).toHaveCount(0);
  await expect(body.locator("h1, h2").first(), `${path} body has no headings`).toBeVisible();
  expect((await body.innerText()).trim().length, `${path} body is empty`).toBeGreaterThan(200);
}

test("root CONTRIBUTING.md renders in-app from the bundled source", async ({ page }) => {
  await page.goto("/openhands/contributing/contributing");
  await expect(page.getByTestId("doc-banner")).toContainText("CONTRIBUTING.md");
  await expectDocRendered(page, "CONTRIBUTING.md");
  // H1 comes from the markdown itself, not the index page's own heading.
  await expect(page.getByTestId("doc-body").getByRole("heading", { name: "Contributing", level: 1 })).toBeVisible();
  await expect(page.getByTestId("doc-github-link")).toHaveAttribute(
    "href",
    /github\.com\/.+\/blob\/main\/CONTRIBUTING\.md$/,
  );
});

test("nested docs/*.md render from the bundled source", async ({ page }) => {
  for (const slug of ["testing", "debugging", "decisions"]) {
    await page.goto(`/openhands/contributing/${slug}`);
    await expect(page.getByTestId("doc-banner")).toContainText(`docs/${slug}.md`);
    await expectDocRendered(page, `docs/${slug}.md`);
    await expect(page.getByTestId("doc-github-link")).toHaveAttribute(
      "href",
      new RegExp(`github\\.com/.+/blob/main/docs/${slug}\\.md$`),
    );
  }
});

test("every doc in the registry paints its markdown body", async ({ page }) => {
  test.slow(); // walks the whole corpus (root + docs/), one navigation each
  const docs = await readDocIndex(page);
  expect(docs.length).toBeGreaterThan(1);
  expect(docs.map((d) => d.path)).toContain("CONTRIBUTING.md");
  expect(docs.some((d) => d.path.startsWith("docs/"))).toBe(true);
  for (const doc of docs) {
    await page.goto(`/openhands/contributing/${doc.slug}`);
    await expect(page.getByTestId("doc-banner"), `${doc.slug} banner`).toContainText(doc.path);
    await expectDocRendered(page, doc.path);
  }
});

test("client-side navigation between docs swaps the rendered source", async ({ page }) => {
  await page.goto("/openhands/contributing");
  await page.getByTestId("doc-card-contributing").click();
  await expect(page).toHaveURL(/\/openhands\/contributing\/contributing$/);
  await expectDocRendered(page, "CONTRIBUTING.md");
  // Route change (no reload) must re-resolve the source, not keep the old body.
  await page.getByTestId("doc-body").getByRole("link", { name: "testing.md" }).first().click();
  await expect(page).toHaveURL(/\/openhands\/contributing\/testing$/);
  await expect(page.getByTestId("doc-banner")).toContainText("docs/testing.md");
  await expectDocRendered(page, "docs/testing.md");
});
