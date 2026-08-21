// client/pages/ManagerGuide.tsx
//
// "Manager runs" guide — what the manager/worker parallel-runs feature is,
// how the pieces talk to each other, and what a human can (and cannot) do.
// Legacy TSX doc page (predates the markdown-canonical Contributing docs —
// see client/lib/docs.ts / decision #11): a titled column
// of sections, but with inline diagrams (styled divs + SVG) rather than
// bundled markdown, because the architecture is easier to read as boxes.
import type { ReactNode } from "react";
import { Badge } from "../ds/badge.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function DiagramBox({
  tone,
  title,
  children,
}: {
  tone: "cyan" | "gray" | "violet" | "amber";
  title: string;
  children?: ReactNode;
}) {
  const tones: Record<string, string> = {
    cyan: "border-cyan-500 bg-cyan-500/10",
    gray: "border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.06))]",
    violet: "border-violet-500 bg-violet-500/10",
    amber: "border-amber-500 bg-amber-500/10",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 text-center text-xs ${tones[tone]}`}>
      <div className="font-semibold">{title}</div>
      {children ? <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{children}</div> : null}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-1 text-[var(--color-text-muted)]">
      <span aria-hidden>⇄</span>
      {label ? <span className="max-w-24 text-center text-[10px]">{label}</span> : null}
    </div>
  );
}

/** Architecture: manager convo ⇄ hub ⇄ workers ⇄ GitLab. */
function ArchitectureDiagram() {
  return (
    <div
      className="flex flex-wrap items-stretch justify-center gap-2 rounded-lg border border-[var(--color-border-default)] p-4"
      data-testid="manager-guide-architecture"
      role="img"
      aria-label="Architecture: the manager conversation exchanges commands with the hub's executor and monitor, which launch and monitor worker conversations that push branches and draft MRs to GitLab"
    >
      <DiagramBox tone="cyan" title="🧭 Manager conversation">
        judgment: plans waves, reacts to triggers
      </DiagramBox>
      <Arrow label="fenced manager-command JSON / triggers" />
      <DiagramBox tone="gray" title="Hub (executor + monitor)">
        deterministic mechanics: validates every command, launches waves, derives phases
      </DiagramBox>
      <Arrow label="prompts / nudges / status polls" />
      <DiagramBox tone="violet" title="Worker conversations (≤ 8/wave)">
        each clones the repo into its own sessions/&lt;uuid&gt; dir
      </DiagramBox>
      <Arrow label="branches, draft MRs, CI" />
      <DiagramBox tone="amber" title="GitLab">
        draft MRs only — humans merge
      </DiagramBox>
    </div>
  );
}

const LIFECYCLE_STEPS = [
  { label: "chat", detail: "any plain conversation" },
  { label: "Promote", detail: "one click — repo inferred" },
  { label: "manager drafts plan", detail: "file-disjoint waves" },
  { label: "human approves", detail: "repo + size advisory shown" },
  { label: "wave launches", detail: "≤ 8 worker conversations" },
  { label: "derived phases", detail: "agent + GitLab signals" },
  { label: "wave gates", detail: "all at pr-open before next" },
  { label: "run review", detail: "manager summarises" },
  { label: "summary", detail: "humans merge the MRs" },
];

function LifecycleDiagram() {
  return (
    <ol
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-border-default)] p-4"
      data-testid="manager-guide-lifecycle"
      aria-label="Run lifecycle from chat to summary"
    >
      {LIFECYCLE_STEPS.map((step, i) => (
        <li key={step.label} className="flex items-center gap-1.5">
          <span className="flex flex-col rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.06))] px-2 py-1 text-center">
            <span className="text-xs font-medium">{step.label}</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">{step.detail}</span>
          </span>
          {i < LIFECYCLE_STEPS.length - 1 ? <span aria-hidden className="text-[var(--color-text-muted)]">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** The 1:1 pattern: you ⇄ manager ⇄ one continuously-working worker → draft MR. */
function OneOnOneDiagram() {
  return (
    <div
      className="space-y-2 rounded-lg border border-[var(--color-border-default)] p-4"
      data-testid="manager-guide-one-on-one"
      role="img"
      aria-label="The 1:1 pattern: you chat with the manager conversation at any time; the manager nudges a single worker that never stops; the run board shows activity and the worker delivers a draft MR you review and merge"
    >
      <div className="flex flex-wrap items-stretch justify-center gap-2">
        <DiagramBox tone="gray" title="You">chat anytime — questions, new requirements</DiagramBox>
        <Arrow label="chat" />
        <DiagramBox tone="cyan" title="🧭 Manager convo">digests + nudges</DiagramBox>
        <Arrow label="nudges / triggers" />
        <DiagramBox tone="violet" title="1 worker">never stops working</DiagramBox>
      </div>
      <div className="flex items-center justify-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <span aria-hidden>↳</span>
        <span>run board / activity log</span>
        <span aria-hidden>→</span>
        <DiagramBox tone="amber" title="draft MR">you review + merge</DiagramBox>
      </div>
    </div>
  );
}

/** Phase state machine as an inline SVG: linear happy path + blocked from anywhere. */
function PhaseDiagram() {
  const phases = ["assigned", "working", "pushed", "pr-open", "done"];
  const boxW = 96;
  const gap = 34;
  const y = 24;
  return (
    <svg
      viewBox={`0 0 ${phases.length * (boxW + gap)} 150`}
      className="w-full max-w-2xl"
      data-testid="manager-guide-phases"
      role="img"
      aria-label="Worker phase state machine: assigned to working to pushed to pr-open to done, with blocked reachable from every phase"
    >
      {phases.map((phase, i) => {
        const x = i * (boxW + gap);
        return (
          <g key={phase}>
            <rect x={x} y={y} width={boxW} height={30} rx={6} fill="none" stroke="currentColor" opacity={0.7} />
            <text x={x + boxW / 2} y={y + 19} textAnchor="middle" fontSize="12" fill="currentColor">
              {phase}
            </text>
            {i < phases.length - 1 ? (
              <text x={x + boxW + gap / 2} y={y + 19} textAnchor="middle" fontSize="12" fill="currentColor" opacity={0.6}>
                →
              </text>
            ) : null}
            {/* every phase can drop to blocked */}
            <line
              x1={x + boxW / 2}
              y1={y + 30}
              x2={(phases.length * (boxW + gap)) / 2 - gap / 2}
              y2={104}
              stroke="currentColor"
              opacity={0.25}
            />
          </g>
        );
      })}
      <rect
        x={(phases.length * (boxW + gap)) / 2 - 70}
        y={104}
        width={110}
        height={30}
        rx={6}
        fill="none"
        stroke="#ef4444"
      />
      <text
        x={(phases.length * (boxW + gap)) / 2 - 15}
        y={123}
        textAnchor="middle"
        fontSize="12"
        fill="#ef4444"
      >
        blocked
      </text>
    </svg>
  );
}

// The command loop as a message-by-message sequence: everything the manager
// "does" is a fenced JSON block parsed by the monitor and executed by the
// executor; workers never self-report — their phase is derived.
const COMMAND_LOOP_DIAGRAM = `
 MANAGER conversation                MONITOR/EXECUTOR (hub)                    WORKER conversation
 ────────────────────                ──────────────────────                    ───────────────────
 {"command":"propose_plan",…}    ──▶ parse → validate → store plan
                                      (plan-ready; human approves/rejects)
                                      approve ─▶ executor.launchWave(1) ─────▶ new conversation created,
                                                                               opening prompt = contract
                                                                               (clone, branch, draft MR,
                                                                                never merge)
                                      every ~10s: derive phase from
                                      exec status + GitLab signals  ◀───────── (no self-reporting)
                                      worker blocked/stale?
 ◀── "TRIGGER: worker-blocked …" ──── debounced 5 min, never mid-turn
 {"command":"nudge_worker",…}    ──▶ validate ─▶ executor ───────────────────▶ "MANAGER NUDGE: …"
 ◀── "EXECUTOR RESULT (nudge_worker): OK — …"
                                      wave complete ─▶ "TRIGGER: wave-complete"
 {"command":"launch_wave",2}     ──▶ gated: all earlier workers at pr-open
                                      all waves done ─▶ "TRIGGER: run-review"
 {"command":"complete_run",…}    ──▶ run → completed (humans merge the MRs)
`.replace(/^\n/, "");

const COMMANDS: Array<{ name: string; args: string; what: string }> = [
  { name: "propose_plan", args: "{ plan, rationale?, repoUrl? }", what: "Propose file-disjoint waves (while planning or plan-ready — re-emitting replaces the pending plan). On repo-less one-click promotions the plan must name the repository; its repoUrl also corrects an inferred repo." },
  { name: "launch_wave", args: "{ wave }", what: "Launch the next wave — gated until every earlier worker is at pr-open/done." },
  { name: "nudge_worker", args: "{ task, message, model? }", what: "Deliver a steering message into a worker conversation (also unblocks it). The optional model switches the worker's LLM for its next steps (allowlisted models only)." },
  { name: "inspect_worker", args: "{ task, mode? }", what: "Read-only, on-demand view of a worker's transcript (truncated by default; modes recent / last-message / last-error / last-tool). Secrets redacted; viewing never mutates the worker." },
  { name: "request_human", args: "{ reason }", what: "Ask for human attention; recorded as a run note on the board." },
  { name: "complete_run", args: "{ summary }", what: "Close the run once every worker has an MR; the summary lands in the run notes." },
];

export function ManagerGuidePage() {
  return (
    <div className="space-y-8 p-6" data-testid="manager-guide-page">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Manager runs</h1>
        <Badge variant="beta">beta</Badge>
      </div>
      <div className="max-w-3xl space-y-8 text-sm leading-relaxed">
        <Section title="What it is">
          <p>
            A manager run turns one conversation into the <strong>manager</strong> (the judgment:
            it plans and decides) of a parallel coding-agent run, while a deterministic{" "}
            <strong>executor/monitor</strong> in the hub handles the mechanics: launching up to{" "}
            <strong>8 worker conversations per wave</strong>, monitoring them, and validating every
            command the manager issues. Workers push branches and open <strong>draft MRs</strong>;{" "}
            <strong>humans merge</strong> — there is no merge capability anywhere in the product.
          </p>
        </Section>

        <Section title="Architecture">
          <ArchitectureDiagram />
          <p className="text-xs text-[var(--color-text-muted)]">
            The manager holds no handle to workers: every effect goes through the hub, which parses
            fenced <code>manager-command</code> JSON blocks from the manager's messages, validates
            them server-side, and executes them. There is no conversation-to-conversation control
            and no merge command in the vocabulary.
          </p>
        </Section>

        <Section title="The command loop, message by message">
          <pre
            className="overflow-x-auto rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-muted,rgba(127,127,127,0.06))] p-3 font-mono text-[11px] leading-4"
            data-testid="manager-guide-command-loop"
          >
            {COMMAND_LOOP_DIAGRAM}
          </pre>
          <p className="text-xs text-[var(--color-text-muted)]">
            Left to right: the manager's fenced <code>manager-command</code> JSON blocks are the
            only way anything happens; the hub validates and executes each one, replying with{" "}
            <code>EXECUTOR RESULT</code> messages, and wakes the manager with debounced{" "}
            <code>TRIGGER</code> messages when derived worker state needs a decision.
          </p>
        </Section>

        <Section title="Lifecycle">
          <LifecycleDiagram />
          <p className="text-xs text-[var(--color-text-muted)]">
            Promotion is one click on any conversation — the repository is inferred from the
            workspace or the transcript (the manager resolves it in its plan when inference fails,
            and its plan's <code>repoUrl</code> corrects a wrongly inferred repo).
            The human approval step shows the resolved repository and a shared-pod clone-size
            advisory before anything launches. While the plan awaits approval you can{" "}
            <strong>reject it</strong> (the run returns to planning) and the manager can{" "}
            <strong>re-propose</strong>, replacing the pending plan. A run that ends
            (completed/failed/cancelled) releases its conversation, so it can be promoted again
            into a fresh run.
          </p>
        </Section>

        <Section title="Worker phases (derived, never self-reported)">
          <PhaseDiagram />
          <p className="text-xs text-[var(--color-text-muted)]">
            Phases are derived by the monitor from agent execution status plus GitLab signals
            (branch exists → pushed; open draft MR → pr-open), never from what a worker claims.{" "}
            <strong>blocked</strong> is reachable from anywhere — including "finished without an
            MR", the silent-death case.
          </p>
        </Section>

        <Section title="What you can do">
          <ul className="list-disc space-y-1 pl-5">
            <li>Promote any conversation into a manager (one click in its header).</li>
            <li>Chat with the manager natively — it stays an ordinary conversation with a cyan skin.</li>
            <li>Approve the proposed plan (launches wave 1), reject it (the run returns to planning for revision), or cancel the run.</li>
            <li>Promote a conversation again after its run completed, failed, or was cancelled — the planning context carries over into a fresh run.</li>
            <li>Nudge workers directly from the run panel or the wide board.</li>
            <li>Read the persisted activity log — every trigger, command, and transition.</li>
            <li>Open any worker's full transcript (they are normal conversations).</li>
            <li>Use the wide board (<code>/openhands/runs/:id</code>) for the worst-first overview.</li>
          </ul>
        </Section>

        <Section title="The 1:1 pattern — asynchrony, not parallelism">
          <p>
            A run with a <strong>single worker</strong> is independently valuable: the worker works
            continuously while you talk to the manager conversation without interrupting it — status
            questions, time estimates, and new requirements all flow through the manager as chat and
            nudges, and the worker never loses focus. This enables the vague-idea workflow: promote a
            conversation with a rough goal, let the one worker start immediately, then refine the
            scope by chatting with the manager while it forwards digested additions. No wall-clock is
            wasted on your own uncertainty.
          </p>
          <OneOnOneDiagram />
          <p className="text-xs text-[var(--color-text-muted)]">
            Honest caveat: you review the worker's output even less than usual — the draft MR is your
            forcing function; read it before merging.
          </p>
        </Section>

        <Section title="manager-command reference">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" data-testid="manager-guide-commands">
              <thead>
                <tr className="border-b border-[var(--color-border-default)] text-left">
                  <th className="py-1.5 pr-3 font-semibold">command</th>
                  <th className="py-1.5 pr-3 font-semibold">arguments</th>
                  <th className="py-1.5 font-semibold">effect</th>
                </tr>
              </thead>
              <tbody>
                {COMMANDS.map((c) => (
                  <tr key={c.name} className="border-b border-[var(--color-border-default)] align-top">
                    <td className="py-1.5 pr-3 font-mono">{c.name}</td>
                    <td className="py-1.5 pr-3 font-mono text-[var(--color-text-muted)]">{c.args}</td>
                    <td className="py-1.5">{c.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Commands are emitted as fenced <code>```manager-command</code> JSON blocks and validated
            server-side; anything unknown or malformed is rejected and logged.
          </p>
        </Section>

        <Section title="Limits">
          <ul className="list-disc space-y-1 pl-5">
            <li>Hard cap of <strong>8 workers per wave</strong> — everything shares one agent-server pod.</li>
            <li>
              Every worker clones the repo onto that shared pod, so the feature is best for
              small-to-medium repos (the approval step shows the projected clone footprint).
            </li>
            <li>
              Orphaned workers (their manager gone from the list) stay visible in the Hub — never
              hidden.
            </li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
