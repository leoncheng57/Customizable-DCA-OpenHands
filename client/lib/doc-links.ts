// How the Contributing docs are *addressed*: the route prefix and the
// heading-anchor algorithm. Pure functions, no imports.
//
// Deliberately separate from lib/docs.ts, which bundles the whole markdown
// corpus via `import.meta.glob({ eager: true })`. lib/palette.ts is pulled in
// eagerly by main.tsx while the doc pages are React.lazy, so importing a
// *value* out of docs.ts there would move every raw .md string into the main
// chunk. Importing from here costs nothing. lib/docs.ts re-exports both names
// so doc-page call sites keep a single import.

/** Route prefix for the Contributing section. Single source of truth for
 * every link into the docs reader — it used to be spelled out at ~7 call
 * sites, one typo away from a dead link. The <Route> declarations in
 * main.tsx must keep matching this value. */
export const DOCS_BASE = "/openhands/contributing";

/** Route for a doc page, with an optional in-page fragment ("#a-heading").
 * `slug` omitted → the Contributing index. */
export function docRoute(slug?: string, hash = ""): string {
  return `${DOCS_BASE}${slug ? `/${slug}` : ""}${hash}`;
}

/** GitHub's heading-anchor algorithm (github-slugger), reimplemented so
 * in-app anchors are identical to the ones GitHub generates for the same
 * markdown — the corpus is read in both places, and a fragment copied from
 * one has to work in the other.
 *
 * Lowercase, drop everything that is not a letter/number/combining-mark/`-`/
 * `_`, then spaces to hyphens. Runs of removed punctuation leave their
 * surrounding spaces behind and therefore collapse into repeated hyphens
 * ("Packaging & install — x" → "packaging--install--x"). That is GitHub's
 * behaviour; do not "tidy" it or the anchors stop matching.
 *
 * Deliberately stateless — no `-1`/`-2` de-duplication suffixes. No document
 * in the corpus repeats a heading, and tests/docs-anchors.test.ts fails the
 * build if one ever does. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}
