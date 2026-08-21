// Agent settings page: exposes the agent-server's context-condensation knobs.
// Long sessions slow down dramatically (4x+ per step) because every LLM call
// re-sends the whole transcript; the condenser summarizes history back down,
// and this page lets the user pick how early that happens. See issue #48 for
// the measurements behind the defaults recommended here.
import { useEffect, useState } from "react";
import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { openHandsApi, type AgentSettings } from "../lib/api.js";
import { loadStreamEnabled, saveStreamEnabled } from "../lib/streamPrefs.js";

const RECOMMENDED_MAX_TOKENS = 80_000;

/** Parse a number input; empty string means "unset" (null). */
function parseTokens(raw: string): number | null {
  const trimmed = raw.trim().replace(/[_,\s]/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function AgentSettingsPage() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [maxTokensText, setMaxTokensText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamEnabled, setStreamEnabled] = useState(() => loadStreamEnabled());

  useEffect(() => {
    openHandsApi
      .agentSettings()
      .then((s) => {
        setSettings(s);
        setMaxTokensText(s.condenser.maxTokens === null ? "" : String(s.condenser.maxTokens));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const update = (patch: Partial<AgentSettings["condenser"]>) => {
    setSettings((current) => (current ? { condenser: { ...current.condenser, ...patch } } : current));
    setSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await openHandsApi.updateAgentSettings({
        condenser: {
          enabled: settings.condenser.enabled,
          maxTokens: parseTokens(maxTokensText),
          maxSize: settings.condenser.maxSize,
          keepFirst: settings.condenser.keepFirst,
        },
      });
      setSettings(next);
      setMaxTokensText(next.condenser.maxTokens === null ? "" : String(next.condenser.maxTokens));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tokensUnset = !maxTokensText.trim();

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Agent settings</h1>
        <Badge variant="beta">performance</Badge>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        Server-side defaults for every <em>new</em> conversation (running ones keep the settings
        they started with). Stored in the agent-server's profile, so they survive restarts.
      </p>

      {error && <div className="max-w-3xl"><Alert variant="danger">{error}</Alert></div>}

      <div className="max-w-3xl rounded-lg border border-[var(--color-border-default)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Context condensation</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Every agent step re-sends the whole conversation history to the LLM, so long sessions
          get slower and pricier with each turn — measured at 21s per step early on vs 84s+ after
          a few hours. Condensation summarizes older history back down when it crosses the thresholds below.
          Trade-off: each condensation costs one slower (cache-rebuilding) turn and drops
          transcript detail the agent can no longer see.
        </p>
        {!settings ? (
          <LoadingIndicator />
        ) : (
          <div className="space-y-4 text-sm">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={settings.condenser.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
                className="mt-0.5"
                data-testid="condenser-enabled"
              />
              <span>
                <span className="block font-medium">Enable condensation</span>
                <span className="block text-xs text-[var(--color-text-muted)]">
                  Strongly recommended — without it, context grows without bound.
                </span>
              </span>
            </label>

            <label className={`block ${settings.condenser.enabled ? "" : "opacity-50"}`}>
              <span className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                Token threshold {tokensUnset ? "(off — the stock default)" : ""}
              </span>
              <input
                value={maxTokensText}
                disabled={!settings.condenser.enabled}
                onChange={(e) => {
                  setMaxTokensText(e.target.value);
                  setSaved(false);
                }}
                placeholder={`recommended: ${RECOMMENDED_MAX_TOKENS.toLocaleString("en-US")}`}
                inputMode="numeric"
                className="w-56 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                data-testid="condenser-max-tokens"
              />
              <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                Condense once the visible history exceeds this many tokens. Empty = no token
                trigger (condensation then only fires at the event-count threshold, which in
                practice lets sessions reach 200k+ tokens per turn). {RECOMMENDED_MAX_TOKENS.toLocaleString("en-US")}{" "}
                keeps steps fast; raise it if the agent forgets too much on very long tasks.
              </span>
            </label>

            <button
              type="button"
              className="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
              onClick={() => setShowAdvanced((v) => !v)}
              data-testid="condenser-advanced-toggle"
            >
              {showAdvanced ? "Hide advanced" : "Advanced"}
            </button>

            {showAdvanced && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className={`block ${settings.condenser.enabled ? "" : "opacity-50"}`}>
                  <span className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Event-count threshold</span>
                  <input
                    type="number"
                    min={20}
                    max={1000}
                    value={settings.condenser.maxSize}
                    disabled={!settings.condenser.enabled}
                    onChange={(e) => update({ maxSize: Number(e.target.value) })}
                    className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                    data-testid="condenser-max-size"
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Also condense past this many events (stock: 240).
                  </span>
                </label>
                <label className={`block ${settings.condenser.enabled ? "" : "opacity-50"}`}>
                  <span className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">Keep first events</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.condenser.keepFirst}
                    disabled={!settings.condenser.enabled}
                    onChange={(e) => update({ keepFirst: Number(e.target.value) })}
                    className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                    data-testid="condenser-keep-first"
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Never summarize away the first N events (system prompt + your task).
                  </span>
                </label>
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <Button size="sm" onClick={save} disabled={saving} data-testid="condenser-save">
                {saving ? "Saving…" : "Save settings"}
              </Button>
              {saved && <span className="text-xs text-[var(--color-text-success)]">Saved — applies to new conversations</span>}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-3xl rounded-lg border border-[var(--color-border-default)] p-4">
        <h2 className="mb-1 text-sm font-semibold">This browser</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Per-browser preference (stored locally, applied to conversation pages on their next
          load — no save needed).
        </p>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={streamEnabled}
            onChange={(e) => {
              setStreamEnabled(e.target.checked);
              saveStreamEnabled(e.target.checked);
            }}
            className="mt-0.5"
            data-testid="stream-enabled"
          />
          <span>
            <span className="block font-medium">Live token streaming</span>
            <span className="block text-xs text-[var(--color-text-muted)]">
              Streams the agent's reply into the transcript as it is generated (visible, running
              conversations only). Turn off to fall back to plain 3s polling — the escape hatch
              if streaming ever misbehaves (e.g. stuck tabs from connection exhaustion).
            </span>
          </span>
        </label>
      </div>

      <div className="max-w-3xl space-y-3 text-sm text-muted-foreground">
        <p>
          <strong>Rule of thumb for long tasks:</strong> even with condensation, a session that has
          been running for hours carries a lot of summarized weight. Starting a fresh conversation
          with a short handoff summary is often faster and cheaper than steering an old one.
        </p>
        <p>
          <code>scripts/dev.sh</code> seeds the recommended token threshold on first boot when the
          profile still has the stock value; anything you save here overrides that and is never
          overwritten.
        </p>
      </div>
    </div>
  );
}
