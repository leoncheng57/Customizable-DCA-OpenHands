// Read-only view across Agent Canvas session workspaces: directories from the
// agent-server's listing API, files per directory from the BFF's bounded find,
// and a click-to-open content viewer (plus the manual known-path input).
import { useEffect, useRef, useState } from "react";
import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { openHandsApi, type WorkspaceFile, type WorkspaceFileContent } from "../lib/api.js";

const WORKSPACE_ROOT = "/home/openhands/workspace";

function Breadcrumbs({ path, root, rootLabel, onNavigate }: { path: string; root: string; rootLabel: string; onNavigate: (path: string) => void }) {
  const segments = path.slice(root.length).split("/").filter(Boolean);
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs text-[var(--color-text-muted)]" aria-label="Workspace path">
      <button className="underline hover:text-[var(--color-text-default)]" onClick={() => onNavigate(root)}>{rootLabel}</button>
      {segments.map((segment, index) => {
        const target = `${root}/${segments.slice(0, index + 1).join("/")}`;
        return <span key={target}> / <button className="underline hover:text-[var(--color-text-default)]" onClick={() => onNavigate(target)}>{segment}</button></span>;
      })}
    </nav>
  );
}

export function FilesPage({ conversation, variant = "page" }: { conversation?: string; variant?: "page" | "sidebar" } = {}) {
  // Unscoped: the browsing root is the shared workspace root and is known up
  // front. Scoped: the root is the conversation's own working dir, which is
  // resolved server-side and learned from the first tree response.
  const [root, setRoot] = useState<string | null>(conversation ? null : WORKSPACE_ROOT);
  const [path, setPath] = useState<string | null>(conversation ? null : WORKSPACE_ROOT);
  const [directories, setDirectories] = useState<{ name: string; path: string }[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [nextPageId, setNextPageId] = useState<string | null>(null);
  const [filePath, setFilePath] = useState("");
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMoreRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Invalidate a pending pagination request before loading the new path.
    loadMoreRequest.current += 1;
    setLoadingMore(false);
    // Clear the previous directory's results immediately so a slow or failed
    // request never leaves stale entries visible under the new path.
    setDirectories([]);
    setFiles([]);
    setNextPageId(null);
    setError(null);
    setLoading(true);
    // A null path (scoped, first load) lets the server default to the
    // conversation root; the response tells us what that root is.
    void openHandsApi.tree(path ?? undefined, undefined, conversation)
      .then((tree) => {
        if (cancelled) return;
        setDirectories(tree.dirs);
        setFiles(tree.files ?? []);
        setNextPageId(tree.nextPageId);
        if (root === null) setRoot(tree.path);
        if (path === null) setPath(tree.path);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [path, conversation]);

  const loadMore = () => {
    if (!nextPageId || loadingMore || path === null) return;
    const request = ++loadMoreRequest.current;
    setLoadingMore(true);
    void openHandsApi.tree(path, nextPageId, conversation)
      .then((tree) => {
        if (request !== loadMoreRequest.current) return;
        setDirectories((prev) => [...prev, ...tree.dirs]);
        setNextPageId(tree.nextPageId);
        setError(null);
      })
      .catch((err: Error) => {
        if (request === loadMoreRequest.current) setError(err.message);
      })
      .finally(() => {
        if (request === loadMoreRequest.current) setLoadingMore(false);
      });
  };

  const loadFile = (target: string) => {
    if (!target || reading) return;
    setReading(true);
    // Clear any previously displayed file so a slow or failed load never
    // renders stale content under a different path.
    setFile(null);
    setError(null);
    void openHandsApi.fileContent(target, conversation)
      .then((content) => {
        setFile(content);
      })
      .catch((err: Error) => {
        setFile(null);
        setError(err.message);
      })
      .finally(() => setReading(false));
  };

  const openFile = () => loadFile(filePath.trim());

  const rootLabel = conversation ? "conversation" : "workspace";
  const compact = variant === "sidebar";

  return (
    <div className={compact ? "space-y-4 px-3 py-3" : "mx-auto max-w-3xl space-y-6 px-6 py-8"}>
      <header>
        {!compact && <h1 className="text-xl font-semibold">{conversation ? "Conversation files" : "Workspace files"}</h1>}
        {!compact && (
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {conversation
              ? "Read-only access to this conversation's workspace directory."
              : "Read-only access across this single-tenant instance's session workspaces."}
          </p>
        )}
        {root && (
          <p className="mt-1 break-all font-mono text-xs text-[var(--color-text-muted)]" data-testid="openhands-files-scope">
            Scope: {root}
          </p>
        )}
      </header>
      {error && <Alert variant="danger">{error}</Alert>}
      <section className={`space-y-3 rounded-lg border border-[var(--color-border-default)] ${compact ? "p-2" : "p-4"}`}>
        {root && path ? <Breadcrumbs path={path} root={root} rootLabel={rootLabel} onNavigate={setPath} /> : null}
        {loading || !path ? <LoadingIndicator /> : (
          <div className="divide-y divide-[var(--color-border-default)]">
            {directories.map((directory) => (
              <button key={directory.path} onClick={() => setPath(directory.path)} className="flex w-full items-center gap-2 py-2 text-left text-sm hover:text-[var(--color-text-link)]">
                <span aria-hidden>DIR</span><span>{directory.name}</span>
              </button>
            ))}
            {directories.length === 0 && <p className="py-4 text-sm text-[var(--color-text-muted)]">No subdirectories.</p>}
            {files.map((f) => (
              <button
                key={f.path}
                data-testid="openhands-file-row"
                onClick={() => {
                  setFilePath(f.path);
                  loadFile(f.path);
                }}
                className="flex w-full items-center gap-2 py-2 text-left text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-link)]"
              >
                <span aria-hidden className="font-mono text-[10px]">FILE</span>
                <span>{f.name}</span>
              </button>
            ))}
          </div>
        )}
        {!loading && nextPageId && (
          <Button variant="secondary" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading..." : "Load more"}
          </Button>
        )}
        <p className="text-xs text-[var(--color-text-muted)]">Click a file to open it, or open a known file path below.</p>
      </section>
      <section className="space-y-3">
        <div className="flex gap-2">
          <input value={filePath} onChange={(event) => setFilePath(event.target.value)} onKeyDown={(event) => event.key === "Enter" && openFile()} placeholder={path ? `${path}/README.md` : "README.md"} className="min-w-0 flex-1 rounded border border-[var(--color-border-default)] bg-transparent px-3 py-2 font-mono text-sm pointer-coarse:text-base" aria-label="File path" />
          <Button disabled={reading || !filePath.trim()} onClick={openFile}>{reading ? "Opening..." : "Open file"}</Button>
        </div>
        {file && (
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
            <div className="border-b border-[var(--color-border-default)] px-3 py-2 font-mono text-xs text-[var(--color-text-muted)]">{file.path}</div>
            <pre className="thin-scrollbar max-h-[60vh] overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap break-words"><code>{file.content}</code></pre>
          </div>
        )}
      </section>
    </div>
  );
}
