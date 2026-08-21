// Markdown viewer for the Contributing section: renders a doc from the
// registry (client/lib/docs.ts) horizontally centered, under a banner that
// makes the source explicit — "this is a markdown file in the repo" with a
// link to its GitHub blob. Full-document markdown (GFM tables, fenced code)
// uses react-markdown per the guidance in ds/markdown.tsx; ```mermaid fences
// render client-side and degrade to their source text on parse errors.
import { useEffect, useId, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTheme } from "next-themes";
import { ArrowLeft, ExternalLink, FileCode2 } from "lucide-react";
import { Badge } from "../ds/badge.js";
import { DOCS, docByHref, docBySlug, loadDocSource, REPO_URL, type DocMeta } from "../lib/docs.js";

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
  if (!svg) return <div className="py-6 text-center text-xs text-[var(--color-text-subtle)]">Rendering diagram…</div>;
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

/** Links inside docs: registered .md targets navigate in-app; other
 * repo-relative paths point at the GitHub blob; external links open a tab. */
function DocLink({ href, children, docPath }: { href?: string; children?: React.ReactNode; docPath: string }) {
  if (!href) return <span>{children}</span>;
  if (href.startsWith("#")) return <a href={href}>{children}</a>;
  const target = docByHref(href);
  if (target) {
    return (
      <Link className="doc-link" to={`/openhands/contributing/${target.slug}`}>
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

export function DocPage() {
  const { slug = "" } = useParams();
  const meta = docBySlug(slug);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!meta) return;
    setSource(null);
    setError(false);
    loadDocSource(meta)
      .then(setSource)
      .catch(() => setError(true));
    window.scrollTo(0, 0);
  }, [meta]);

  if (!meta) return <Navigate to="/openhands/contributing" replace />;

  const idx = DOCS.findIndex((d) => d.slug === meta.slug);
  const prev = DOCS[idx - 1];
  const next = DOCS[idx + 1];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link
        to="/openhands/contributing"
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
        <p className="text-sm text-[var(--color-text-subtle)]">Loading…</p>
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
      <nav className="mt-10 flex justify-between gap-4 border-t border-[var(--color-border-default)] pt-4 text-sm">
        {prev ? (
          <Link className="doc-link" to={`/openhands/contributing/${prev.slug}`}>
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link className="doc-link text-right" to={`/openhands/contributing/${next.slug}`}>
            {next.title} →
          </Link>
        )}
      </nav>
    </div>
  );
}
