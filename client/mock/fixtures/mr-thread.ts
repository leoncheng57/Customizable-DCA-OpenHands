// client/mock/fixtures/mr-thread.ts
//
// One fictional merge request, complete enough that every section of
// client/components/MrPanel.tsx has something to draw: title and refs, a
// pipeline badge, a markdown description, a discussion with a resolved note,
// and a per-stage/per-job pipeline breakdown.
//
// The URL is not hardcoded. MrPanel renders whatever `extractMrUrls` found in
// the transcript, and the transcript belongs to a different handler group, so
// the project path and iid are parsed out of whatever URL arrives and the same
// MR is served for it. A demo MR that only answered for one exact string would
// leave the panel stuck on "Loading…" the moment the transcript said anything
// else.
//
// The pipeline is MID-RUN and advances on the demo clock: MrPanel polls every
// 10s, so a visitor who leaves the card open watches the test stage finish and
// the deploy stage start. Nothing here is real — no pipeline is running, no
// repository exists, and `POST /mr/merge` refuses rather than pretending to
// merge (see the route in ../settings.ts).
import type { MrComment, MrInfo, MrPipelineProgress, MrPipelineStage } from "../../lib/api.js";
import { isoAt, MINUTE, phaseAt, SECOND } from "../clock.js";
import { DEMO_GIT_HOST } from "./settings-projects.js";

const DEFAULT_PROJECT_PATH = "meridian/platform/checkout-service";
const DEFAULT_IID = 128;
const PIPELINE_ID = 90_412;

/** Which host/kind an MR URL points at, and the refs inside it. */
export interface MrTarget {
  kind: "gitlab" | "github";
  projectPath: string;
  iid: number;
  /** The canonical URL for the parsed target (never the caller's raw string). */
  webUrl: string;
}

/**
 * Parse a GitLab MR or GitHub PR URL the same way the client's detector
 * produced it. Unparseable input falls back to the demo's own MR so the panel
 * still renders something rather than erroring on a malformed link.
 */
export function parseMrTarget(url: string): MrTarget {
  const gitlab = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url);
  if (gitlab) {
    return {
      kind: "gitlab",
      projectPath: gitlab[2],
      iid: Number(gitlab[3]),
      webUrl: `https://${gitlab[1]}/${gitlab[2]}/-/merge_requests/${gitlab[3]}`,
    };
  }
  const github = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (github) {
    return {
      kind: "github",
      projectPath: github[1],
      iid: Number(github[2]),
      webUrl: `https://github.com/${github[1]}/pull/${github[2]}`,
    };
  }
  return {
    kind: "gitlab",
    projectPath: DEFAULT_PROJECT_PATH,
    iid: DEFAULT_IID,
    webUrl: `${DEMO_GIT_HOST}/${DEFAULT_PROJECT_PATH}/-/merge_requests/${DEFAULT_IID}`,
  };
}

const DESCRIPTION = `Retries on the payment provider's \`503\` were replaying the *whole* charge
because the idempotency key was generated per attempt instead of per order.

**What changed**

- \`CheckoutSession\` now mints one key at order creation and stores it alongside the order.
- The retry helper reuses the stored key; a replay is a no-op upstream instead of a second charge.
- Added a regression test that drives three retries through a stubbed 503 and asserts one charge.

Closes #412.`;

/**
 * The pipeline moves through three phases while the demo is open.
 * Offsets are from page load, not wall-clock dates.
 */
const PHASES = [45 * SECOND, 2 * MINUTE] as const;

function pipelinePhase(): number {
  return phaseAt(PHASES);
}

/** Overall pipeline status for the badge, derived from the same phase. */
export function pipelineStatus(): string {
  return pipelinePhase() >= 2 ? "success" : "running";
}

function pipelineWebUrl(target: MrTarget): string {
  return target.kind === "github"
    ? `https://github.com/${target.projectPath}/pull/${target.iid}/checks`
    : `${DEMO_GIT_HOST}/${target.projectPath}/-/pipelines/${PIPELINE_ID}`;
}

function jobUrl(target: MrTarget, jobId: number): string {
  return target.kind === "github"
    ? `https://github.com/${target.projectPath}/pull/${target.iid}/checks`
    : `${DEMO_GIT_HOST}/${target.projectPath}/-/jobs/${jobId}`;
}

/** `GET /mr` — the card header, badge and description. */
export function mrInfo(target: MrTarget, state: "opened" | "merged" = "opened"): MrInfo {
  return {
    iid: target.iid,
    projectPath: target.projectPath,
    title: "Reuse one idempotency key across checkout retries",
    state,
    // Mergeable on purpose: a disabled Merge button would hide the confirm
    // step, and the confirm step is where the demo explains itself.
    mergeStatus: state === "merged" ? "" : "can_be_merged",
    webUrl: target.webUrl,
    description: DESCRIPTION,
    pipeline: state === "merged" ? null : { status: pipelineStatus(), webUrl: pipelineWebUrl(target) },
  };
}

/**
 * `GET /mr/comments` — flat and chronological, as the real route returns them.
 * The last note only appears once the visitor has been on the page a minute,
 * so the section's 10s refresh has something to reveal.
 */
export function mrComments(): MrComment[] {
  const items: MrComment[] = [
    {
      id: 5_101,
      author: "avery.stone",
      body: "Nice catch. Does the stored key survive an order that gets split across two shipments?",
      createdAt: isoAt(-42 * MINUTE),
      resolved: true,
    },
    {
      id: 5_104,
      author: "meridian-agent-bot",
      body: "It does — the key lives on the order, and the shipment records reference it rather than minting their own. Added `test_split_shipment_reuses_key` to pin that.",
      createdAt: isoAt(-38 * MINUTE),
      resolved: true,
    },
    {
      id: 5_112,
      author: "jordan.pike",
      body: "Approving once the pipeline is green. One nit: the retry helper's log line still prints the attempt number as if each attempt had its own key — worth updating so the next person reading logs isn't misled.",
      createdAt: isoAt(-11 * MINUTE),
      resolved: false,
    },
  ];
  if (phaseAt([60 * SECOND]) >= 1) {
    items.push({
      id: 5_119,
      author: "meridian-agent-bot",
      body: "Log line updated — it now prints the shared key and the attempt count separately.",
      createdAt: isoAt(60 * SECOND),
      resolved: false,
    });
  }
  return items;
}

/** Per-stage breakdown; the middle stage is the one that moves. */
export function mrPipeline(target: MrTarget): MrPipelineProgress {
  const phase = pipelinePhase();
  const testStatus = phase >= 1 ? "success" : "running";
  const deployStatus = phase >= 2 ? "success" : phase >= 1 ? "running" : "created";

  const stages: MrPipelineStage[] = [
    {
      name: "build",
      status: "success",
      jobs: [
        { name: "compile", status: "success", webUrl: jobUrl(target, 812_401), duration: 74 },
        { name: "container-image", status: "success", webUrl: jobUrl(target, 812_402), duration: 138 },
      ],
    },
    {
      name: "test",
      status: testStatus,
      jobs: [
        { name: "lint", status: "success", webUrl: jobUrl(target, 812_403), duration: 22 },
        { name: "unit", status: "success", webUrl: jobUrl(target, 812_404), duration: 96 },
        {
          name: "integration",
          status: testStatus,
          webUrl: jobUrl(target, 812_405),
          duration: phase >= 1 ? 214 : null,
        },
      ],
    },
    {
      name: "deploy",
      status: deployStatus,
      jobs: [
        {
          name: "review-app",
          status: deployStatus,
          webUrl: jobUrl(target, 812_406),
          duration: phase >= 2 ? 61 : null,
        },
      ],
    },
  ];

  return {
    pipeline: { id: PIPELINE_ID, status: pipelineStatus(), webUrl: pipelineWebUrl(target) },
    stages,
  };
}
