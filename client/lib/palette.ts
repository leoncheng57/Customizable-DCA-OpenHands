// Command palette model + matcher (Cmd/Ctrl+K). Deliberately React-free and
// side-effect-free so the whole behaviour of the palette is unit-testable in
// vitest's `environment: "node"` — the component in client/ds/command-palette.tsx
// is then a thin keyboard/ARIA shell over these two functions.
//
// Why a hand-rolled matcher instead of cmdk/fuse.js: CONTRIBUTING.md keeps the
// app dependency-light and auditable, and the repo already had the ranking
// heuristic it needs — `filterRepos` in components/RepoSelect.tsx. That
// function scores GitLab repo paths as leaf-prefix (0) > any-segment-prefix (1)
// > bare substring (2), ties broken alphabetically, capped. `rankCommands`
// generalises exactly that, with "leaf" reinterpreted as the command's own
// title (its most specific label) and "segments" as the words of the title
// plus its keywords. Keeping the two shapes aligned means anyone who has read
// RepoSelect already understands palette ordering.
//
// Two deliberate divergences from `filterRepos`, both because a palette is a
// launcher rather than a typeahead:
//   · a blank query returns the natural (unranked) list rather than nothing —
//     opening the palette must show something to arrow through;
//   · equal-scoring hits are tie-broken by kind first (nav → action → doc →
//     conversation) so the small, stable, always-present entries stay above a
//     long conversation list instead of being alphabetised into it.

import type { ConversationSummary } from "./api.js";
import type { DocMeta } from "./docs.js";

/** What a command does, and which registry it came from. */
export type CommandKind = "nav" | "action" | "doc" | "conversation";

/** Tie-break order for equal-scoring hits (lower wins). Also the order a
 *  blank query renders in, since `buildCommands` emits in the same sequence. */
const KIND_WEIGHT: Record<CommandKind, number> = {
  nav: 0,
  action: 1,
  doc: 2,
  conversation: 3,
};

export interface Command {
  /** Stable and unique across the whole list — the palette uses it verbatim
   *  as the option's DOM id for `aria-activedescendant`, so it must be a
   *  valid id (no spaces) and must not collide. */
  id: string;
  kind: CommandKind;
  /** Primary label. Also the "leaf" the matcher gives its top rank to. */
  title: string;
  /** Secondary line: a blurb, a route, a status. Not matched against — the
   *  matcher stays predictable by scoring only `title` + `keywords`. */
  subtitle?: string;
  /** Short right-aligned category label shown on the row. */
  group: string;
  /** Extra match terms that are not worth showing (slugs, ids, synonyms). */
  keywords?: string[];
  /** Router path to navigate to. Mutually exclusive with `run`. */
  to?: string;
  /** Imperative effect (theme toggle). Mutually exclusive with `to`. */
  run?: () => void;
}

export interface NavEntry {
  to: string;
  label: string;
}

export interface BuildCommandsInput {
  /** The top-nav registry (`NAV` in main.tsx), already stripped of its icons
   *  so this module stays free of React/lucide imports. */
  nav: NavEntry[];
  /** The Contributing registry (`DOCS` in lib/docs.ts). */
  docs: DocMeta[];
  /** Conversations from `openHandsApi.list()` — fetched when the palette
   *  opens, never polled (three pollers already exist; see Hub + notify). */
  conversations: ConversationSummary[];
  /** Current resolved theme, used only to word the toggle command. */
  theme: "light" | "dark";
  /** Effect for the theme command. Passed in rather than imported so this
   *  module never touches next-themes. */
  onToggleTheme: () => void;
}

/** Human label for a conversation that may have no title yet. */
export function conversationLabel(conversation: ConversationSummary): string {
  const title = conversation.title?.trim();
  return title ? title : `Conversation ${conversation.id.slice(0, 8)}`;
}

/**
 * Flatten the app's three palette-shaped registries plus the standalone
 * actions into one ordered command list. Order matters: it is what a blank
 * query renders, and it seeds the kind tie-break for ranked queries.
 */
export function buildCommands(input: BuildCommandsInput): Command[] {
  const commands: Command[] = [];

  for (const item of input.nav) {
    commands.push({
      id: `nav:${item.to}`,
      kind: "nav",
      title: item.label,
      subtitle: item.to,
      group: "Go to",
      keywords: [item.to],
      to: item.to,
    });
  }

  commands.push({
    id: "action:toggle-theme",
    kind: "action",
    // Worded as the outcome, not the state, so the label answers "what will
    // Enter do" — the same phrasing the navbar toggle uses in its tooltip.
    title: input.theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
    subtitle: "Toggle the colour theme",
    group: "Action",
    keywords: ["theme", "dark", "light", "appearance", "toggle"],
    run: input.onToggleTheme,
  });

  for (const doc of input.docs) {
    commands.push({
      id: `doc:${doc.slug}`,
      kind: "doc",
      title: doc.title,
      subtitle: doc.blurb,
      group: "Docs",
      keywords: [doc.slug, doc.category, doc.path],
      to: `/openhands/contributing/${doc.slug}`,
    });
  }

  for (const conversation of input.conversations) {
    commands.push({
      id: `conversation:${conversation.id}`,
      kind: "conversation",
      title: conversationLabel(conversation),
      subtitle: conversation.execution_status,
      group: "Conversation",
      keywords: [conversation.id],
      to: `/openhands/native/conversations/${conversation.id}`,
    });
  }

  return commands;
}

/** Words a command can be matched on, lowercased. */
function terms(command: Command): string[] {
  return [command.title, ...(command.keywords ?? [])].map((t) => t.toLowerCase());
}

/** Word-ish segments of a term: paths, dashes, dots and spaces all split. */
function segments(term: string): string[] {
  return term.split(/[\s/._-]+/).filter(Boolean);
}

/**
 * Score one command against an already-lowercased, non-blank query.
 * Mirrors `filterRepos`: -1 = no match (drop), 0 = title prefix, 1 = any
 * word/segment prefix, 2 = bare substring.
 */
function score(command: Command, q: string): number {
  const all = terms(command);
  if (!all.some((t) => t.includes(q))) return -1;
  if (all[0].startsWith(q)) return 0;
  if (all.some((t) => segments(t).some((seg) => seg.startsWith(q)))) return 1;
  return 2;
}

/**
 * Commands matching `query`, best first, capped at `limit`.
 *
 * A blank query is not "no results" but "no filter": the natural order is
 * returned (capped), because that is what the palette shows the instant it
 * opens. Non-blank queries drop anything without a substring hit, then sort
 * by score, then by kind weight, then alphabetically — a total order, so the
 * list never reshuffles between renders.
 */
export function rankCommands(commands: Command[], query: string, limit = 50): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  return commands
    .map((command) => ({ command, score: score(command, q) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        a.score - b.score ||
        KIND_WEIGHT[a.command.kind] - KIND_WEIGHT[b.command.kind] ||
        a.command.title.localeCompare(b.command.title),
    )
    .slice(0, limit)
    .map((entry) => entry.command);
}
