// Client-side transition watcher for the browser channels (chime + desktop
// notifications). Mirrors the server-side ntfy notifier's semantics (seed
// silently, notify only on observed transitions, new-conversation first
// observations count) but lives in the browser so it fires wherever the app
// tab is open — including backgrounded tabs, where a desktop notification is
// exactly what surfaces the event (on macOS via Notification Center).
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { loadPrefs, notificationCopy, showDesktopNotification, type NotifyEvent } from "./notify.js";
import { playChime } from "./sound.js";
import { setTabAttention } from "./tabMeta.js";

const POLL_MS = 10_000;

const EVENT_INFO: Record<string, { event: NotifyEvent; kind: "ok" | "error" }> = {
  finished: { event: "finished", kind: "ok" },
  error: { event: "error", kind: "error" },
  stuck: { event: "stuck", kind: "error" },
  idle: { event: "idle", kind: "ok" },
};

interface ConversationLike {
  id?: string;
  title?: string | null;
  execution_status?: string;
}

export function useNotifyWatcher(): void {
  const lastStatus = useRef(new Map<string, string>());
  const seeded = useRef(false);
  // Conversations that transitioned while this tab was unfocused — drives the
  // "(n)" tab-title badge (tabMeta). Independent of the chime/desktop prefs:
  // the badge is unobtrusive, so it always tracks. Cleared on focus.
  const attention = useRef(new Set<string>());
  const navigate = useNavigate();

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const cycle = async () => {
      // Preferences are read every cycle so toggling applies immediately;
      // when disabled we keep tracking silently (no replay on re-enable).
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const res = await fetch("/api/openhands/conversations");
        if (!res.ok) return;
        const page = (await res.json()) as { items?: ConversationLike[] };
        const prefs = loadPrefs();
        let chime: "ok" | "error" | null = null;
        const seen = new Set<string>();
        for (const conv of page.items ?? []) {
          if (!conv.id || typeof conv.execution_status !== "string") continue;
          seen.add(conv.id);
          const prev = lastStatus.current.get(conv.id);
          lastStatus.current.set(conv.id, conv.execution_status);
          if (!seeded.current || prev === conv.execution_status) continue;
          if (conv.execution_status === "running") attention.current.delete(conv.id);
          const info = EVENT_INFO[conv.execution_status];
          if (!info) continue;
          if (!document.hasFocus()) attention.current.add(conv.id);
          if (!prefs.events[info.event]) continue;
          // Chime: at most one per cycle, error tone wins over ok.
          if (info.kind === "error") chime = "error";
          else chime ??= "ok";
          // Desktop: one notification per transitioned conversation, with a
          // click-through deep link (SPA navigate, no reload).
          if (prefs.desktop) {
            const id = conv.id;
            const copy = notificationCopy(info.event, conv.title, id);
            showDesktopNotification({
              title: copy.title,
              body: copy.body,
              tag: `openhands-${id}`,
              onClick: () => navigate(`/openhands/native/conversations/${id}`),
            });
          }
        }
        for (const id of lastStatus.current.keys()) {
          if (!seen.has(id)) {
            lastStatus.current.delete(id);
            attention.current.delete(id);
          }
        }
        seeded.current = true;
        setTabAttention(attention.current.size);
        if (prefs.sound && chime) playChime(chime, prefs.volume);
      } catch {
        /* transient — next cycle retries */
      } finally {
        inFlight = false;
      }
    };

    const onFocus = () => {
      attention.current.clear();
      setTabAttention(0);
    };
    window.addEventListener("focus", onFocus);
    void cycle();
    const timer = setInterval(() => void cycle(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [navigate]);
}
