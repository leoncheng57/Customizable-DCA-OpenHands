// Read-only view of the shared Agent Canvas bash-event stream. This page never
// exposes a command input or any endpoint that can change the shared workspace.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { openHandsApi, type TerminalCommand, type TerminalOutput } from "../lib/api.js";

const POLL_MS = 5_000;
const MAX_OUTPUT_CHARS = 256 * 1024;

function displayTime(timestamp?: string): string {
  if (!timestamp) return "Unknown time";
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? timestamp : date.toLocaleString();
}

function outputText(output: TerminalOutput): string {
  return [output.stdout, output.stderr].filter((value): value is string => Boolean(value)).join("");
}

function capOutputs(items: TerminalOutput[], remaining: number): { items: TerminalOutput[]; chars: number; truncated: boolean } {
  let chars = 0;
  let truncated = false;
  const take = (value: string | null | undefined): string | null | undefined => {
    if (value == null) return value;
    const available = Math.max(0, remaining - chars);
    if (value.length > available) truncated = true;
    const result = value.slice(0, available);
    chars += result.length;
    return result;
  };
  return {
    items: items.map((item) => ({ ...item, stdout: take(item.stdout), stderr: take(item.stderr) })),
    chars,
    truncated,
  };
}

function OutputBlock({ command }: { command: TerminalCommand }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<TerminalOutput[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastOrder = useRef(-1);
  const displayedChars = useRef(0);
  const outputIds = useRef(new Set<string | undefined>());

  const load = useCallback(async (onlyNew = false) => {
    try {
      const result = await openHandsApi.terminalOutput(command.id, onlyNew && lastOrder.current >= 0 ? lastOrder.current : undefined);
      lastOrder.current = result.items.reduce((latest, item) => Math.max(latest, item.order ?? -1), lastOrder.current);
      if (!onlyNew) {
        displayedChars.current = 0;
        outputIds.current.clear();
      }
      const newItems = onlyNew ? result.items.filter((item) => !outputIds.current.has(item.id)) : result.items;
      const capped = capOutputs(newItems, MAX_OUTPUT_CHARS - displayedChars.current);
      displayedChars.current += capped.chars;
      for (const item of newItems) outputIds.current.add(item.id);
      setItems((current) => {
        if (!onlyNew) return capped.items;
        return [...current, ...capped.items];
      });
      setTruncated(onlyNew
        ? (current) => current || result.truncated || capped.truncated
        : result.truncated || capped.truncated);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [command.id]);

  useEffect(() => {
    if (!expanded) return;
    void load();
  }, [expanded, load]);

  const latestExit = [...items].reverse().find((item) => item.exit_code !== null && item.exit_code !== undefined)?.exit_code;

  useEffect(() => {
    if (!expanded) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!document.hidden && !interval) interval = setInterval(() => void load(true), POLL_MS);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
      interval = undefined;
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else {
        void load(true);
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [expanded, load]);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="text-xs text-[var(--color-text-muted)] underline hover:text-[var(--color-text-default)]"
        aria-expanded={expanded}
      >
        {expanded ? "Hide output" : "Show output"}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {error && <Alert variant="danger">{error}</Alert>}
          {items.length === 0 && !error ? (
            <p className="text-xs text-[var(--color-text-muted)]">No output yet.</p>
          ) : (
            <pre className="thin-scrollbar max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-background-muted,rgba(127,127,127,0.08))] p-3 font-mono text-xs leading-relaxed">
              <code>{items.map(outputText).join("") || "(no output)"}</code>
            </pre>
          )}
          {truncated && <p className="text-xs text-[var(--color-text-muted)]">Output was truncated at 256 KB.</p>}
          {latestExit !== undefined && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Exit code: {latestExit}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CommandRow({ command }: { command: TerminalCommand }) {
  const exitCode = command.exit_code;
  return (
    <li className="border-b border-[var(--color-border-default)] px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-muted)]">
        <time dateTime={command.timestamp}>{displayTime(command.timestamp)}</time>
        {exitCode !== null && (
          <span className={exitCode === 0 ? "text-[var(--color-text-success)]" : "text-[var(--color-text-critical)]"}>
            exit {exitCode}
          </span>
        )}
        {command.cwd && <span className="truncate" title={command.cwd}>{command.cwd}</span>}
      </div>
      <pre className="thin-scrollbar mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-background-muted,rgba(127,127,127,0.08))] p-3 font-mono text-xs leading-relaxed">
        <code>{command.command}</code>
      </pre>
      <OutputBlock command={command} />
    </li>
  );
}

export function TerminalPage() {
  const [commands, setCommands] = useState<TerminalCommand[] | null>(null);
  const [nextPageId, setNextPageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (pageId?: string) => {
    try {
      const result = await openHandsApi.terminalCommands(pageId);
      setCommands((current) => pageId ? [...(current ?? []), ...result.items] : result.items);
      setNextPageId(result.next_page_id);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!document.hidden && !interval) interval = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
      interval = undefined;
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else {
        void load();
        start();
      }
    };
    if (!document.hidden) void load();
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  const loadMore = async () => {
    if (!nextPageId || loadingMore) return;
    setLoadingMore(true);
    await load(nextPageId);
    setLoadingMore(false);
  };

  if (commands === null && !error) return <div className="p-6"><LoadingIndicator /></div>;

  return (
    <main className="mx-auto max-w-3xl space-y-5 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Terminal</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">Shared instance bash history, newest command first.</p>
      </header>
      <Alert variant="warning">Read-only view of the shared OpenHands instance. Commands cannot be run from this page.</Alert>
      {error && <Alert variant="danger">{error}</Alert>}
      {commands?.length === 0 ? (
        <p className="py-12 text-center text-sm text-[var(--color-text-muted)]">No terminal commands found.</p>
      ) : (
        <ul className="rounded-lg border border-[var(--color-border-default)]">
          {commands?.map((command) => <CommandRow key={command.id} command={command} />)}
        </ul>
      )}
      {nextPageId && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </main>
  );
}
