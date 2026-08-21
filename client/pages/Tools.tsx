// Tools & health: live view of everything the connected agent can do —
// agent-server baseline, the agent's tool list (with real health probes),
// installed skills, configured MCP servers, and BFF-side integrations
// (GitHub / GitLab / ntfy / manager DB). Backed by GET /api/openhands/tools.
//
// The Skills card is the one interactive section: it is backed by
// GET/PATCH /api/openhands/skills instead of the health probe, because skills
// are togglable globally (decision #17) rather than merely observable.
import { useCallback, useEffect, useState } from "react";
import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { openHandsApi, type SkillEntry, type SkillSources, type SkillsSettings, type ToolHealthState, type ToolsHealth } from "../lib/api.js";
import { skillEffectiveEnabled } from "../lib/skills.js";

function HealthDot({ health }: { health: ToolHealthState }) {
  const cls =
    health === "ok"
      ? "bg-[var(--app-accent-a,#3ecf8e)]"
      : health === "error"
        ? "bg-red-500"
        : "bg-[var(--color-text-subtle)] opacity-50";
  const label = health === "ok" ? "ok" : health === "error" ? "error" : "unknown";
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className={`h-2 w-2 rounded-full ${cls}`} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Latency({ ms }: { ms?: number }) {
  if (ms === undefined) return <span className="text-[10px] text-[var(--color-text-subtle)]">—</span>;
  return <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{ms}ms</span>;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SOURCE_LABELS: Array<{ key: keyof SkillSources; label: string; hint: string }> = [
  { key: "user", label: "User skills", hint: "~/.openhands/skills and ~/.openhands/microagents in the agent container." },
  { key: "public", label: "Public skills", hint: "The OpenHands public skills repository (github.com/OpenHands/extensions)." },
  {
    key: "project",
    label: "Project skills",
    hint: ".openhands/skills and AGENTS.md in each conversation's workspace — resolved per conversation, so they can't be listed here.",
  },
];

/**
 * Where a row came from. Auto-loaded skills report an internal cache path as
 * their `source` (…/cache/skills/public-skills/<name>/SKILL.md), which is
 * noise in a list — only an explicitly installed skill has a source worth
 * showing (e.g. `github:OpenHands/extensions`).
 */
function originLabel(s: SkillEntry): string {
  if (s.installed) return s.source ? `installed · ${s.source}` : "installed";
  if (s.autoLoaded) return "auto-loaded";
  return "not loaded — deny-listed name, kept so it can be re-enabled";
}

/**
 * Global skill toggles. Every write is optimistic-then-authoritative: the
 * checkbox flips locally so the UI stays responsive, the PATCH goes out, and
 * the server's re-read echo replaces local state wholesale — a rejected or
 * partially-applied change snaps back to the truth instead of lingering.
 *
 * The checkbox state is re-derived with `skillEffectiveEnabled` rather than
 * read off `entry.enabled`, so the client and the server agree by construction
 * (tests/skills.test.ts pins both to one case table).
 */
function SkillsCard() {
  const [data, setData] = useState<SkillsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    openHandsApi
      .skills()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  const save = async (
    patch: { skills?: Record<string, boolean>; sources?: Partial<SkillSources> },
    optimistic: (current: SkillsSettings) => SkillsSettings,
  ) => {
    if (!data) return;
    const previous = data;
    setData(optimistic(previous));
    setBusy(true);
    setError(null);
    try {
      setData(await openHandsApi.updateSkills(patch));
    } catch (err) {
      setData(previous);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSkill = (name: string, next: boolean) =>
    void save({ skills: { [name]: next } }, (current) => ({
      ...current,
      disabledSkills: next
        ? current.disabledSkills.filter((n) => n !== name)
        : current.disabledSkills.includes(name)
          ? current.disabledSkills
          : [...current.disabledSkills, name],
      skills: current.skills.map((s) =>
        s.name === name
          ? // The install-level flag only exists for installed skills; for a
            // deny-list-only row the deny-list alone decides.
            { ...s, denied: !next, installEnabled: s.installed ? next : true, enabled: next }
          : s,
      ),
    }));

  const toggleSource = (key: keyof SkillSources, next: boolean) =>
    void save({ sources: { [key]: next } }, (current) => {
      const sources = { ...current.sources, [key]: next };
      return {
        ...current,
        sources,
        loadingDisabled: !sources.user && !sources.public && !sources.project,
      };
    });

  return (
    <div className="app-card p-5" data-testid="tools-skills">
      <h2 className="mb-2 text-sm font-semibold">
        Skills <Badge variant="beta">{String(data?.skills.length ?? 0)}</Badge>
      </h2>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Global — applies to <em>new</em> conversations (running ones keep the skills they started
        with). Turning a skill off adds it to the agent-server's deny-list, which also silences
        auto-loaded skills that were never explicitly installed.
      </p>

      {error && (
        <div className="mb-3">
          <Alert variant="danger">{error}</Alert>
        </div>
      )}

      {!data && !error && <LoadingIndicator />}

      {data && (
        <>
          <div className="mb-3 space-y-1.5" data-testid="skill-sources">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-subtle)]">
              Skill sources
            </span>
            {SOURCE_LABELS.map(({ key, label, hint }) => (
              <label key={key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={data.sources[key]}
                  disabled={busy}
                  onChange={(e) => toggleSource(key, e.target.checked)}
                  data-testid={`skill-source-${key}`}
                />
                <span>
                  <span className="block">{label}</span>
                  <span className="block text-[11px] text-[var(--color-text-muted)]">{hint}</span>
                </span>
              </label>
            ))}
          </div>

          {data.loadingDisabled && (
            <p className="mb-3 text-xs text-[var(--color-text-muted)]" data-testid="skills-loading-off">
              Skill loading is off — every source above is disabled, so the agent loads no skills
              at all right now. Toggles below are still saved and take effect as soon as a source
              is switched on.
            </p>
          )}

          {data.loadedUnavailable && (
            <p className="mb-3 text-xs text-[var(--color-text-muted)]" data-testid="skills-loaded-unavailable">
              Couldn't enumerate auto-loaded skills just now (the agent-server refreshes them from
              GitHub). Installed skills are listed below; re-check to try again.
            </p>
          )}

          {data.skills.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]" data-testid="skills-empty">
              {data.loadingDisabled
                ? "Nothing to list while every source is off. Enable a source above, or install a skill from the upstream Canvas UI."
                : "No skills installed and none auto-loaded yet. Install one from the upstream Canvas UI, or add skills to a source above."}
            </p>
          ) : (
            <div className="divide-y divide-[var(--color-border-default)]" data-testid="skills-list">
              {data.skills.map((s) => (
                <label key={s.name} className="flex items-start gap-2 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={skillEffectiveEnabled({ name: s.name, enabled: s.installEnabled }, data.disabledSkills)}
                    disabled={busy}
                    onChange={(e) => toggleSkill(s.name, e.target.checked)}
                    data-testid={`skill-toggle-${s.name}`}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs">
                      {s.name}
                      {s.version && <span className="ml-1.5 text-[var(--color-text-subtle)]">{s.version}</span>}
                    </span>
                    <span className="block text-[11px] text-[var(--color-text-muted)]">
                      <span className="text-[var(--color-text-subtle)]">{originLabel(s)}</span>
                      {s.description && <span className="line-clamp-2"> {s.description}</span>}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ToolsPage() {
  const [data, setData] = useState<ToolsHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setChecking(true);
    setError(null);
    try {
      setData(await openHandsApi.tools(refresh));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex items-end gap-3 pt-2">
        <div>
          <h1 className="text-[1.6rem] font-bold tracking-tight">Tools &amp; health</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Live capabilities of the connected agent — health checks are real probes, cached ~30s.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="text-[11px] text-[var(--color-text-muted)]">
              probed {new Date(data.probedAt).toLocaleTimeString()}
            </span>
          )}
          <Button size="sm" variant="secondary" onClick={() => void load(true)} disabled={checking} data-testid="tools-recheck">
            {checking ? "Checking…" : "↻ Re-check"}
          </Button>
        </div>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}
      {!data && !error && <LoadingIndicator />}

      {data && (
        <>
          <div className="app-card flex items-center gap-3 p-4 text-sm" data-testid="tools-server">
            <HealthDot health={data.server.health} />
            <span className="font-medium">Agent server</span>
            <span className="text-[var(--color-text-muted)]">
              agent-canvas {data.server.version ?? "?"} · up {formatUptime(data.server.uptime)}
            </span>
            <span className="ml-auto"><Latency ms={data.server.latencyMs} /></span>
          </div>

          <div className="app-card p-5">
            <h2 className="mb-3 text-sm font-semibold">
              Agent tools <Badge variant="beta">{String(data.tools.length)}</Badge>
            </h2>
            <div className="divide-y divide-[var(--hh-border,rgba(127,127,127,0.15))]" data-testid="tools-agent-list">
              {data.tools.map((t) => (
                <div key={t.id} className="flex items-center gap-3 py-2 text-sm" data-testid={`tool-${t.id}`}>
                  <HealthDot health={t.health} />
                  <code className="w-44 shrink-0 font-mono text-xs">{t.id}</code>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">
                    {t.description}
                    {t.detail && <span className="ml-2 text-[11px] text-[var(--color-text-subtle)]">· {t.detail}</span>}
                  </span>
                  <Latency ms={t.latencyMs} />
                </div>
              ))}
            </div>
          </div>

          <div className="app-card p-5">
            <h2 className="mb-3 text-sm font-semibold">Integrations</h2>
            <div className="divide-y divide-[var(--hh-border,rgba(127,127,127,0.15))]">
              {data.integrations.map((i) => (
                <div key={i.id} className="flex items-center gap-3 py-2 text-sm" data-testid={`integration-${i.id}`}>
                  <HealthDot health={i.health} />
                  <span className="w-44 shrink-0 font-medium">{i.label}</span>
                  <span className={`min-w-0 flex-1 truncate ${i.health === "error" ? "text-[var(--color-text-critical,#ef4444)]" : "text-[var(--color-text-muted)]"}`}>
                    {i.detail}
                  </span>
                  <Latency ms={i.latencyMs} />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <SkillsCard />
            <div className="app-card p-5">
              <h2 className="mb-2 text-sm font-semibold">
                MCP servers <Badge variant="beta">{String(data.mcp.length)}</Badge>
              </h2>
              {data.mcp.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  None configured. Add servers via agent settings; each one shows up here with its probe state.
                </p>
              ) : (
                data.mcp.map((m) => (
                  <div key={m.name} className="flex items-center gap-3 py-1.5 text-sm">
                    <HealthDot health={m.health} />
                    <span className="font-mono text-xs">{m.name}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">{m.detail}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <p className="text-[11px] text-[var(--color-text-subtle)]">
            Legend: <HealthDot health="ok" /> ok · <HealthDot health="unknown" /> unknown (no cheap probe) ·{" "}
            <HealthDot health="error" /> error — latencies are the actual probe round-trips.
          </p>
        </>
      )}
    </div>
  );
}
