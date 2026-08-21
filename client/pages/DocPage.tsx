// Markdown viewer for the Contributing section: renders a doc from the
// registry (client/lib/docs.ts) horizontally centered, under a banner that
// makes the source explicit — "this is a markdown file in the repo" with a
// link to its GitHub blob. Full-document markdown (GFM tables, fenced code)
// uses react-markdown per the guidance in ds/markdown.tsx; ```mermaid fences
// render client-side and degrade to their source text on parse errors.
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTheme } from "next-themes";
import { ArrowLeft, ExternalLink, FileCode2 } from "lucide-react";
import { Badge } from "../ds/badge.js";
import {
  DOCS,
  docByHref,
  docBySlug,
  docRoute,
  loadDocSource,
  REPO_URL,
  slugifyHeading,
  type DocMeta,
} from "../lib/docs.js";
import { highlight, languageFromClassName } from "../lib/highlight.js";

function MermaidBlock({ chart }: { chart: string }) {
  const { resolvedTheme } = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(`mmd-${id}-${Date.now()}`, chart);
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, resolvedTheme, id]);
  if (failed) {
    // Broken diagram ≠ broken page: show the source so the doc stays useful.
    return <pre className="doc-code">{chart}</pre>;
  }
  if (!svg) return <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">Rendering diagram…</div>;
  return (
    <div
      className="doc-mermaid my-4 flex justify-center overflow-x-auto"
      data-testid="doc-mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Split markdown into text/mermaid segments so mermaid renders as a
 * component without fighting react-markdown's pre/code internals. */
function splitMermaid(md: string): { kind: "md" | "mermaid"; body: string }[] {
  const segments: { kind: "md" | "mermaid"; body: string }[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (m.index > last) segments.push({ kind: "md", body: md.slice(last, m.index) });
    segments.push({ kind: "mermaid", body: m[1] });
    last = re.lastIndex;
  }
  if (last < md.length) segments.push({ kind: "md", body: md.slice(last) });
  return segments;
}

/** Flatten a react-markdown children tree to its text, so a heading can be
 * slugified the way GitHub slugifies the markdown source it came from
 * (`## The primitives (\`client/ds/\`)` → "the-primitives-clientds"). */
function nodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return "";
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** Heading with a GitHub-compatible `id` plus the hover permalink GitHub
 * itself renders. Without the id every `](#section)` link in the corpus is a
 * no-op — several docs cross-reference their own sections.
 *
 * The permalink is `aria-hidden` + untabbable (same as GitHub's) so it stays
 * out of the heading's accessible name; e2e specs match headings by role+name. */
function DocHeading({ tag: Tag, children }: { tag: HeadingTag; children?: React.ReactNode }) {
  const text = nodeText(children);
  const id = slugifyHeading(text);
  if (!id) return <Tag>{children}</Tag>;
  return (
    <Tag id={id} className="doc-heading">
      {children}
      <a className="doc-heading-anchor" href={`#${id}`} aria-hidden="true" tabIndex={-1}>
        #
      </a>
    </Tag>
  );
}

/** Fenced code, tokenised in-process (client/lib/highlight.ts). Unknown or
 * deliberately-plain languages (`text`, no infostring) fall through to the
 * raw string, so ASCII trees and program output stay uncoloured. */
function DocCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = languageFromClassName(className);
  const raw = nodeText(children);
  const tokens = useMemo(() => (raw ? highlight(raw, lang) : null), [raw, lang]);
  // Inline code (no infostring, no newline) keeps its plain rendering.
  if (!tokens) return <code className={className}>{children}</code>;
  return (
    <code className={className} data-lang={lang}>
      {tokens.map((t, i) =>
        t.kind === "plain" ? (
          <Fragment key={i}>{t.text}</Fragment>
        ) : (
          <span key={i} className={`tok-${t.kind}`}>
            {t.text}
          </span>
        ),
      )}
    </code>
  );
}

/** Links inside docs: registered .md targets navigate in-app; other
 * repo-relative paths point at the GitHub blob; external links open a tab. */
function DocLink({ href, children, docPath }: { href?: string; children?: React.ReactNode; docPath: string }) {
  if (!href) return <span>{children}</span>;
  if (href.startsWith("#")) {
    return (
      <a className="doc-link" href={href}>
        {children}
      </a>
    );
  }
  const target = docByHref(href);
  if (target) {
    // Keep the fragment: `cicd.md#releases` should land on that section, not
    // just the top of cicd.
    const hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
    return (
      <Link className="doc-link" to={docRoute(target.slug, hash)}>
        {children}
      </Link>
    );
  }
  if (/^https?:\/\//.test(href)) {
    return (
      <a className="doc-link" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  // Repo-relative non-doc file (e.g. ../.github/risk-map.yml) → GitHub blob.
  const base = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  const joined = new URL(href, `https://x/${base ? `${base}/` : ""}`).pathname.replace(/^\//, "");
  return (
    <a className="doc-link" href={`${REPO_URL}/blob/main/${joined}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function MarkdownBody({ source, docPath }: { source: string; docPath: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <DocLink href={href} docPath={docPath}>
            {children}
          </DocLink>
        ),
        pre: ({ children }) => <pre className="doc-code">{children}</pre>,
        code: ({ className, children }) => <DocCode className={className}>{children}</DocCode>,
        h1: ({ children }) => <DocHeading tag="h1">{children}</DocHeading>,
        h2: ({ children }) => <DocHeading tag="h2">{children}</DocHeading>,
        h3: ({ children }) => <DocHeading tag="h3">{children}</DocHeading>,
        h4: ({ children }) => <DocHeading tag="h4">{children}</DocHeading>,
        h5: ({ children }) => <DocHeading tag="h5">{children}</DocHeading>,
        h6: ({ children }) => <DocHeading tag="h6">{children}</DocHeading>,
      }}
    >
      {source}
    </ReactMarkdown>
  );
}

/** The "this is a markdown file" banner: mono badge, repo path, GitHub link. */
function SourceBanner({ meta }: { meta: DocMeta }) {
  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-4 py-2.5"
      data-testid="doc-banner"
    >
      <span className="flex items-center gap-1.5 rounded-md bg-[var(--color-background-surface-info-muted)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-info)]">
        <FileCode2 size={12} aria-hidden /> Markdown
      </span>
      <code className="text-xs text-[var(--color-text-muted)]">{meta.path}</code>
      {meta.status === "beta" && (
        <Badge variant="beta" data-testid="doc-status-badge" title="This feature works but has known gaps — see the beta notice below.">
          beta
        </Badge>
      )}
      <a
        className="ml-auto flex items-center gap-1 text-xs underline hover:opacity-80"
        href={`${REPO_URL}/blob/main/${meta.path}`}
        target="_blank"
        rel="noreferrer"
        data-testid="doc-github-link"
      >
        View on GitHub <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}

/** Reader input that should cancel automatic re-alignment. */
const INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** Nearest scrolling ancestor. Ordinary pages scroll inside `<main>` in the
 * app shell, not the window, so `window.scrollTo` alone is a no-op here. */
function scroller(from: HTMLElement | null): HTMLElement | null {
  for (let el = from?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (/(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

export function DocPage() {
  const { slug = "" } = useParams();
  const { hash } = useLocation();
  const meta = docBySlug(slug);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!meta) return;
    setSource(null);
    setError(false);
    loadDocSource(meta)
      .then(setSource)
      .catch(() => setError(true));
  }, [meta]);

  /** Land the reader in the right place once the markdown has rendered.
   *
   * A `#fragment` can't be left to the browser: it arrives before the doc
   * source has been swapped in, so the heading it names does not exist yet.
   * That covers both a pasted deep link and an in-corpus cross-doc link like
   * `cicd.md#releases`.
   *
   * Aligning once isn't enough either — ```mermaid fences resolve
   * asynchronously and can add several hundred pixels ABOVE the anchor after
   * the first scroll, leaving the reader stranded mid-document. So re-align
   * whenever the article resizes, until it settles, and yield the moment the
   * reader touches the page. */
  useEffect(() => {
    if (source === null) return;
    const container = scroller(rootRef.current);
    const targetId = hash ? decodeURIComponent(hash.slice(1)) : "";

    if (!targetId) {
      // New doc, no fragment: start at the top. `window.scrollTo` alone is a
      // no-op here — ordinary pages scroll inside <main>, not the document.
      container?.scrollTo({ top: 0 });
      window.scrollTo(0, 0);
      return;
    }

    const align = () => document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    align();

    const article = rootRef.current?.querySelector<HTMLElement>('[data-testid="doc-body"]');
    const observer = new ResizeObserver(align);
    if (article) observer.observe(article);
    // Any deliberate input hands control back immediately; the timeout caps
    // the window in case a diagram never settles.
    const release = () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const type of INPUT_EVENTS) window.removeEventListener(type, release);
    };
    const timer = setTimeout(release, 2500);
    for (const type of INPUT_EVENTS) window.addEventListener(type, release, { passive: true });
    return release;
  }, [source, hash]);

  if (!meta) return <Navigate to={docRoute()} replace />;

  const idx = DOCS.findIndex((d) => d.slug === meta.slug);
  const prev = DOCS[idx - 1];
  const next = DOCS[idx + 1];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8" ref={rootRef}>
      <Link
        to={docRoute()}
        className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
      >
        <ArrowLeft size={13} aria-hidden /> Contributing
      </Link>
      <SourceBanner meta={meta} />
      {error && (
        <p className="text-sm text-[var(--color-text-danger,red)]">
          Failed to load this doc. It is always readable on{" "}
          <a className="underline" href={`${REPO_URL}/blob/main/${meta.path}`} target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      )}
      {source === null && !error && (
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      )}
      {source !== null && (
        <article className="doc-prose" data-testid="doc-body">
          {splitMermaid(source).map((seg, i) =>
            seg.kind === "mermaid" ? (
              <MermaidBlock key={i} chart={seg.body} />
            ) : (
              <MarkdownBody key={i} source={seg.body} docPath={meta.path} />
            ),
          )}
        </article>
      )}
      <nav
        className="mt-10 flex justify-between gap-4 border-t border-[var(--color-border-default)] pt-4 text-sm"
        aria-label="Previous and next document"
      >
        {prev ? (
          <Link className="doc-link doc-nav-link" to={docRoute(prev.slug)} rel="prev">
            <span aria-hidden>←</span> {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link className="doc-link doc-nav-link text-right" to={docRoute(next.slug)} rel="next">
            {next.title} <span aria-hidden>→</span>
          </Link>
        )}
      </nav>
    </div>
  );
}
