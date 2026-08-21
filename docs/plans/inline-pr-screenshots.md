# Inline PR screenshots

Implementation brief for a follow-up coding agent.

## Goal

Adapt the screenshot workflow from [`leoncheng57/leoncheng57.github.io`](https://github.com/leoncheng57/leoncheng57.github.io) so generated screenshots appear inline in pull-request comments. Keep this project's declared `SHOT_GROUPS` instead of accepting arbitrary routes, and keep screenshot failures advisory.

## PR description contract

```text
<!-- ci:screenshots:start -->
Shots: palette
<!-- ci:screenshots:end -->
```

- Parse `Shots:` only from the marker region when markers are present.
- Fall back to scanning the whole description when neither marker exists.
- Treat unmatched markers, unknown groups, and malformed selections as advisory warnings.
- Preserve `none`, `all`, and comma/space-separated group IDs.

## Workflow requirements

1. Trigger on PR `opened`, `reopened`, `synchronize`, `edited`, and `closed` events.
2. On `edited`, run capture only when the PR body changed.
3. Gate publishing to same-repository PRs; do not use `pull_request_target`.
4. Keep fixture data and the existing `@shots` harness.
5. Do not pull the multi-GB `agent-canvas` image solely for screenshots. Verify the harness against either the `VITE_DEMO=1` Pages build or a standalone built BFF without agent-canvas, then use a separate lightweight screenshot workflow if viable.
6. Publish images to a persistent branch such as `pr-screenshots` under `previews/pr-<number>/screenshots/`.
7. Embed cache-busted public URLs in the sticky comment, for example:

   `https://raw.githubusercontent.com/leoncheng57/Customizable-DCA-OpenHands/pr-screenshots/previews/pr-<number>/screenshots/<file>?sha=<head-sha>`

8. Continue uploading the `pr-screenshots` artifact as a fallback.
9. Maintain one marker-based sticky comment containing requested groups, head SHA, inline images, manifest descriptions, missing captures, parser warnings, and artifact/run links.
10. Remove the PR's published directory when the PR closes.
11. Serialize writes to the screenshot branch.
12. Use minimum workflow permissions. Pin any third-party action receiving write access to a full commit SHA, or use native git/GitHub tooling.

## Documentation and tests

Update:

- `.github/pull_request_template.md`
- `docs/pr-screenshots.md`
- `docs/cicd.md`

Remove obsolete claims that this repository is private or cannot render screenshots inline. Add unit tests covering marker parsing and group selection.

Relevant implementation files:

- `.github/workflows/ci.yml`
- `.github/workflows/pages.yml`
- `tests/e2e/shots.ts`
- `tests/e2e/screenshots.spec.ts`
- `scripts/shots-manifest.ts`
- `playwright.config.ts`
- `package.json`

Reference implementation:

- [`pr-screenshots.yml`](https://github.com/leoncheng57/leoncheng57.github.io/blob/main/.github/workflows/pr-screenshots.yml)
- [`ci-screenshots.mjs`](https://github.com/leoncheng57/leoncheng57.github.io/blob/main/scripts/ci-screenshots.mjs)

## Validation

Run:

- `npm run typecheck`
- `npm test`
- `npm run build`
- local screenshot capture against the chosen lightweight server
- workflow/YAML validation where available

Before merging, review token permissions, fork safety, partial-capture behavior, and cleanup behavior.
