// server/openhands/repo-infer.ts
//
// Best-effort inference of the git repository a conversation works on.
// Used by one-click promote (no repo field in the UI anymore) and by the
// preview auto-clone path. Two probes, both tolerant to every failure:
//
//   Probe A — the workspace itself: resolve the conversation's working_dir,
//   discover the repo checkout inside it (same chain the preview start uses:
//   the root itself, else the first child directory that is a git repo), and
//   read `git remote get-url origin`.
//
//   Probe B — the transcript: the Hub create-flow embeds
//   "Clone <url> into the workspace" in the FIRST user message, so the
//   earliest events usually carry the canonical https URL.
//
// The result is always a validated https URL on gitlab.com / github.com
// (ssh remotes are converted), or null. Callers decide what null means.
import type { UpstreamFetch } from "./upstream.js";

const WORKSPACE_ROOT = "/home/openhands/workspace";
// Same host allowlist the BFF and manager routes enforce.
const REPO_URL_RE = /^https:\/\/(gitlab\.com|github\.com)\/[\w./-]+$/;
// Probe B text extraction. The Hub create-flow embeds
// "Clone <url> into the workspace" — that explicit preamble is authoritative.
const CLONE_PREAMBLE_RE =
  /Clone (https:\/\/(?:gitlab\.com|github\.com)\/[\w./-]+) into the workspace/;
// Generic fallback: any allowed-host https URL in free text. GitLab WEB routes
// are not repos — the Hub's environment-constraints preamble contains an
// example uploads URL (https://gitlab.com/-/project/<id>/uploads/…) that this
// must never match, so `/-/` path segments are excluded.
const REPO_URL_IN_TEXT_RE =
  /https:\/\/(?:gitlab\.com|github\.com)\/[\w./-]+/g;
const WEB_ROUTE_SEGMENT_RE = /\/(?:-|uploads)(?:\/|$)/;
// ssh clone form: git@gitlab.com:group/sub/repo.git
const SSH_REMOTE_RE = /^(?:ssh:\/\/)?git@(gitlab\.com|github\.com)[:/]([\w./-]+)$/;
const PROBE_TIMEOUT_MS = 15_000;
const BASH_TIMEOUT_SECONDS = 10;

/** Single-quote a string for POSIX sh (mirrors setup.ts shellQuote). */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Normalize a git remote (https or ssh) to a validated https repo URL on an
 * allowed host, or null. Strips a trailing `.git` and trailing slashes.
 */
export function normalizeRepoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url = raw.trim();
  if (url.length === 0 || url.length > 2_048) return null;
  const ssh = SSH_REMOTE_RE.exec(url);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  url = url.replace(/\.git$/, "").replace(/\/+$/, "");
  return REPO_URL_RE.test(url) ? url : null;
}

/**
 * Repo URL mentioned in free text, or null. The explicit
 * "Clone <url> into the workspace" preamble wins; the generic fallback skips
 * GitLab web-route URLs (`/-/…`, uploads) and requires a `group/repo` shape —
 * without this, the Hub's guardrail preamble (which contains an example
 * uploads URL) was inferred as the "repo" for every conversation it created.
 */
export function extractRepoUrlFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const preamble = CLONE_PREAMBLE_RE.exec(text);
  if (preamble) return normalizeRepoUrl(preamble[1]);
  for (const match of text.matchAll(REPO_URL_IN_TEXT_RE)) {
    const url = normalizeRepoUrl(match[0]);
    if (!url) continue;
    const path = url.replace(/^https:\/\/[^/]+\//, "");
    if (WEB_ROUTE_SEGMENT_RE.test(`/${path}/`)) continue; // gitlab web route, not a repo
    if (path.split("/").length < 2) continue; // need at least group/repo
    return url;
  }
  return null;
}

/** Loose working-dir validation (repo-infer is advisory, but stays inside the workspace). */
function usableWorkingDir(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null;
  if (value.includes("..") || value.includes("\\") || value.includes("\0") || value.includes("'")) return null;
  if (value !== WORKSPACE_ROOT && !value.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  return value;
}

/** Text of the message content shapes the agent-server emits. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? String((c as { text: string }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

interface RepoInferEvent {
  llm_message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

/** Probe A: read `git remote get-url origin` from the workspace checkout. */
async function probeWorkspaceRemote(
  upstream: UpstreamFetch,
  conversationId: string,
): Promise<string | null> {
  const conv = await upstream(`/api/conversations/${conversationId}`, undefined, PROBE_TIMEOUT_MS);
  if (!conv.ok) return null;
  const body = (await conv.json()) as { workspace?: { working_dir?: unknown } };
  const root = usableWorkingDir(body.workspace?.working_dir);
  if (!root) return null;
  // Discover the checkout like the preview start does: the root itself when
  // it is a repo, else the first immediate child directory that is one.
  const script = [
    `d=${q(root)}`,
    `if [ ! -d "$d/.git" ]; then for cand in "$d"/*/.git; do if [ -d "$cand" ]; then d=\${cand%/.git}; break; fi; done; fi`,
    `git -C "$d" remote get-url origin`,
  ].join("\n");
  const r = await upstream(
    "/api/bash/execute_bash_command",
    {
      method: "POST",
      body: JSON.stringify({ command: script, cwd: WORKSPACE_ROOT, timeout: BASH_TIMEOUT_SECONDS }),
    },
    PROBE_TIMEOUT_MS,
  );
  if (!r.ok) return null;
  const out = (await r.json()) as { exit_code?: number | null; stdout?: string | null };
  if (out.exit_code !== 0) return null;
  const remote = String(out.stdout ?? "").trim().split("\n")[0] ?? "";
  return normalizeRepoUrl(remote);
}

/** Probe B: the first user message usually embeds "Clone <url> into the workspace". */
async function probeFirstUserMessage(
  upstream: UpstreamFetch,
  conversationId: string,
): Promise<string | null> {
  const r = await upstream(
    `/api/conversations/${conversationId}/events/search?limit=20`,
    undefined,
    PROBE_TIMEOUT_MS,
  );
  if (!r.ok) return null;
  const body = (await r.json()) as { items?: RepoInferEvent[] };
  if (!Array.isArray(body.items)) return null;
  for (const event of body.items) {
    const msg = event.llm_message;
    if (!msg || msg.role !== "user") continue;
    // FIRST user message only — later ones may quote unrelated repos.
    return extractRepoUrlFromText(contentText(msg.content));
  }
  return null;
}

/**
 * Infer the https repo URL a conversation works on, or null. Never throws:
 * every upstream failure, malformed payload, or unusable remote degrades to
 * null so callers can treat the result as an optional hint.
 */
export async function inferConversationRepo(
  upstream: UpstreamFetch,
  conversationId: string,
): Promise<string | null> {
  try {
    const fromWorkspace = await probeWorkspaceRemote(upstream, conversationId);
    if (fromWorkspace) return fromWorkspace;
  } catch {
    /* fall through to probe B */
  }
  try {
    return await probeFirstUserMessage(upstream, conversationId);
  } catch {
    return null;
  }
}
