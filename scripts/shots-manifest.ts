// Writes screenshots-out/manifest.json — the DECLARED set of PR screenshots.
//
// Runs as a pre-step of `npm run screenshots`, before Playwright starts, on
// purpose: CI diffs this declaration against the PNGs that actually landed, so
// it must survive a run that dies before any test executes. A manifest emitted
// from inside the run (a beforeAll, say) could only ever describe a run that
// got far enough to emit it — precisely the failure it is meant to report.
//
// The manifest deliberately does NOT ship in the artifact: the upload step
// globs `screenshots-out/*.png`, so this file sits alongside the shots without
// being handed to reviewers, who get the descriptions rendered in the comment.
import { mkdirSync, writeFileSync } from "node:fs";
import { MANIFEST_PATH, OUT_DIR, SHOTS } from "../tests/e2e/shots.js";

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  MANIFEST_PATH,
  `${JSON.stringify(
    SHOTS.map(({ name, description, theme }) => ({ name, description, theme })),
    null,
    2,
  )}\n`,
);
console.log(`wrote ${MANIFEST_PATH} (${SHOTS.length} declared shots)`);
