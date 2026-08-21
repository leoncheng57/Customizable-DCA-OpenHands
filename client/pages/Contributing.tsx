// Contributing section index (replaces the old About page). Docs are
// markdown-canonical (CONTRIBUTING.md + docs/*.md — see client/lib/docs.ts);
// this page is the curated entrance: an interactive React Flow system map
// whose nodes deep-link into the relevant doc, then the doc card grid.
// Diagram media are deliberately hybrid (decision #13): ASCII + mermaid live
// in the markdown, the one animated/interactive map lives here.
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "next-themes";
import { ExternalLink } from "lucide-react";
import { Badge } from "../ds/badge.js";
import { CATEGORY_LABELS, DOCS, REPO_URL, type DocCategory } from "../lib/docs.js";

interface MapNodeData extends Record<string, unknown> {
  title: string;
  sub: string;
  slug: string;
  tone: string;
  delay: number;
}

function MapNode({ data }: NodeProps<Node<MapNodeData>>) {
  const navigate = useNavigate();
  return (
    <motion.button
      initial={{ opacity: 0, y: 10, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: data.delay, duration: 0.35, ease: "easeOut" }}
      whileHover={{ scale: 1.06, y: -2 }}
      whileTap={{ scale: 0.97 }}
      onClick={() => navigate(`/openhands/contributing/${data.slug}`)}
      className={`w-44 cursor-pointer rounded-xl border px-3 py-2 text-left shadow-sm ${data.tone}`}
      title={`Open the ${data.title} doc`}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0" />
      <div className="text-xs font-semibold">{data.title}</div>
      <div className="mt-0.5 text-[10px] leading-snug text-[var(--color-text-muted)]">{data.sub}</div>
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0" />
    </motion.button>
  );
}

const NODE_TYPES = { map: MapNode };

function SystemMap() {
  const { resolvedTheme } = useTheme();
  const nodes: Node<MapNodeData>[] = useMemo(
    () => [
      {
        id: "client",
        type: "map",
        position: { x: 0, y: 60 },
        data: {
          title: "React SPA",
          sub: "client/ — pages, DS, Tailwind v4",
          slug: "design-system",
          tone: "border-cyan-500/60 bg-cyan-500/10",
          delay: 0,
        },
      },
      {
        id: "bff",
        type: "map",
        position: { x: 230, y: 60 },
        data: {
          title: "Express BFF",
          sub: "server/ — SSE, files, proxy, tokens",
          slug: "architecture",
          tone: "border-emerald-600/60 bg-emerald-600/10",
          delay: 0.1,
        },
      },
      {
        id: "agent",
        type: "map",
        position: { x: 470, y: 20 },
        data: {
          title: "agent-canvas",
          sub: "OpenHands agent-server :8010, headless",
          slug: "openhands",
          tone: "border-violet-500/60 bg-violet-500/10",
          delay: 0.2,
        },
      },
      {
        id: "pg",
        type: "map",
        position: { x: 470, y: 130 },
        data: {
          title: "Postgres",
          sub: "manager runs only (PGHOST-gated)",
          slug: "architecture",
          tone: "border-sky-500/60 bg-sky-500/10",
          delay: 0.3,
        },
      },
      {
        id: "ws",
        type: "map",
        position: { x: 700, y: 20 },
        data: {
          title: "Workspaces",
          sub: "local/<dir> bind mount · sessions/<uuid>",
          slug: "agent-sessions",
          tone: "border-amber-500/60 bg-amber-500/10",
          delay: 0.4,
        },
      },
      {
        id: "forge",
        type: "map",
        position: { x: 230, y: 170 },
        data: {
          title: "GitHub / GitLab",
          sub: "clone, push, MR panel, CI",
          slug: "cicd",
          tone: "border-rose-500/60 bg-rose-500/10",
          delay: 0.5,
        },
      },
    ],
    [],
  );
  const edges: Edge[] = useMemo(
    () => [
      { id: "c-b", source: "client", target: "bff", label: "UI + SSE", animated: true },
      { id: "b-a", source: "bff", target: "agent", label: "X-Session-API-Key", animated: true },
      { id: "a-w", source: "agent", target: "ws", label: "tool calls" },
      { id: "b-p", source: "bff", target: "pg", label: "manager runs" },
      { id: "b-f", source: "bff", target: "forge", label: "tokens (server-side)" },
    ],
    [],
  );
  return (
    <div
      className="h-72 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)]"
      data-testid="contributing-map"
      role="img"
      aria-label="Interactive system map: the React SPA talks to the Express BFF over UI and SSE; the BFF talks to the headless agent-canvas container with a server-side API key; the agent runs tool calls in workspaces; the BFF also reaches Postgres for manager runs and GitHub/GitLab with server-side tokens. Click a node to open its doc."
    >
      <ReactFlow
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
      </ReactFlow>
    </div>
  );
}

const CATEGORY_ORDER: DocCategory[] = ["start", "architecture", "guides", "history"];

export function ContributingPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Contributing</h1>
          <Badge variant="info">docs</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-[var(--color-text-muted)]">
          Everything you need to work on this app — or to <strong>fork it and build your own</strong>{" "}
          local coding-agent IDE. Docs are plain markdown in the repo (single source of truth,{" "}
          <a className="underline" href={REPO_URL} target="_blank" rel="noreferrer">
            readable on GitHub <ExternalLink className="inline" size={11} aria-hidden />
          </a>
          ) rendered here in-app. Click a node below to jump in.
        </p>
      </div>

      <SystemMap />

      {CATEGORY_ORDER.map((cat, catIdx) => {
        const docs = DOCS.filter((d) => d.category === cat);
        if (docs.length === 0) return null;
        return (
          <section key={cat}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
              {CATEGORY_LABELS[cat]}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {docs.map((doc, i) => (
                <motion.div
                  key={doc.slug}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + catIdx * 0.1 + i * 0.05, duration: 0.3 }}
                >
                  <Link
                    to={`/openhands/contributing/${doc.slug}`}
                    data-testid={`doc-card-${doc.slug}`}
                    className="group block h-full rounded-lg border border-[var(--color-border-default)] p-4 transition-colors hover:border-[var(--color-border-focus)]"
                  >
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium group-hover:underline">{doc.title}</div>
                      {doc.status === "beta" && (
                        <Badge variant="beta" data-testid={`doc-card-status-${doc.slug}`}>
                          beta
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">{doc.blurb}</div>
                    <div className="mt-2 font-mono text-[10px] text-[var(--color-text-subtle)]">{doc.path}</div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
