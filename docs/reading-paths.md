# Reading paths

What an agent — or a new human — actually opens in this repo, in what order, for each kind of
change. This page is **descriptive, not prescriptive**: it documents the path that emerges
from how the codebase is organised. If your reading diverges sharply from it, that is a
signal the conventions have drifted, not that you are reading wrong.

Companion pages: [folder-structure.md](folder-structure.md) says *where things live*; this one
says *what you end up opening*. [agent-sessions.md](agent-sessions.md) covers the
self-development loop an agent runs inside.

## 1 · The four layers

```text
┌─ LAYER 0 · INJECTED, never "opened" ───────────────────────────────────┐
│  ~/.config/<agent>/AGENTS.md     machine-wide agent rules              │
│  AGENTS.md                ~105ln repo memory, EVERY session pays       │
│    └─ ~1/3 workflow · ~2/3 "don't break this" contracts                │
│       (transcript events, plan mode, skill toggles, palette)           │
└────────────────────────────────────────────────────────────────────────┘
                    │ arrives before you know you need it
                    ▼
┌─ LAYER 1 · ORIENT (~200 lines, once per session) ──────────────────────┐
│  CONTRIBUTING.md           95ln  checks table + the index of all docs  │
│  docs/folder-structure.md 102ln  annotated tree → "where does X live"  │
│  docs/risk-map.md                only if the area might be 🔴          │
│  docs/architecture.md     127ln  only if crossing BFF ↔ agent-server   │
└────────────────────────────────────────────────────────────────────────┘
                    │  now route by task type ↓
```

## 2 · The router — task type decides everything after this

```text
                      "what am I actually changing?"
                                    │
   ┌──────────────┬─────────────────┼──────────────┬─────────────────┐
   ▼              ▼                 ▼              ▼                 ▼
 UI / page     BFF route        a doc page       CI / workflow     tests
   │              │                 │              │                 │
 docs/design-   docs/            client/lib/     docs/cicd.md     docs/testing.md
   system.md      architecture     docs.ts         │                 │
 client/ds/*      .md            docs/*.md       .github/          tests/*.test.ts
   (1 exemplar) server/openhands/   │              workflows/*        (1 exemplar)
 client/main.tsx   setup.ts       tests/docs-      │               vitest.config.ts
   (routes+shell)  3.2k lines ⚠    registry      risk-map.yml      playwright.
 client/styles.css READ IN SLICES   .test.ts       (ci = 🟠)          config.ts
   (--color-* only) grep → sed    ⚠ enforces
 client/lib/api.ts                   sync
```

⚠ **Big files are never read whole.** `server/openhands/setup.ts` is ~3,200 lines; the access
pattern is always `grep -n` for a symbol, then read the surrounding range. Reading it end to
end would spend the context window on one route.

## 3 · A real trace — the Cmd+K command palette

The fourteen files opened while building `client/lib/palette.ts` and
`client/ds/command-palette.tsx`, and why:

```text
 FILE                        WHY IT WAS OPENED                     KIND
 ─────────────────────────────────────────────────────────────────────
 AGENTS.md              ──▶  injected                              memory
 CONTRIBUTING.md        ──▶  conventions + no-new-deps rule        rules
 docs/design-system.md  ──▶  how to add a ds/ primitive            rules
 docs/testing.md        ──▶  which tiers must be green             rules
      │
      ▼  ── then: ONE EXEMPLAR PER CONCERN, not the whole directory ──
 client/main.tsx             mount point + the NAV registry        target
 client/ds/button.tsx        house style (forwardRef, cn, display) exemplar
 components/RepoSelect.tsx   the matcher to generalise             exemplar
 client/lib/docs.ts          DOCS registry = a command source      target
 client/lib/api.ts           ConversationSummary + list()          target
 ConversationSidebar.tsx     it uses z-50 → palette needs z-[60]   constraint
 pages/Conversation.tsx      existing keydown + cleanup pattern    exemplar
 client/styles.css           which --color-* tokens exist          constraint
 tests/tab-meta.test.ts      how this repo writes a unit test      exemplar
 tests/e2e/smoke.ui.spec.ts  how it writes an e2e case             exemplar
 ─────────────────────────────────────────────────────────────────────
 Not one of them was read "to learn the codebase".
```

## 4 · The verify loop

```text
   edit ──▶ typecheck ──▶ vitest ──▶ build ──▶ e2e / screenshots
             seconds       seconds    ~40 s     minutes + a stack
              │             │           │              │
              └─────────────┴───────────┘              │
                 tight loop, run constantly     run once, needs a
                                                VERIFIED-OWNED port
```

Tiers and their costs: [testing.md](testing.md). The port caveat is not pedantry — more than
one project on a machine can be running this same server binary, so confirm the listener is
yours before trusting anything you capture ([testing.md](testing.md)).

## What this shape reveals

**Reading is exemplar-driven, not exhaustive.** One design-system primitive is opened to learn
the idiom, not all of them; one unit test, not the suite. That works *because* the conventions
are uniform enough for a single sample to generalise — which makes uniformity a load-bearing
property of this codebase, not a matter of taste. Where it breaks down, so does the reading.

**Layer 0's cost is real and its value is asymmetric.** Every session pays for contracts it
may not need. But those lines are the only place facts like *"`agent_settings_diff`
deep-merges objects but REPLACES LISTS"* exist, and nobody opens a doc to look up something
they don't know is dangerous. The waste buys insurance against unknown unknowns — which is
also why `AGENTS.md` inlines content instead of linking to it.
