import { useEffect, useRef, useState } from "react";
import { Alert } from "../ds/alert.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { openHandsApi, type GitChange, type GitCommit, type GitDiff, type WorkspaceRepo } from "../lib/api.js";
import { buildDiff } from "../lib/diff.js";

const WRAP_STORAGE_KEY = "openhands.wrapDiff";

function statusLetter(status: string): string {
  return ({ ADDED: "A", DELETED: "D", UPDATED: "M", RENAMED: "R", UNTRACKED: "?" })[status] ?? status.slice(0, 1);
}

function DiffView({ diff, wrap }: { diff: GitDiff; wrap: boolean }) {
  const lines = buildDiff(diff.original, diff.modified);
  const lineClass = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto thin-scrollbar";
  if (lines.length === 0) return <p className="p-5 text-sm text-[var(--color-text-muted)]">No textual changes.</p>;
  return (
    <pre className={`thin-scrollbar min-h-full overflow-auto font-mono text-xs leading-5 ${lineClass}`} data-testid="openhands-diff">
      {lines.map((line, index) => (
        <div
          key={index}
          className={line.kind === "added" ? "bg-emerald-500/10 text-emerald-200" : line.kind === "removed" ? "bg-red-500/10 text-red-200" : line.kind === "hunk" ? "bg-[var(--color-background-muted,rgba(127,127,127,0.12))] text-[var(--color-text-muted)]" : ""}
        >
          <span className="inline-block w-12 select-none pr-2 text-right text-[var(--color-text-muted)]">{line.oldLine ?? ""}</span>
          <span className="inline-block w-12 select-none pr-2 text-right text-[var(--color-text-muted)]">{line.newLine ?? ""}</span>
          <span>{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

export function ChangesPage({ conversation, variant = "page" }: { conversation?: string; variant?: "page" | "sidebar" } = {}) {
  const [repos, setRepos] = useState<WorkspaceRepo[]>([]);
  const [repo, setRepo] = useState("");
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_STORAGE_KEY) !== "off");
  const commitRequest = useRef(0);

  useEffect(() => {
    let active = true;
    void openHandsApi.workspaceRepos(conversation)
      .then(({ items }) => {
        if (!active) return;
        setRepos(items);
        setRepo(items[0]?.path ?? "");
      })
      .catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [conversation]);

  useEffect(() => {
    if (!repo) return;
    let active = true;
    commitRequest.current += 1;
    setLoading(true);
    setError(null);
    setDiff(null);
    setSelectedFile(null);
    setSelectedCommit(null);
    void Promise.all([openHandsApi.changes(repo), openHandsApi.commits(repo)])
      .then(([nextChanges, commitPage]) => {
        if (!active) return;
        setChanges(nextChanges);
        setCommits(commitPage.commits);
        setSelectedFile(nextChanges[0]?.path ?? null);
      })
      .catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repo]);

  useEffect(() => {
    if (!repo || (!selectedFile && !selectedCommit)) return;
    let active = true;
    setLoading(true);
    void openHandsApi.diff(selectedFile ? `${repo}/${selectedFile}` : repo, selectedCommit ? { commit: selectedCommit.sha } : {})
      .then((nextDiff) => { if (active) setDiff(nextDiff); })
      .catch((cause: Error) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repo, selectedFile, selectedCommit]);

  const selectFile = (path: string) => {
    commitRequest.current += 1;
    setSelectedCommit(null);
    setSelectedFile(path);
  };
  const selectCommit = (commit: GitCommit) => {
    const request = ++commitRequest.current;
    setLoading(true);
    setError(null);
    setDiff(null);
    void openHandsApi.commitChanges(repo, commit.sha)
      .then((commitChanges) => {
        if (request !== commitRequest.current) return;
        setSelectedCommit(commit);
        setSelectedFile(commitChanges[0]?.path ?? null);
        if (commitChanges.length === 0) setDiff(null);
      })
      .catch((cause: Error) => { if (request === commitRequest.current) setError(cause.message); })
      .finally(() => { if (request === commitRequest.current) setLoading(false); });
  };
  const toggleWrap = () => setWrap((value) => {
    localStorage.setItem(WRAP_STORAGE_KEY, value ? "off" : "on");
    return !value;
  });

  if (variant === "sidebar") {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="openhands-changes-sidebar">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
          <select value={repo} onChange={(event) => setRepo(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-2 py-1 text-xs pointer-coarse:py-2 pointer-coarse:text-base" aria-label="Repository">
            {repos.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
          </select>
          <button onClick={toggleWrap} className={`shrink-0 rounded border px-2 py-1 text-[11px] pointer-coarse:px-3 pointer-coarse:py-2 ${wrap ? "border-[var(--color-border-focus)]" : "border-[var(--color-border-default)] text-[var(--color-text-muted)]"}`} aria-pressed={wrap}>
            Wrap
          </button>
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
          {error && <div className="px-3 pt-3"><Alert variant="danger">{error}</Alert></div>}
          {loading && !diff && <div className="p-3"><LoadingIndicator /></div>}
          {!loading && repos.length === 0 && <p className="p-3 text-xs text-[var(--color-text-muted)]">No git repositories found in this conversation's workspace.</p>}
          {repo && (
            <>
              <section className="border-b border-[var(--color-border-default)] p-2">
                <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Changed files</h2>
                {changes.length === 0 ? <p className="px-1 text-xs text-[var(--color-text-muted)]">Working tree is clean.</p> : changes.map((change) => (
                  <button key={change.path} onClick={() => selectFile(change.path)} className={`flex w-full gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] ${selectedFile === change.path ? "bg-[var(--color-background-muted,rgba(127,127,127,0.12))]" : ""}`}>
                    <span className="w-3 font-mono text-[var(--color-text-muted)]">{statusLetter(change.status)}</span><span className="min-w-0 break-all">{change.path}</span>
                  </button>
                ))}
              </section>
              {diff && (
                <section className="border-b border-[var(--color-border-default)]">
                  <div className="break-all px-3 py-2 text-[11px] text-[var(--color-text-muted)]">{selectedCommit ? `${selectedCommit.short_sha} ${selectedCommit.subject}` : selectedFile}</div>
                  <DiffView diff={diff} wrap={wrap} />
                </section>
              )}
              <section className="p-2">
                <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Recent commits</h2>
                {commits.map((commit) => (
                  <button key={commit.sha} onClick={() => selectCommit(commit)} className={`mb-1 w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] ${selectedCommit?.sha === commit.sha ? "bg-[var(--color-background-muted,rgba(127,127,127,0.12))]" : ""}`}>
                    <span className="font-mono text-[var(--color-text-muted)]">{commit.short_sha}</span><span className="ml-1">{commit.subject}</span>
                  </button>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    // Height always comes from the parent: the conversation shell when
    // embedded, and the routed `app-main` (flex-1 of the 100dvh shell column)
    // when standalone. The standalone branch used to guess with
    // `100vh - 2.25rem`; as a flex item it was shrunk back to the parent's
    // height anyway, so the constant only ever misled the next reader.
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[var(--color-border-default)] px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          {/* Full row on phones so the repo select wraps below instead of
              squeezing the title into a one-character-wide column. */}
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <h1 className="text-base font-semibold">Changes</h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              {conversation
                ? "Read-only git changes in this conversation's workspace directory."
                : "Read-only git changes across this single-tenant instance's session workspaces."}
            </p>
          </div>
          <select value={repo} onChange={(event) => setRepo(event.target.value)} className="max-w-xs rounded border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-2 py-1.5 text-sm pointer-coarse:text-base" aria-label="Repository">
            {repos.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
          </select>
          <button onClick={toggleWrap} className={`rounded border px-2 py-1 text-[11px] pointer-coarse:px-3 pointer-coarse:py-2 ${wrap ? "border-[var(--color-border-focus)]" : "border-[var(--color-border-default)] text-[var(--color-text-muted)]"}`} aria-pressed={wrap}>
            Wrap
          </button>
        </div>
      </header>
      {error && <div className="mx-auto w-full max-w-7xl px-6 pt-3"><Alert variant="danger">{error}</Alert></div>}
      {loading && !diff && <div className="p-6"><LoadingIndicator /></div>}
      {!loading && repos.length === 0 && <p className="p-6 text-sm text-[var(--color-text-muted)]">No git repositories found in the session workspaces.</p>}
      {repo && (
        // Below lg the three panels stack in one scroll column (files → diff →
        // commits, same order as the sidebar variant) — the fixed three-column
        // grid is unusable on phones (issue #28). At lg+ each column scrolls
        // independently inside the grid row.
        <main className="thin-scrollbar mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-y-auto border-x border-[var(--color-border-default)] lg:grid lg:grid-cols-[16rem_minmax(0,1fr)_16rem] lg:overflow-hidden">
          <section className="thin-scrollbar border-b border-[var(--color-border-default)] p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Changed files</h2>
            {changes.length === 0 ? <p className="text-xs text-[var(--color-text-muted)]">Working tree is clean.</p> : changes.map((change) => (
              <button key={change.path} onClick={() => selectFile(change.path)} className={`flex w-full gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] lg:py-1 ${selectedFile === change.path ? "bg-[var(--color-background-muted,rgba(127,127,127,0.12))]" : ""}`}>
                <span className="w-3 font-mono text-[var(--color-text-muted)]">{statusLetter(change.status)}</span><span className="min-w-0 break-all">{change.path}</span>
              </button>
            ))}
          </section>
          <section className="thin-scrollbar min-w-0 lg:overflow-auto">
            <div className="break-all border-b border-[var(--color-border-default)] px-4 py-2 text-xs text-[var(--color-text-muted)]">{selectedCommit ? `${selectedCommit.short_sha} ${selectedCommit.subject}` : selectedFile ?? "Select a file or commit"}</div>
            {diff && <DiffView diff={diff} wrap={wrap} />}
          </section>
          <section className="thin-scrollbar border-t border-[var(--color-border-default)] p-3 lg:overflow-y-auto lg:border-t-0 lg:border-l">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Recent commits</h2>
            {commits.map((commit) => (
              <button key={commit.sha} onClick={() => selectCommit(commit)} className={`mb-1 w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-background-muted,rgba(127,127,127,0.12))] ${selectedCommit?.sha === commit.sha ? "bg-[var(--color-background-muted,rgba(127,127,127,0.12))]" : ""}`}>
                <span className="font-mono text-[var(--color-text-muted)]">{commit.short_sha}</span><span className="ml-1">{commit.subject}</span>
              </button>
            ))}
          </section>
        </main>
      )}
    </div>
  );
}
