// Notifications page for the standalone runner: push notifications via ntfy
// (https://ntfy.sh) — subscribe to a topic on your phone/desktop and the
// in-process notifier pings you on status transitions — plus per-browser
// channels (chime + desktop notifications). Slack support is not ported
// (issue #1).
import { useEffect, useState } from "react";
import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { openHandsApi, type NotificationSettings } from "../lib/api.js";
import {
  desktopPermission,
  loadPrefs,
  requestDesktopPermission,
  savePrefs,
  showDesktopNotification,
  type BrowserNotifyPrefs,
  type NotifyEvent,
} from "../lib/notify.js";
import { playChime } from "../lib/sound.js";

const TRIGGERS: { emoji: string; event: NotifyEvent; status: string; when: string }[] = [
  { emoji: "✅", event: "finished", status: "finished", when: "The agent completed its run." },
  { emoji: "❌", event: "error", status: "error", when: "The run failed (e.g. LLM auth, tool crash)." },
  { emoji: "⚠️", event: "stuck", status: "stuck", when: "Stuck detection tripped — the agent is looping without progress." },
  { emoji: "💬", event: "idle", status: "awaiting input", when: "The agent went idle and is waiting for your reply." },
];

export function NotificationsPage() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [prefs, setPrefs] = useState<BrowserNotifyPrefs>(() => loadPrefs());
  const [permission, setPermission] = useState(() => desktopPermission());
  const [testResult, setTestResult] = useState<string | null>(null);
  const [desktopTest, setDesktopTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    openHandsApi.notifications().then(setSettings).catch((err: Error) => setError(err.message));
  }, []);

  const updatePrefs = (patch: Partial<BrowserNotifyPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch, events: { ...current.events, ...patch.events } };
      savePrefs(next);
      return next;
    });
  };

  const toggleDesktop = async (enabled: boolean) => {
    if (enabled) {
      const perm = await requestDesktopPermission();
      setPermission(perm);
      if (perm !== "granted") return;
    }
    updatePrefs({ desktop: enabled });
  };

  const update = <K extends keyof NotificationSettings>(field: K, value: NotificationSettings[K]) => {
    setSettings((current) => (current ? { ...current, [field]: value } : current));
    setSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await openHandsApi.updateNotifications({
        enabled: settings.enabled,
        notifyIdle: settings.notifyIdle,
        mentionMe: settings.mentionMe,
        ntfyUrl: settings.ntfyUrl,
        ntfyTopic: settings.ntfyTopic,
      });
      setSettings(next);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await openHandsApi.testNotification();
      setTestResult(`Sent to ${res.url}/${res.topic} — check your subscribed device.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <Badge variant="beta">channels</Badge>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        Runs are server-side and survive your laptop sleeping — so instead of watching the
        transcript, notifications ping you when something needs you. Three independent channels,
        enable any combination:{" "}
        <a className="underline" href="https://docs.ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>{" "}
        push (server-side, reaches your phone even with every tab closed), desktop notifications
        (native OS banners — macOS Notification Center, Windows toasts — while an app tab is
        open), and a browser chime.
      </p>

      {error && <div className="max-w-3xl"><Alert variant="danger">{error}</Alert></div>}

      <div className="max-w-3xl rounded-lg border border-[var(--color-border-default)] p-4">
        <h2 className="mb-1 text-sm font-semibold">This browser</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Per-browser preferences (stored locally); both channels need an app tab open — pinning
          one is enough. Applied immediately, no save needed.
        </p>
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={prefs.desktop && permission === "granted"}
              disabled={permission === "denied" || permission === "unsupported"}
              onChange={(e) => void toggleDesktop(e.target.checked)}
              className="mt-0.5"
              data-testid="channel-desktop"
            />
            <span>
              <span className="block font-medium">Desktop notifications</span>
              <span className="block text-xs text-[var(--color-text-muted)]">
                Native OS notification with the conversation title; clicking it jumps straight to
                the conversation. On a Mac these land in Notification Center — set the browser's
                alert style under System Settings → Notifications if banners don't appear.
              </span>
              {permission === "denied" && (
                <span className="block text-xs text-[var(--color-text-danger,#dc2626)]">
                  Notifications are blocked for this site — re-allow them in your browser's site
                  settings, then reload.
                </span>
              )}
              {permission === "unsupported" && (
                <span className="block text-xs text-[var(--color-text-muted)]">
                  This browser doesn't support the Notifications API.
                </span>
              )}
              {prefs.desktop && permission === "granted" && (
                <>
                  <button
                    type="button"
                    className="mt-1 block text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
                    onClick={() => {
                      const result = showDesktopNotification({
                        title: "OpenHands: desktop notifications are on",
                        body: "You'll get a banner like this when a run finishes, errors, gets stuck, or needs your input — click one to jump straight to the conversation.",
                        // Unique tag per click: a shared tag makes Chrome
                        // silently replace the sitting notification without
                        // re-alerting, so repeated tests would show no banner.
                        tag: `openhands-test-${Date.now()}`,
                      });
                      setDesktopTest(
                        result.ok
                          ? {
                              ok: true,
                              message:
                                "Notification sent. If you don't see a banner, look in macOS Notification Center — and check the browser's alert style under System Settings → Notifications (and that Focus/Do Not Disturb is off).",
                            }
                          : { ok: false, message: result.message },
                      );
                    }}
                    data-testid="channel-desktop-test"
                  >
                    Send test notification
                  </button>
                  {desktopTest && (
                    <span
                      className={`mt-1 block text-xs ${
                        desktopTest.ok
                          ? "text-[var(--color-text-success)]"
                          : "text-[var(--color-text-danger,#dc2626)]"
                      }`}
                      data-testid="channel-desktop-test-result"
                    >
                      {desktopTest.message}
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={prefs.sound}
              onChange={(e) => {
                updatePrefs({ sound: e.target.checked });
                // Unlock the AudioContext inside this user gesture so the
                // first real chime is not swallowed by autoplay policy.
                if (e.target.checked) playChime("ok", prefs.volume);
              }}
              className="mt-0.5"
              data-testid="channel-sound"
            />
            <span className="flex-1">
              <span className="block font-medium">Browser sound</span>
              <span className="block text-xs text-[var(--color-text-muted)]">
                Chime while an app tab is open (rising tone for finished / awaiting input,
                falling for error / stuck). Plays once on enable as a preview.
              </span>
              <span className={`mt-2 flex items-center gap-3 ${prefs.sound ? "" : "opacity-50"}`}>
                <span className="text-xs text-[var(--color-text-muted)]">Volume</span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={prefs.volume}
                  disabled={!prefs.sound}
                  onChange={(e) => updatePrefs({ volume: Number(e.target.value) })}
                  onMouseUp={() => playChime("ok", prefs.volume)}
                  onTouchEnd={() => playChime("ok", prefs.volume)}
                  className="w-40"
                  data-testid="sound-volume"
                />
                <button
                  type="button"
                  className="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text-default)] disabled:no-underline"
                  disabled={!prefs.sound}
                  onClick={() => playChime("error", prefs.volume)}
                  data-testid="channel-sound-test"
                >
                  Test error tone
                </button>
              </span>
            </span>
          </div>
          <div className="border-t border-[var(--color-border-default)] pt-3">
            <span className="mb-2 block text-xs font-medium text-[var(--color-text-muted)]">
              Notify this browser on
            </span>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {TRIGGERS.map((t) => (
                <label key={t.event} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={prefs.events[t.event]}
                    onChange={(e) => updatePrefs({ events: { ...prefs.events, [t.event]: e.target.checked } })}
                    data-testid={`browser-event-${t.event}`}
                  />
                  <span>{t.emoji} {t.status}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl rounded-lg border border-[var(--color-border-default)] p-4">
        <h2 className="mb-1 text-sm font-semibold">ntfy push</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Server-side preference; works with the app closed. Applied within one poll cycle
          (~10 s) — no restart needed. The topic can also come from{" "}
          <code>OPENHANDS_NTFY_TOPIC</code> in <code>.env</code>; values set here override it.
          Subscribe in the ntfy app or at{" "}
          <code>{settings?.ntfyUrl || "https://ntfy.sh"}/{settings?.ntfyTopic || "<your-topic>"}</code>.
        </p>
        {!settings ? (
          <LoadingIndicator />
        ) : (
          <div className="space-y-4 text-sm">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => update("enabled", e.target.checked)}
                className="mt-0.5"
                data-testid="channel-ntfy"
              />
              <span>
                <span className="block font-medium">Enable ntfy push</span>
                <span className="block text-xs text-[var(--color-text-muted)]">
                  Subscribe to the topic on your phone/desktop and get pinged even with every tab
                  closed.
                </span>
              </span>
            </label>
            <label className={`flex items-start gap-3 ${settings.enabled ? "" : "opacity-50"}`}>
              <input
                type="checkbox"
                checked={settings.notifyIdle}
                disabled={!settings.enabled}
                onChange={(e) => update("notifyIdle", e.target.checked)}
                className="mt-0.5"
                data-testid="ntfy-notify-idle"
              />
              <span>
                <span className="block font-medium">Notify when the agent needs input</span>
                <span className="block text-xs text-[var(--color-text-muted)]">Idle / awaiting-input transitions.</span>
              </span>
            </label>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">ntfy server</span>
                <input
                  value={settings.ntfyUrl}
                  onChange={(e) => update("ntfyUrl", e.target.value)}
                  placeholder="https://ntfy.sh"
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                  data-testid="ntfy-url"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--color-text-muted)]">
                  Topic {settings.ntfyFromEnv && settings.ntfyTopic ? "(from .env)" : ""}
                </span>
                <input
                  value={settings.ntfyTopic}
                  onChange={(e) => update("ntfyTopic", e.target.value)}
                  placeholder="pick-something-unguessable"
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-base)] p-2 text-sm"
                  data-testid="ntfy-topic"
                />
              </label>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              Anyone who knows the topic name can read it on a public ntfy server — pick an
              unguessable topic (e.g. <code>openhands-{"{random}"}</code>) or self-host with an
              access token (<code>OPENHANDS_NTFY_TOKEN</code>).
            </p>

            <div className="flex items-center gap-3 pt-1">
              <Button size="sm" onClick={save} disabled={saving} data-testid="ntfy-save">
                {saving ? "Saving…" : "Save preferences"}
              </Button>
              <Button size="sm" variant="secondary" onClick={sendTest} disabled={testing || !settings.ntfyTopic} data-testid="ntfy-test">
                {testing ? "Sending…" : "Send test notification"}
              </Button>
              {saved && <span className="text-xs text-[var(--color-text-success)]">Saved</span>}
              {testResult && <span className="text-xs text-[var(--color-text-success)]">{testResult}</span>}
            </div>
          </div>
        )}
      </div>

      <div className="max-w-3xl overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="px-4 py-2 font-medium">Ping</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {TRIGGERS.map((t) => (
              <tr key={t.status} className="border-b last:border-0">
                <td className="px-4 py-2">{t.emoji}</td>
                <td className="px-4 py-2 font-mono text-xs">{t.status}</td>
                <td className="px-4 py-2 text-muted-foreground">{t.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="max-w-3xl space-y-3 text-sm text-muted-foreground">
        <p>
          Each message carries the conversation title, a priority (errors and stuck runs are
          high-priority), and a click-through deep link straight back to the conversation. Only{" "}
          <em>observed transitions</em> notify — the watcher seeds silently on startup, so
          restarts don&apos;t replay old pings.
        </p>
        <p>
          Run <strong>one</strong> app server at a time: every running instance has its own
          watcher against the same agent-server, so two instances (e.g. <code>dev.sh</code> plus
          a built <code>node dist/server</code>) will double-send every ping.
        </p>
        <p>
          Slack notifications are not ported to this runner.
        </p>
      </div>
    </div>
  );
}
