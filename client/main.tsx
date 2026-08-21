// Standalone shell replacing the original platform's registerApp(): same
// /openhands/* URL space (pages hard-link into it, and the BFF's
// MR-traceability lines point at /openhands/native/conversations/<id>),
// minimal top nav instead of the platform sidebar.
import React, { StrictMode, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ThemeProvider, useTheme } from "next-themes";
import { Bell, BookOpen, MessagesSquare, SlidersHorizontal, SquareTerminal, Workflow, Wrench } from "lucide-react";
import { useNotifyWatcher } from "./lib/useNotifyWatcher.js";
import { setPageTabTitle } from "./lib/tabMeta.js";
import { useVisualViewportVar } from "./lib/viewport.js";
import { openHandsApi, type ConversationSummary } from "./lib/api.js";
import { DOCS } from "./lib/docs.js";
import { buildCommands, rankCommands, type Command } from "./lib/palette.js";
import { CommandPalette } from "./ds/command-palette.js";
import { DemoBanner } from "./components/DemoBanner.js";
import { installMockBackend } from "./mock/install.js";
import "./styles.css";

// GitHub Pages build (VITE_DEMO=1): there is no BFF, so client/mock/ answers
// every /api/openhands request instead.
//
// vite.config.ts substitutes this as a boolean LITERAL — assign it straight
// through, no Boolean() wrapper, or Rollup can no longer fold the branches
// below and the self-hosted build ships the demo backend it never uses.
const DEMO: boolean = import.meta.env.VITE_DEMO;
// Synchronous, before any component mounts: window.fetch has to be patched by
// the time the first page effect fires.
if (DEMO) installMockBackend();

const LandingPage = React.lazy(() => import("./pages/Landing.js").then((m) => ({ default: m.LandingPage })));
const HubPage = React.lazy(() => import("./pages/Hub.js").then((m) => ({ default: m.HubPage })));
const ConversationPage = React.lazy(() => import("./pages/Conversation.js").then((m) => ({ default: m.ConversationPage })));
const FilesPage = React.lazy(() => import("./pages/Files.js").then((m) => ({ default: m.FilesPage })));
const ChangesPage = React.lazy(() => import("./pages/Changes.js").then((m) => ({ default: m.ChangesPage })));
const TerminalPage = React.lazy(() => import("./pages/Terminal.js").then((m) => ({ default: m.TerminalPage })));
const ManagerRunsPage = React.lazy(() => import("./pages/ManagerRuns.js").then((m) => ({ default: m.ManagerRunsPage })));
const ManagerRunBoardPage = React.lazy(() => import("./pages/ManagerRunBoard.js").then((m) => ({ default: m.ManagerRunBoardPage })));
const ManagerGuidePage = React.lazy(() => import("./pages/ManagerGuide.js").then((m) => ({ default: m.ManagerGuidePage })));
const NotificationsPage = React.lazy(() => import("./pages/Notifications.js").then((m) => ({ default: m.NotificationsPage })));
const AgentSettingsPage = React.lazy(() => import("./pages/AgentSettings.js").then((m) => ({ default: m.AgentSettingsPage })));
const ToolsPage = React.lazy(() => import("./pages/Tools.js").then((m) => ({ default: m.ToolsPage })));
const ContributingPage = React.lazy(() => import("./pages/Contributing.js").then((m) => ({ default: m.ContributingPage })));
const DocPage = React.lazy(() => import("./pages/DocPage.js").then((m) => ({ default: m.DocPage })));

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <button
      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-subtle)] pointer-coarse:h-10 pointer-coarse:w-10 hover:bg-[var(--hh-row-hover)] hover:text-[var(--color-text-default)]"
      onClick={() => setTheme(dark ? "light" : "dark")}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {dark ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  );
}

/** Terminal-prompt glyph — the app's logo motif (a local coding agent). */
function LogoMark() {
  return (
    <span className="app-logo-mark flex h-7 w-7 items-center justify-center rounded-lg text-white">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m5 7 5 5-5 5" />
        <line x1="13" y1="17" x2="19" y2="17" />
      </svg>
    </span>
  );
}

const NAV = [
  { to: "/openhands/native", label: "Conversations", icon: MessagesSquare },
  { to: "/openhands/runs", label: "Manager runs", icon: Workflow },
  { to: "/openhands/terminal", label: "Terminal", icon: SquareTerminal },
  { to: "/openhands/notifications", label: "Notifications", icon: Bell },
  { to: "/openhands/agent-settings", label: "Agent settings", icon: SlidersHorizontal },
  { to: "/openhands/tools", label: "Tools", icon: Wrench },
  { to: "/openhands/contributing", label: "Contributing", icon: BookOpen },
];

/** Static tab-title labels for non-conversation routes (longest prefix wins).
 * Hub and conversation pages are absent: the hub uses the default title and
 * the Conversation page owns its tab meta itself. */
const PAGE_TAB_TITLES: Array<[prefix: string, label: string]> = [
  ["/openhands/overview", "Overview"],
  ["/openhands/runs", "Manager runs"],
  ["/openhands/files", "Files"],
  ["/openhands/changes", "Changes"],
  ["/openhands/terminal", "Terminal"],
  ["/openhands/manager-guide", "Manager guide"],
  ["/openhands/notifications", "Notifications"],
  ["/openhands/agent-settings", "Agent settings"],
  ["/openhands/tools", "Tools"],
  ["/openhands/contributing", "Contributing"],
];

/**
 * Cmd/Ctrl+K command palette host: owns the open/query state, the global
 * hotkey, and the on-open conversation fetch.
 *
 * Rendered by `Shell` rather than inlined into it so that typing in the
 * palette re-renders only this subtree — `Shell` re-rendering per keystroke
 * would also re-render the navbar for nothing.
 *
 * The conversation list is fetched *on open*, never polled: the hub and
 * `useNotifyWatcher` already run 10s pollers against the same endpoint and a
 * third one would triple the background load for a list nobody is looking at.
 */
function CommandPaletteHost() {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== "k" && e.key !== "K")) return;
      // Chrome/Firefox bind Cmd+K to the address bar's search shortcut.
      e.preventDefault();
      setQuery("");
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    openHandsApi
      .list()
      .then((r) => {
        if (!cancelled) setConversations(r.items);
      })
      // A palette that half-works (nav + docs) beats one that errors out, so
      // a failed fetch just leaves the conversation section empty.
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const commands = useMemo(
    () =>
      buildCommands({
        nav: NAV.map(({ to, label }) => ({ to, label })),
        docs: DOCS,
        conversations: conversations ?? [],
        theme: resolvedTheme === "dark" ? "dark" : "light",
        onToggleTheme: toggleTheme,
      }),
    [conversations, resolvedTheme, toggleTheme],
  );
  const results = useMemo(() => rankCommands(commands, query), [commands, query]);

  const onSelect = useCallback(
    (command: Command) => {
      setOpen(false);
      if (command.run) command.run();
      else if (command.to) navigate(command.to);
    },
    [navigate],
  );

  return (
    <CommandPalette
      open={open}
      onClose={() => setOpen(false)}
      commands={results}
      query={query}
      onQueryChange={setQuery}
      onSelect={onSelect}
      status={conversations === null ? "Loading conversations…" : undefined}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  // Browser notification channels (chime + desktop) — fire on conversation
  // transitions while any app tab is open (see /openhands/notifications).
  useNotifyWatcher();
  // Publishes --app-vvh for the shell height above (no-op on fine-pointer
  // devices, where a shrinking visual viewport means pinch-zoom, not a
  // keyboard).
  useVisualViewportVar();
  useEffect(() => {
    setPageTabTitle(PAGE_TAB_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? null);
  }, [pathname]);
  return (
    // Viewport-tall flex column: the nav is a fixed-height band and the routed
    // page owns the remaining space (min-h-0 so a page can contain its own
    // scrollers instead of growing the document). 100dvh — not 100vh — so
    // mobile browser chrome never pushes the bottom of a page off-screen.
    //
    // `--app-vvh` (coarse pointers only, see useVisualViewportVar) narrows
    // that further to the VISUAL viewport: dvh follows the collapsing URL bar
    // but not the software keyboard, which on iOS leaves the layout viewport
    // full-size and hides the composer behind the keys. Publishing it here
    // rather than per-page means every routed page inherits the correction.
    <div className="flex h-[var(--app-vvh,100dvh)] min-h-0 flex-col overflow-hidden text-[var(--color-text-default)]">
      {/* First child, not position:fixed — the disclosure strip shares the
          column with the nav band, so it can never overlap it. */}
      {DEMO && <DemoBanner />}
      {/* Floating glass island nav: detached from the top edge, brand left,
          segmented icon+label items in a recessed track, toggle right. */}
      <div className="sticky top-0 z-40 shrink-0 px-3 pt-3 pb-1">
        <header className="app-navbar mx-auto flex max-w-5xl items-center gap-2 rounded-2xl py-1.5 pl-3 pr-2">
          <Link to="/openhands/native" className="flex items-center gap-2.5 pr-1" aria-label="Home">
            <LogoMark />
            <span className="hidden text-[13px] font-bold tracking-tight text-[var(--color-text-default)] sm:block">
              Customizable<span className="ml-1 font-normal text-[var(--color-text-muted)]">DCA</span>
            </span>
          </Link>
          {/* min-w-0 + overflow-x lets the nav pills scroll on phones instead
              of blowing out the island header. */}
          <nav className="app-nav-track ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto sm:ml-4">
            {NAV.map((item) => {
              const ItemIcon = item.icon;
              return (
                <Link key={item.to} to={item.to} className="app-nav-item" data-active={pathname.startsWith(item.to)}>
                  <ItemIcon size={14} strokeWidth={2.2} aria-hidden />
                  <span className="hidden md:block">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto sm:ml-2">
            <ThemeToggle />
          </div>
        </header>
      </div>
      {/* No width cap here: panel-heavy pages (conversation transcript +
          sidebar) span the full viewport; centered pages (hub) constrain
          themselves with their own mx-auto max-w-*. This element is the
          document-level scroller for ordinary pages; pages that pin a footer
          (conversation) take h-full and scroll their own inner region. */}
      <main className="thin-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="app-main">
        <Suspense fallback={<div className="p-8 text-sm text-[var(--color-text-subtle)]">Loading…</div>}>
          {children}
        </Suspense>
      </main>
      <CommandPaletteHost />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Shell>
          <Routes>
            {/* The hub (conversations + project-folder grid) IS the homepage. */}
            <Route path="/" element={<Navigate to="/openhands/native" replace />} />
            <Route path="/openhands" element={<Navigate to="/openhands/native" replace />} />
            <Route path="/openhands/overview" element={<LandingPage />} />
            <Route path="/openhands/native" element={<HubPage />} />
            <Route path="/openhands/native/conversations/:id" element={<ConversationPage />} />
            <Route path="/openhands/native/conversations/:id/files" element={<ConversationPage tab="files" />} />
            <Route path="/openhands/native/conversations/:id/changes" element={<ConversationPage tab="changes" />} />
            <Route path="/openhands/native/conversations/:id/preview" element={<ConversationPage tab="preview" />} />
            <Route path="/openhands/native/conversations/:id/run" element={<ConversationPage tab="run" />} />
            <Route path="/openhands/runs" element={<ManagerRunsPage />} />
            <Route path="/openhands/runs/:id" element={<ManagerRunBoardPage />} />
            <Route path="/openhands/files" element={<FilesPage />} />
            <Route path="/openhands/changes" element={<ChangesPage />} />
            <Route path="/openhands/terminal" element={<TerminalPage />} />
            <Route path="/openhands/manager-guide" element={<ManagerGuidePage />} />
            <Route path="/openhands/notifications" element={<NotificationsPage />} />
            <Route path="/openhands/agent-settings" element={<AgentSettingsPage />} />
            <Route path="/openhands/tools" element={<ToolsPage />} />
            <Route path="/openhands/contributing" element={<ContributingPage />} />
            <Route path="/openhands/contributing/:slug" element={<DocPage />} />
            {/* Pre-rename muscle memory / old links. The Self-development
                page's content now lives in docs/agent-sessions.md. */}
            <Route path="/openhands/about" element={<Navigate to="/openhands/contributing" replace />} />
            <Route
              path="/openhands/about/self-development"
              element={<Navigate to="/openhands/contributing/agent-sessions" replace />}
            />
            <Route path="*" element={<Navigate to="/openhands" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
