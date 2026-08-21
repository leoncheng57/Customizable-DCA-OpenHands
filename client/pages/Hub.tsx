// client/pages/Hub.tsx
//
// OpenHands hub — conversation list + "new task" form, backed entirely by the
// hub's BFF (/api/openhands). The default Agent Canvas stays one click away
// as the escape hatch for anything the native UI doesn't cover yet.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../ds/badge.js";
import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { RepoSelect } from "../components/RepoSelect.js";
import { DiskUsageBar } from "../components/DiskUsageBar.js";
import { ActiveRunsStrip } from "../components/ActiveRunsStrip.js";
import {
  groupConversationsByRun,
  managerApi,
  type ConversationRole,
} from "../lib/manager-api.js";
import { AttachImagesButton, ImageChips, useChatImages } from "../components/ImageAttachments.js";
import { cachedRepos, openHandsApi, statusTone, type ConversationSummary, type OpenHandsStatus, type RepoOption, type SuggestedIssue } from "../lib/api.js";
import { WorkspaceModeBadge } from "../components/WorkspaceModeBadge.js";
import { conversationCost, formatCost } from "../lib/statusBar.js";
import { activeLocalFolderUses } from "../lib/workspace.js";
import { loadNewSessionWorktree, saveNewSessionWorktree } from "../lib/worktreePrefs.js";

const PROJECT_PINS_KEY = "openhands.projectPins.v1";
const DEFAULT_PROJECT_PINS = ["customizable-dca-openhands"];

function loadProjectPins(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_PINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_PROJECT_PINS;
}

const TONE_CLASSES: Record<ReturnType<typeof statusTone>, string> = {
  ok: "bg-[var(--color-background-surface-success-muted)] text-[var(--color-text-success)]",
  busy: "bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]",
  warn: "bg-[var(--color-background-surface-warning-muted)] text-[var(--color-text-warning)]",
  error: "bg-[var(--color-background-surface-critical-muted)] text-[var(--color-text-critical)]",
};

export const MODEL_LABELS: Record<string, string> = {
  "anthropic/claude-sonnet-5": "Claude Sonnet 5 — balanced",
  "anthropic/claude-haiku-4-5-20251001": "Claude Haiku 4.5 — fast",
  "openai/gpt-5.6-luna": "GPT-5.6 Luna — OpenAI EU · fast",
  "openai/gpt-5.6-terra": "GPT-5.6 Terra — OpenAI EU · balanced",
  "anthropic/claude-opus-4-6": "Claude Opus 4.6 — strong",
  "openai/gpt-5.6-sol": "GPT-5.6 Sol — OpenAI EU · strong",
  "anthropic/claude-opus-4-8": "Claude Opus 4.8 — stronger",
  "anthropic/claude-opus-5": "Claude Opus 5 — strongest",
  "anthropic/claude-fable-5": "Claude Fable 5 — experimental",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[statusTone(status)]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function HubPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<OpenHandsStatus | null>(null);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const attachments = useChatImages();
  const [model, setModel] = useState("");
  // Free-typed repo filter — matched against the datalist of bot-clonable
  // repos by path; a raw https URL on an allowed host is also accepted.
  const [repoText, setRepoText] = useState("");
  // Workspace mode: work in a local project folder mounted under the projects
  // root (OPENHANDS_PROJECTS_DIR — the default) vs. clone a repo by URL.
  const [workspaceMode, setWorkspaceMode] = useState<"repo" | "local">("local");
  // Agent mode: Build runs unattended; Plan researches first — writes are
  // held for approval until the plan is approved (Claude Code's plan mode).
  const [agentMode, setAgentMode] = useState<"build" | "plan">("build");
  const [localFolders, setLocalFolders] = useState<Array<{ name: string; path: string }> | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [newSessionWorktree, setNewSessionWorktree] = useState(() => loadNewSessionWorktree());
  // Filter for the project-folder grid (projects roots can hold dozens).
  const [folderFilter, setFolderFilter] = useState("");
  // Pinned projects surface first in the grid. Persisted in localStorage;
  // seeded with this repo so the primary dogfooding project is one click away.
  const [pins, setPins] = useState<string[]>(() => loadProjectPins());
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const togglePin = (path: string) => {
    setPins((current) => {
      const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
      try {
        localStorage.setItem(PROJECT_PINS_KEY, JSON.stringify(next));
      } catch {
        /* private mode etc. — pins just don't persist */
      }
      return next;
    });
  };
  // Seed from the persisted list so the pinned quick picks render immediately
  // on load; the effect below refreshes it in the background.
  const [repos, setRepos] = useState<RepoOption[] | null>(() => cachedRepos());
  const [creating, setCreating] = useState(false);
  // Suggested-issues discovery panel.
  const [issueRepo, setIssueRepo] = useState("");
  const [issues, setIssues] = useState<SuggestedIssue[] | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  // Manager-run role map + per-run expand state for the grouped list.
  const [runRoles, setRunRoles] = useState<Record<string, ConversationRole>>({});
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});

  // In-flight guard: the 10s interval keeps firing while a slow list call is
  // outstanding; skipping overlapped ticks keeps a wedged upstream from
  // accumulating stacked requests (same pathology as the conversation poll).
  const refreshInFlight = useRef(false);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    // Run-role map is best-effort: on failure keep the last known roles so
    // the manager grouping doesn't flicker away during transient errors.
    managerApi
      .conversationRoles()
      .then((r) => setRunRoles(r.roles))
      .catch(() => {});
    openHandsApi
      .list()
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        refreshInFlight.current = false;
      });
  }, []);

  useEffect(() => {
    openHandsApi.status().then(setStatus).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!model && status?.model) setModel(status.model);
  }, [model, status]);

  useEffect(() => {
    if (!status?.configured || !status.allowlisted) return;
    // Dropdown data is best-effort. On failure keep any cache-seeded list so
    // the pins survive a transient outage; only fall back to empty when we have
    // nothing to show.
    openHandsApi.repos().then((r) => setRepos(r.items)).catch(() => setRepos((prev) => prev ?? []));
    openHandsApi.localFolders().then((r) => setLocalFolders(r.items)).catch(() => setLocalFolders([]));
  }, [status]);

  useEffect(() => {
    if (!status?.configured || !status.allowlisted) return;
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [status, refresh]);

  /** Resolve the typed repo text to a clone URL (path match wins, URL passes through). */
  const resolveRepoUrl = (): string | undefined => {
    const text = repoText.trim();
    if (!text) return undefined;
    const match = (repos ?? []).find((r) => r.path === text || r.url === text);
    if (match) return match.url;
    if (/^https:\/\//.test(text)) return text; // server-side REPO_RE still validates
    return undefined;
  };

  const repoUnresolved =
    workspaceMode === "repo" && repoText.trim() !== "" && resolveRepoUrl() === undefined;
  const localUnresolved = workspaceMode === "local" && !localPath;

  // Folder → active conversations working in it (issue #31): drives the busy
  // dot on project cards and the collision warning under the grid. Advisory
  // only — two agents on one working tree is sometimes intentional.
  const busyFolders = useMemo(() => activeLocalFolderUses(items ?? []), [items]);
  const selectedFolderUses = workspaceMode === "local" && !newSessionWorktree && localPath
    ? (busyFolders.get(localPath) ?? [])
    : [];

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const { id } = await openHandsApi.create({
        prompt,
        ...(workspaceMode === "repo"
          ? { repoUrl: resolveRepoUrl() }
          : { localPath, useWorktree: newSessionWorktree }),
        model,
        mode: agentMode,
        ...(attachments.images.length > 0 ? { images: attachments.images } : {}),
      });
      attachments.clear();
      navigate(`/openhands/native/conversations/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const findIssues = async () => {
    if (!issueRepo) return;
    setIssuesLoading(true);
    setIssuesError(null);
    setIssues(null);
    try {
      const res = await openHandsApi.suggestedIssues(issueRepo);
      setIssues(res.items);
    } catch (e) {
      setIssuesError((e as Error).message);
    } finally {
      setIssuesLoading(false);
    }
  };

  /** Seed the New task form from a suggested issue and scroll to it. */
  const useIssue = (issue: SuggestedIssue) => {
    setRepoText(issueRepo);
    setPrompt(`Work on GitLab issue #${issue.iid}: ${issue.title}\n${issue.webUrl}\n\nRead the issue, propose an approach, then implement it.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (!status) return <div className="p-6"><LoadingIndicator /></div>;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex items-end gap-3 pt-2">
        <div>
          <h1 className="text-[1.6rem] font-bold tracking-tight">What should the agent do?</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Pick a project, describe the task, and watch the agent work — steer it any time.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Badge variant="beta">beta</Badge>
          {status.publicUrl && (
            <a
              href={status.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
            >
              Open Agent Canvas ↗
            </a>
          )}
        </div>
      </div>

      {!status.configured && (
        <Alert variant="warning">OpenHands is not configured on this deployment (dev-only feature).</Alert>
      )}
      {status.configured && !status.allowlisted && (
        <Alert variant="warning">
          The shared instance is single-tenant and allowlisted. Ask in the tracking issue to be added
          — conversations have separate working directories but share one pod and one GitLab identity.
        </Alert>
      )}
      {error && <Alert variant="danger">{error}</Alert>}

      {status.configured && status.allowlisted && (
        <>
          <DiskUsageBar />

          <div className="app-card p-5">
            <h2 className="mb-3 text-sm font-semibold">New task</h2>

            {/* Project folder grid — the primary way to pick a workspace.
                Folders come from OPENHANDS_PROJECTS_DIR via /local-folders. */}
            {workspaceMode === "local" && (
              <div className="mb-3" data-testid="openhands-project-grid">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--color-text-muted)]">
                    {localFolders === null
                      ? "Loading projects…"
                      : localFolders.length === 0
                        ? "No folders under the projects root (OPENHANDS_PROJECTS_DIR)"
                        : `Your projects (${localFolders.length})`}
                  </span>
                  {(localFolders?.length ?? 0) > 12 && (
                    <input
                      value={folderFilter}
                      onChange={(e) => setFolderFilter(e.target.value)}
                      placeholder="Filter…"
                      className="ml-auto w-40 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-2 py-1 text-xs"
                      data-testid="openhands-project-filter"
                      aria-label="Filter projects"
                    />
                  )}
                </div>
                <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
                  {(localFolders ?? [])
                    .filter((f) => !folderFilter || f.name.toLowerCase().includes(folderFilter.toLowerCase()))
                    // Pinned first (in pin order), then the rest alphabetically.
                    .sort((a, b) => {
                      const ai = pins.indexOf(a.path);
                      const bi = pins.indexOf(b.path);
                      if (ai !== -1 || bi !== -1) {
                        if (ai === -1) return 1;
                        if (bi === -1) return -1;
                        return ai - bi;
                      }
                      return a.name.localeCompare(b.name);
                    })
                    .map((f) => {
                      const pinned = pins.includes(f.path);
                      const uses = busyFolders.get(f.path) ?? [];
                      return (
                        <div
                          key={f.path}
                          className="app-project-card group/pin relative truncate text-left text-xs"
                          data-selected={localPath === f.path}
                          data-pinned={pinned}
                          data-busy={uses.length > 0 || undefined}
                          title={
                            uses.length > 0
                              ? `${f.path} — in use by a running conversation: ${uses.map((u) => u.title || u.id).join(", ")}`
                              : f.path
                          }
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setLocalPath(f.path === localPath ? "" : f.path);
                              promptRef.current?.focus();
                            }}
                            className="w-full truncate px-2.5 py-2 pr-7 text-left"
                            data-testid={`openhands-project-${f.name}`}
                          >
                            <span aria-hidden>{pinned ? "📌 " : "📁 "}</span>
                            {f.name}
                            {uses.length > 0 && (
                              <span
                                aria-label="A running conversation is working in this folder"
                                className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500 align-middle"
                                data-testid={`openhands-project-busy-${f.name}`}
                              />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePin(f.path);
                            }}
                            className={`absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[10px] leading-none hover:bg-[var(--hh-row-hover)] ${
                              pinned ? "opacity-70" : "opacity-0 group-hover/pin:opacity-60"
                            }`}
                            title={pinned ? "Unpin" : "Pin to top"}
                            aria-label={pinned ? `Unpin ${f.name}` : `Pin ${f.name}`}
                            data-testid={`openhands-pin-${f.name}`}
                          >
                            {pinned ? "✕" : "📌"}
                          </button>
                        </div>
                      );
                    })}
                </div>
                <label className="mt-2 flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={newSessionWorktree}
                    onChange={(e) => {
                      setNewSessionWorktree(e.target.checked);
                      saveNewSessionWorktree(e.target.checked);
                    }}
                    className="mt-0.5"
                    data-testid="openhands-new-session-worktree"
                  />
                  <span>
                    <span className="block font-medium">Use a new git worktree for each session</span>
                    <span className="block text-[var(--color-text-muted)]">
                      Recommended for parallel work. Starts from the selected project&apos;s committed HEAD;
                      uncommitted changes stay in the original checkout.
                    </span>
                  </span>
                </label>
                {/* Collision warning (issue #31): another agent is already
                    mutating this working tree — clobbered edits and branch
                    switches under each other's feet. Advisory, not blocking. */}
                {selectedFolderUses.length > 0 && (
                  <div className="mt-2" data-testid="openhands-folder-collision-warning">
                    <Alert variant="warning">
                      {selectedFolderUses.length === 1 ? (
                        <>
                          <Link to={`/openhands/native/conversations/${selectedFolderUses[0].id}`} className="underline">
                            {selectedFolderUses[0].title || "Another conversation"}
                          </Link>{" "}
                          is already working in <span className="font-mono">{localPath}</span>.
                        </>
                      ) : (
                        <>{selectedFolderUses.length} conversations are already working in <span className="font-mono">{localPath}</span>.</>
                      )}{" "}
                      Agents share this folder with your editor — parallel runs can overwrite each other's
                      changes or switch branches mid-edit. Continue only if the tasks won't touch the same files.
                    </Alert>
                  </div>
                )}
              </div>
            )}

            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={attachments.onPaste}
              placeholder="What should the agent do? Paste screenshots to attach them."
              rows={3}
              className="mb-2 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
              data-testid="openhands-prompt"
            />
            <ImageChips state={attachments} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(13rem,0.7fr)_minmax(16rem,1.3fr)_auto]">
              <select
                value={agentMode}
                onChange={(e) => setAgentMode(e.target.value as "build" | "plan")}
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                data-testid="openhands-agent-mode"
                aria-label="Agent mode"
                title={
                  agentMode === "plan"
                    ? "Plan: the agent researches and proposes a plan; write actions wait for your approval until you approve the plan."
                    : "Build: the agent works unattended (edits files, runs commands)."
                }
              >
                <option value="build">🔨 Build</option>
                <option value="plan">📋 Plan</option>
              </select>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                data-testid="openhands-model-select"
                aria-label="AI model"
              >
                {(status.models ?? (status.model ? [status.model] : [])).map((id) => (
                  <option key={id} value={id}>{MODEL_LABELS[id] ?? id}</option>
                ))}
              </select>
              <div className="flex flex-1 items-stretch gap-2">
                <select
                  value={workspaceMode}
                  onChange={(e) => setWorkspaceMode(e.target.value as "repo" | "local")}
                  className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                  data-testid="openhands-workspace-mode"
                  aria-label="Workspace mode"
                >
                  <option value="local">Project folder</option>
                  <option value="repo">Clone repo</option>
                </select>
                {workspaceMode === "repo" ? (
                  <input
                    value={repoText}
                    onChange={(e) => setRepoText(e.target.value)}
                    list="openhands-repo-options"
                    placeholder={
                      repos === null
                        ? "Loading repositories…"
                        : "Search repositories (optional) — cloned before the task"
                    }
                    className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                    data-testid="openhands-repo"
                    aria-label="Repository"
                  />
                ) : (
                  <div
                    className="flex flex-1 items-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-2 text-sm text-[var(--color-text-muted)]"
                    data-testid="openhands-local-folder"
                  >
                    {localPath ? (
                      <span className="truncate text-[var(--color-text-default)]">📁 {localPath}</span>
                    ) : (
                      <span>Pick a project above</span>
                    )}
                  </div>
                )}
              </div>
              <datalist id="openhands-repo-options">
                {(repos ?? []).map((r) => (
                  <option key={r.url} value={r.path} />
                ))}
              </datalist>
              <div className="flex items-center gap-2">
                <AttachImagesButton state={attachments} disabled={creating} />
                <Button onClick={create} disabled={creating || !prompt.trim() || repoUnresolved || localUnresolved || !model}>
                  {creating ? "Starting…" : "Start agent"}
                </Button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span>
                {repoUnresolved
                  ? "Pick a repository from the list (or paste an https URL) — free text isn't matched."
                  : localUnresolved
                    ? "Pick a local folder — directories under OPENHANDS_PROJECTS_DIR appear here."
                    : agentMode === "plan"
                      ? "Plan mode: the agent explores read-only and proposes a plan — file writes wait for your approval until you approve the plan inside the conversation."
                      : "Model applies from the first message — you can switch it per message inside the conversation."}
              </span>
            </div>
          </div>

          <div className="app-card p-5">
            <h2 className="mb-1 text-sm font-semibold">Suggested issues</h2>
            <p className="mb-3 text-[11px] text-[var(--color-text-muted)]">
              Open, unassigned issues from a repository the agent can reach — pick one to seed a task.
            </p>
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-[16rem] flex-1">
                <RepoSelect repos={repos} value={issueRepo} onChange={setIssueRepo} />
              </div>
              <Button variant="secondary" disabled={!issueRepo || issuesLoading} onClick={findIssues}>
                {issuesLoading ? "Finding…" : "Find issues"}
              </Button>
            </div>
            {issuesError && <div className="mt-3"><Alert variant="danger">{issuesError}</Alert></div>}
            {issues !== null && !issuesError && (
              issues.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                  No open, unassigned issues found in this repository.
                </p>
              ) : (
                <ul className="mt-3 space-y-2" data-testid="openhands-issue-list">
                  {issues.map((issue) => (
                    <li key={issue.iid} className="rounded-md border border-[var(--color-border-default)] p-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <a
                            href={issue.webUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium underline hover:text-[var(--color-text-default)]"
                          >
                            #{issue.iid} {issue.title} ↗
                          </a>
                          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                            Suggested because: {issue.reason}
                          </p>
                          {issue.labels.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {issue.labels.map((label) => (
                                <Badge key={label} variant="info">{label}</Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <Button size="sm" onClick={() => useIssue(issue)}>Use this</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>

          <ActiveRunsStrip />

          <div className="rounded-lg border border-[var(--color-border-default)]">
            <div className="border-b border-[var(--color-border-default)] px-4 py-2 text-sm font-semibold">
              Conversations
            </div>
            {items === null ? (
              <div className="p-6"><LoadingIndicator /></div>
            ) : items.length === 0 ? (
              <div className="p-6 text-sm text-[var(--color-text-muted)]">No conversations yet — start one above.</div>
            ) : (
              <ul>
                {groupConversationsByRun(items, runRoles).map((entry) => {
                  const c = entry.item;
                  const isManagerRow = entry.kind === "manager";
                  const expanded = isManagerRow && expandedRuns[entry.runId] === true;
                  return (
                    <li key={c.id} className="border-b border-[var(--color-border-default)] last:border-0">
                      <div className="flex items-center hover:bg-[var(--color-background-element)]">
                        {isManagerRow && entry.workers.length > 0 ? (
                          <button
                            type="button"
                            aria-label={expanded ? "Collapse workers" : "Expand workers"}
                            data-testid={`hub-run-toggle-${entry.runId}`}
                            className="pl-3 pr-1 text-xs text-[var(--color-text-muted)]"
                            onClick={() =>
                              setExpandedRuns((s) => ({ ...s, [entry.runId]: !expanded }))
                            }
                          >
                            {expanded ? "▾" : "▸"}
                          </button>
                        ) : null}
                        <Link
                          to={`/openhands/native/conversations/${c.id}`}
                          className={`flex min-w-0 flex-1 items-center gap-3 py-3 pr-4 text-sm ${isManagerRow && entry.workers.length > 0 ? "pl-1" : "pl-4"}`}
                        >
                          <StatusPill status={c.execution_status} />
                          {entry.kind === "plain" && entry.role?.role === "worker" ? (
                            <span className="rounded-full bg-[var(--color-background-muted,rgba(127,127,127,0.12))] px-2 py-0.5 text-xs">
                              worker{entry.role.task ? ` · ${entry.role.task}` : ""}
                            </span>
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">{c.title || c.id}</span>
                          <WorkspaceModeBadge workingDir={c.workspace?.working_dir} compact />
                          {isManagerRow && entry.workers.length > 0 && (
                            <span className="text-xs text-[var(--color-text-muted)]">
                              {entry.workers.length} worker{entry.workers.length === 1 ? "" : "s"}
                            </span>
                          )}
                          {(conversationCost(c) ?? 0) > 0 && (
                            <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
                              {formatCost(conversationCost(c))}
                            </span>
                          )}
                          {isManagerRow ? (
                            <span
                              className="ml-auto rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-semibold text-cyan-800"
                              data-testid={`hub-manager-pill-${c.id}`}
                            >
                              MANAGER
                            </span>
                          ) : null}
                        </Link>
                      </div>
                      {isManagerRow && expanded && (
                        <ul data-testid={`hub-run-workers-${entry.runId}`}>
                          {entry.workers.map(({ item: w, task }) => (
                            <li key={w.id} className="border-t border-[var(--color-border-default)]">
                              <Link
                                to={`/openhands/native/conversations/${w.id}`}
                                className="flex items-center gap-3 py-2.5 pl-10 pr-4 text-sm hover:bg-[var(--color-background-element)]"
                              >
                                <StatusPill status={w.execution_status} />
                                <span className="rounded-full bg-[var(--color-background-muted,rgba(127,127,127,0.12))] px-2 py-0.5 text-xs">
                                  worker{task ? ` · ${task}` : ""}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{w.title || w.id}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
