// client/mock/fixtures/settings-projects.ts
//
// Project sources for the demo hub: the bot-clonable repository list, the
// local project folders, and the issues the suggestion panel offers per repo.
//
// Everything here is invented. The namespaces below belong to no one; the
// host is `gitlab.example.test`, which is unresolvable by construction
// (RFC 6761 reserves `.test`), so no link in the demo can reach a real
// service even if a visitor clicks it.
//
// Shape notes that matter to the UI:
//  · RepoSelect drills the namespace ONE SEGMENT AT A TIME, so the list needs
//    several top-level groups and real nesting or the picker renders a single
//    dropdown and its whole reason for existing is invisible.
//  · PINNED_REPO_HINTS in client/components/RepoSelect.tsx resolves a pin by
//    exact path or `/`-suffix; two entries below end in those suffixes so the
//    "Pinned:" row is populated.
//  · The Hub only shows its project filter box above 12 folders.
import type { RepoOption, SuggestedIssue, SuggestedIssuesResponse } from "../../lib/api.js";
import { DAY, HOUR, isoAt, MINUTE } from "../clock.js";

/** Fictional GitLab host for every demo link. `.test` never resolves. */
export const DEMO_GIT_HOST = "https://gitlab.example.test";

const REPO_PATHS = [
  "meridian/platform/checkout-service",
  "meridian/platform/inventory-service",
  "meridian/platform/ledger-api",
  "meridian/web/storefront",
  "meridian/web/admin-console",
  "meridian/infra/terraform-modules",
  "meridian/infra/cluster-bootstrap",
  "northwind/demo-project",
  "northwind/data/etl-pipelines",
  "northwind/data/metrics-warehouse",
  "atlas/tools/customizable-dca-openhands",
  "atlas/tools/release-notary",
  "atlas/docs/handbook",
];

/** Bot-clonable repositories — `GET /repos`, also cached in localStorage. */
export const DEMO_REPOS: RepoOption[] = REPO_PATHS.map((path) => ({
  path,
  name: path.split("/").pop() ?? path,
  url: `${DEMO_GIT_HOST}/${path}`,
}));

/**
 * Immediate subdirectories of the projects root, relative to it — exactly
 * what `POST /conversations` accepts as `localPath`. Fourteen entries, so the
 * Hub's grid scrolls and its filter box appears.
 */
export const DEMO_LOCAL_FOLDERS: Array<{ name: string; path: string }> = [
  "admin-console",
  "checkout-service",
  "cluster-bootstrap",
  "demo-project",
  "etl-pipelines",
  "handbook",
  "inventory-service",
  "ledger-api",
  "metrics-warehouse",
  "release-notary",
  "scratchpad",
  "storefront",
  "terraform-modules",
  "usage-reports",
].map((name) => ({ name, path: name }));

/** One suggested issue before the `reason` string is derived. */
interface IssueSeed {
  iid: number;
  title: string;
  labels: string[];
  /** Negative offset from the demo's start — never an absolute date. */
  updatedOffsetMs: number;
  commentCount: number;
  upvotes: number;
}

/**
 * Verbatim port of `suggestionReason` in server/openhands/setup.ts: the panel
 * prints this string after "Suggested because:", so a demo that phrased it
 * differently would be inventing UI copy.
 */
const FRESH_DAYS = 30;

function suggestionReason(seed: IssueSeed): string {
  const parts = ["Open and unassigned"];
  if (-seed.updatedOffsetMs <= FRESH_DAYS * DAY) parts.push("recently active");
  if (seed.upvotes > 0) parts.push(`${seed.upvotes} upvote${seed.upvotes === 1 ? "" : "s"}`);
  if (seed.commentCount > 0) {
    parts.push(`${seed.commentCount} comment${seed.commentCount === 1 ? "" : "s"} of context`);
  }
  return parts.join(" · ");
}

const ISSUES_BY_REPO: Record<string, IssueSeed[]> = {
  "meridian/platform/checkout-service": [
    {
      iid: 412,
      title: "Retry storms when the payment provider returns 503",
      labels: ["bug", "reliability"],
      updatedOffsetMs: -3 * HOUR,
      commentCount: 6,
      upvotes: 3,
    },
    {
      iid: 407,
      title: "Idempotency keys are not propagated to the refund path",
      labels: ["bug", "payments"],
      updatedOffsetMs: -2 * DAY,
      commentCount: 2,
      upvotes: 1,
    },
    {
      iid: 391,
      title: "Cart totals drift by one cent on multi-currency baskets",
      labels: ["bug", "good first issue"],
      updatedOffsetMs: -9 * DAY,
      commentCount: 0,
      upvotes: 0,
    },
    {
      iid: 355,
      title: "Document the checkout state machine in the service README",
      labels: ["docs"],
      updatedOffsetMs: -41 * DAY,
      commentCount: 1,
      upvotes: 0,
    },
  ],
  "meridian/web/storefront": [
    {
      iid: 208,
      title: "Product grid reflows twice on first paint",
      labels: ["performance", "frontend"],
      updatedOffsetMs: -50 * MINUTE,
      commentCount: 4,
      upvotes: 5,
    },
    {
      iid: 199,
      title: "Search box loses focus after the results load",
      labels: ["bug", "accessibility"],
      updatedOffsetMs: -4 * DAY,
      commentCount: 1,
      upvotes: 2,
    },
  ],
  "northwind/data/etl-pipelines": [
    {
      iid: 77,
      title: "Nightly load silently skips late-arriving partitions",
      labels: ["bug", "data-quality"],
      updatedOffsetMs: -7 * HOUR,
      commentCount: 9,
      upvotes: 4,
    },
    {
      iid: 74,
      title: "Backfill job needs a dry-run flag",
      labels: ["enhancement"],
      updatedOffsetMs: -13 * DAY,
      commentCount: 0,
      upvotes: 1,
    },
  ],
  "atlas/tools/release-notary": [
    {
      iid: 31,
      title: "Sign release manifests with the shared build key",
      labels: ["security"],
      updatedOffsetMs: -6 * DAY,
      commentCount: 3,
      upvotes: 2,
    },
  ],
  // Deliberately empty: the panel's "No open, unassigned issues found in this
  // repository." branch is a state worth being able to see.
  "atlas/docs/handbook": [],
};

/** Anything without a bespoke list still gets something to show. */
const FALLBACK_ISSUES: IssueSeed[] = [
  {
    iid: 118,
    title: "Flaky integration test blocks the pipeline about once a day",
    labels: ["bug", "ci"],
    updatedOffsetMs: -5 * HOUR,
    commentCount: 3,
    upvotes: 2,
  },
  {
    iid: 104,
    title: "Replace the hand-rolled retry helper with the shared one",
    labels: ["refactor", "good first issue"],
    updatedOffsetMs: -6 * DAY,
    commentCount: 1,
    upvotes: 0,
  },
];

/** `GET /suggested-issues?repo=…` for any repo path the picker can produce. */
export function suggestedIssuesFor(repo: string): SuggestedIssuesResponse {
  const seeds = ISSUES_BY_REPO[repo] ?? FALLBACK_ISSUES;
  const items: SuggestedIssue[] = seeds.map((seed) => ({
    iid: seed.iid,
    title: seed.title,
    webUrl: `${DEMO_GIT_HOST}/${repo}/-/issues/${seed.iid}`,
    labels: seed.labels,
    updatedAt: isoAt(seed.updatedOffsetMs),
    commentCount: seed.commentCount,
    upvotes: seed.upvotes,
    reason: suggestionReason(seed),
  }));
  return { repo, repoUrl: `${DEMO_GIT_HOST}/${repo}`, items };
}
