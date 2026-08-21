#!/usr/bin/env node
// Validate that PR commits follow Conventional Commits format.
//
// Why: release-please parses commit messages to decide version bumps
// (feat -> minor, fix -> patch) and to generate release notes; commits that
// don't match are silently dropped from the notes.
//
// Each commit in BASE_SHA..HEAD_SHA must have a subject line matching
//   <type>[(<scope>)][!]: <subject>
// where <type> is one of: feat, fix, chore, docs, refactor, test, ci, build,
// perf, style, revert. Merge commits (subject starting with "Merge ") are
// skipped.
//
// Usage:
//   BASE_SHA=<sha> HEAD_SHA=<sha> node scripts/ci/commit-lint.mjs
//   node scripts/ci/commit-lint.mjs --self-test

import { execSync } from "node:child_process";

const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|ci|build|perf|style|revert)(\([^)]+\))?!?:\s.+/;

/** @param {string} subject */
function isValidSubject(subject) {
  return subject.startsWith("Merge ") || CONVENTIONAL.test(subject);
}

function selfTest() {
  const good = [
    "feat: add thing",
    "fix(server): handle null",
    "chore!: drop node 18",
    "revert(ci): undo cache key",
    "Merge branch 'main' into x",
  ];
  const bad = ["add thing", "Feature: caps type", "feat:missing space", "wip"];
  const failures = [
    ...good.filter((s) => !isValidSubject(s)).map((s) => `expected valid: ${s}`),
    ...bad.filter((s) => isValidSubject(s)).map((s) => `expected invalid: ${s}`),
  ];
  if (failures.length > 0) {
    console.error("self-test failed:\n" + failures.map((f) => `  ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`self-test passed (${good.length} valid, ${bad.length} invalid subjects)`);
  process.exit(0);
}

function main() {
  if (process.argv.includes("--self-test")) selfTest();

  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!base || !head) {
    console.error("Missing BASE_SHA or HEAD_SHA");
    process.exit(1);
  }

  // PR pipelines may run on a shallow clone — deepen so git log can walk the
  // full base..head range.
  try {
    execSync(`git fetch --depth=100 origin ${base}`, { stdio: "inherit" });
  } catch {
    /* already present or full clone */
  }

  const log = execSync(`git log --pretty=format:%H%x1f%s ${base}..${head}`, { encoding: "utf-8" });
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split("\x1f");
      return { hash, subject };
    });

  const violations = commits.filter((c) => !isValidSubject(c.subject));
  const checked = commits.filter((c) => !c.subject.startsWith("Merge ")).length;

  if (violations.length === 0) {
    console.log(`All ${checked} commit(s) follow Conventional Commits format.`);
    process.exit(0);
  }

  console.error(`Found ${violations.length} commit(s) that do not follow Conventional Commits format:`);
  for (const v of violations) console.error(`  ${v.hash.slice(0, 8)}  ${v.subject}`);
  console.error("");
  console.error("Expected format: <type>[(<scope>)][!]: <subject>");
  console.error("Valid types: feat, fix, chore, docs, refactor, test, ci, build, perf, style, revert");
  process.exit(1);
}

main();
