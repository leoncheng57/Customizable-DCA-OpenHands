// client/components/RepoSelect.tsx
//
// Staged repository picker for the OpenHands hub. GitLab hands us flat
// `path_with_namespace` strings (group/subgroup/foo); a single
// dropdown over the full membership set is unusable once there are dozens of
// projects. This walks the namespace one segment at a time (group →
// subgroup → …), pins a handful of commonly-used repos for one-click
// selection, and offers a typeahead filter so anyone who already knows the
// repo name can jump straight to it instead of drilling down level by level.
// The helper functions are pure so the drill-down and filter logic are unit
// testable without a DOM.
import { useState } from "react";
import { Button } from "../ds/button.js";
import type { RepoOption } from "../lib/api.js";

/**
 * Path fragments pinned as commonly-used repos. Matched by exact path or
 * `/`-suffix against the bot-clonable list, so a pin only renders when the
 * agent can actually reach it.
 */
export const PINNED_REPO_HINTS = ["customizable-dca-openhands", "demo-project"];

const SELECT_CLASS =
  "min-w-[10rem] flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm";

/** Distinct next path segments directly below `prefix`, sorted alphabetically. */
export function childSegments(repos: RepoOption[], prefix: string[]): string[] {
  const head = prefix.join("/");
  const seen = new Set<string>();
  for (const repo of repos) {
    const parts = repo.path.split("/");
    if (prefix.length >= parts.length) continue;
    if (prefix.length > 0 && parts.slice(0, prefix.length).join("/") !== head) continue;
    seen.add(parts[prefix.length]);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** True when `segments` join to the exact path of a known repo (a leaf). */
export function isRepoPath(repos: RepoOption[], segments: string[]): boolean {
  if (segments.length === 0) return false;
  const path = segments.join("/");
  return repos.some((r) => r.path === path);
}

/** Resolve a pin hint to a repo (exact path first, then `/`-suffix), or null. */
export function resolvePin(repos: RepoOption[], hint: string): RepoOption | null {
  return repos.find((r) => r.path === hint) ?? repos.find((r) => r.path.endsWith(`/${hint}`)) ?? null;
}

/**
 * Repos whose path contains `query` (case-insensitive), ranked so the most
 * likely target comes first: repo name (last segment) prefix match, then any
 * segment prefix match, then a bare substring, ties broken alphabetically.
 * Blank queries return nothing; results are capped at `limit`.
 */
export function filterRepos(repos: RepoOption[], query: string, limit = 8): RepoOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (path: string): number => {
    const lower = path.toLowerCase();
    if (!lower.includes(q)) return -1;
    const name = lower.split("/").pop() ?? lower;
    if (name.startsWith(q)) return 0;
    if (lower.split("/").some((seg) => seg.startsWith(q))) return 1;
    return 2;
  };
  return repos
    .map((repo) => ({ repo, score: rank(repo.path) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.repo.path.localeCompare(b.repo.path))
    .slice(0, limit)
    .map((entry) => entry.repo);
}

export interface RepoSelectProps {
  /** Bot-clonable repos, or null while still loading. */
  repos: RepoOption[] | null;
  /** Currently resolved repo path ("" when the drill-down is incomplete). */
  value: string;
  /** Called with a full repo path on resolve, or "" when it becomes partial. */
  onChange: (path: string) => void;
  /** Path fragments to surface as one-click quick picks. */
  pins?: string[];
}

/**
 * Cascading namespace picker + pinned quick picks. Reports a resolved repo
 * path via `onChange` (empty string while the selection is still partial).
 */
export function RepoSelect({ repos, value, onChange, pins = PINNED_REPO_HINTS }: RepoSelectProps) {
  const list = repos ?? [];
  // Drill-down state, seeded from any pre-resolved value.
  const [segments, setSegments] = useState<string[]>(value ? value.split("/") : []);
  // Typeahead filter; while non-blank it replaces the cascading dropdowns with
  // a flat, ranked shortlist so a known repo can be picked in one step.
  const [query, setQuery] = useState("");

  if (repos === null) {
    return (
      <select className={SELECT_CLASS} disabled aria-label="Repository for suggested issues" data-testid="openhands-issue-repo">
        <option>Loading repositories…</option>
      </select>
    );
  }

  const pick = (level: number, segment: string) => {
    const next = segment ? [...segments.slice(0, level), segment] : segments.slice(0, level);
    setSegments(next);
    onChange(isRepoPath(list, next) ? next.join("/") : "");
  };

  const pickPin = (repo: RepoOption) => {
    setSegments(repo.path.split("/"));
    onChange(repo.path);
  };

  const pickRepo = (repo: RepoOption) => {
    setSegments(repo.path.split("/"));
    setQuery("");
    onChange(repo.path);
  };

  const searching = query.trim().length > 0;
  const matches = searching ? filterRepos(list, query) : [];

  // One <select> per namespace level; the next level only appears once the
  // current one has a value, and the chain stops at a repo leaf.
  const levels: { options: string[]; selected: string }[] = [];
  for (let i = 0; ; i++) {
    const prefix = segments.slice(0, i);
    if (isRepoPath(list, prefix)) break;
    const options = childSegments(list, prefix);
    if (options.length === 0) break;
    levels.push({ options, selected: segments[i] ?? "" });
    if (!segments[i]) break;
  }

  const resolved = isRepoPath(list, segments) ? segments.join("/") : "";
  const seenPins = new Set<string>();
  const resolvedPins = pins
    .map((hint) => resolvePin(list, hint))
    .filter((repo): repo is RepoOption => {
      if (!repo || seenPins.has(repo.path)) return false;
      seenPins.add(repo.path);
      return true;
    });

  return (
    <div className="flex w-full flex-col gap-2">
      {resolvedPins.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="openhands-repo-pins">
          <span className="text-[11px] text-[var(--color-text-muted)]">Pinned:</span>
          {resolvedPins.map((repo) => (
            <Button
              key={repo.path}
              size="sm"
              variant={resolved === repo.path ? "primary" : "secondary"}
              title={repo.path}
              onClick={() => pickPin(repo)}
            >
              {repo.path.split("/").slice(-2).join("/")}
            </Button>
          ))}
        </div>
      )}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter repositories by name…"
        className={SELECT_CLASS}
        aria-label="Filter repositories by name"
        data-testid="openhands-repo-search"
      />
      {searching ? (
        matches.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="openhands-repo-search-results">
            {matches.map((repo) => (
              <li key={repo.path}>
                <button
                  type="button"
                  onClick={() => pickRepo(repo)}
                  title={repo.path}
                  className="w-full truncate rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-2 py-1 text-left text-sm hover:bg-[var(--color-background-subtle)]"
                >
                  {repo.path}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-repo-search-empty">
            No repositories match “{query.trim()}”.
          </span>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {levels.map((level, i) => (
            <select
              key={i}
              value={level.selected}
              onChange={(e) => pick(i, e.target.value)}
              className={SELECT_CLASS}
              aria-label={i === 0 ? "Repository for suggested issues" : `Repository namespace level ${i + 1}`}
              data-testid={i === 0 ? "openhands-issue-repo" : `openhands-issue-repo-level-${i}`}
            >
              <option value="">{i === 0 ? "Select a repository…" : "Select…"}</option>
              {level.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
      {resolved && (
        <span className="text-[11px] text-[var(--color-text-muted)]" data-testid="openhands-issue-repo-resolved">
          Selected: {resolved}
        </span>
      )}
    </div>
  );
}
