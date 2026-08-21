// Browser notification preferences + desktop-notification channel.
//
// Preferences are per-browser (localStorage) and cover both client-side
// channels: the WebAudio chime (sound.ts) and desktop notifications via the
// Web Notifications API — on macOS the latter surface as native Mac
// notifications through Notification Center (per-site permission required).
// Both are independent of the server-side ntfy channel.

export type NotifyEvent = "finished" | "error" | "stuck" | "idle";

export interface BrowserNotifyPrefs {
  /** WebAudio chime while an app tab is open. */
  sound: boolean;
  /** Web Notifications API — native OS notifications (macOS Notification Center etc.). */
  desktop: boolean;
  /** Chime volume, 0..1. */
  volume: number;
  /** Which transitions trigger the browser channels. */
  events: Record<NotifyEvent, boolean>;
}

export const NOTIFY_EVENTS: NotifyEvent[] = ["finished", "error", "stuck", "idle"];

export const DEFAULT_PREFS: BrowserNotifyPrefs = {
  sound: false,
  desktop: false,
  volume: 0.6,
  events: { finished: true, error: true, stuck: true, idle: true },
};

const PREFS_KEY = "openhands.browserNotify.v1";
// Pre-existing boolean sound toggle; migrated on first load then left as-is.
const LEGACY_SOUND_KEY = "openhands.browserSound.v1";

/** Coerce arbitrary stored JSON (or the legacy sound flag) into valid prefs. */
export function normalizePrefs(raw: unknown, legacySound?: string | null): BrowserNotifyPrefs {
  const base = structuredClone(DEFAULT_PREFS);
  if (legacySound === "1") base.sound = true;
  if (typeof raw !== "object" || raw === null) return base;
  const p = raw as Record<string, unknown>;
  if (typeof p.sound === "boolean") base.sound = p.sound;
  if (typeof p.desktop === "boolean") base.desktop = p.desktop;
  if (typeof p.volume === "number" && Number.isFinite(p.volume)) {
    base.volume = Math.min(1, Math.max(0, p.volume));
  }
  const events = p.events as Record<string, unknown> | undefined;
  if (typeof events === "object" && events !== null) {
    for (const ev of NOTIFY_EVENTS) {
      if (typeof events[ev] === "boolean") base.events[ev] = events[ev] as boolean;
    }
  }
  return base;
}

export function loadPrefs(): BrowserNotifyPrefs {
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    if (stored !== null) return normalizePrefs(JSON.parse(stored));
    return normalizePrefs(null, localStorage.getItem(LEGACY_SOUND_KEY));
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

export function savePrefs(prefs: BrowserNotifyPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode etc. */
  }
}

// ---------------------------------------------------------------------------
// Notification copy
//
// Desktop banners are the OpenHands brand's voice in the user's OS, so the
// text has to earn its place: name the product, say plainly what the agent did
// and what (if anything) is needed, and invite the click-through. Keep it to a
// short bold title + one-line body — anything longer gets truncated by the OS.

const APP_NAME = "OpenHands";

/** Fallback label when a conversation has no title yet. */
export function conversationLabel(title: string | null | undefined, id?: string): string {
  const trimmed = (title ?? "").trim();
  if (trimmed) return trimmed;
  return id ? `Conversation ${id.slice(0, 8)}` : "your conversation";
}

const EVENT_COPY: Record<NotifyEvent, { headline: string; body: (label: string) => string }> = {
  finished: {
    headline: `${APP_NAME}: agent finished`,
    body: (label) => `“${label}” wrapped up its work. Click to review the results.`,
  },
  error: {
    headline: `${APP_NAME}: agent hit an error`,
    body: (label) => `“${label}” stopped on an error. Click to take a look.`,
  },
  stuck: {
    headline: `${APP_NAME}: agent looks stuck`,
    body: (label) => `“${label}” hasn’t made progress in a while. Click to check in.`,
  },
  idle: {
    headline: `${APP_NAME}: agent needs you`,
    body: (label) => `“${label}” is waiting for your input to continue. Click to respond.`,
  },
};

/** Branded desktop-notification copy for a run transition. */
export function notificationCopy(
  event: NotifyEvent,
  title: string | null | undefined,
  id?: string,
): { title: string; body: string } {
  const copy = EVENT_COPY[event];
  return { title: copy.headline, body: copy.body(conversationLabel(title, id)) };
}

// ---------------------------------------------------------------------------
// Desktop notifications (Web Notifications API)

export type DesktopPermission = "granted" | "denied" | "default" | "unsupported";

export function desktopPermission(): DesktopPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export type DesktopNotifyResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "default" | "error"; message: string };

/**
 * Show one desktop notification. Returns a result so callers can surface
 * feedback — the OS may deliver the banner silently to Notification Center, so
 * "the constructor succeeded" is the only signal we can give back in-app.
 * `onClick` lets the caller deep-link back into the app (SPA navigate).
 */
export function showDesktopNotification(input: {
  title: string;
  body: string;
  tag?: string;
  onClick?: () => void;
}): DesktopNotifyResult {
  const perm = desktopPermission();
  if (perm === "unsupported") {
    return { ok: false, reason: "unsupported", message: "This browser doesn't support desktop notifications." };
  }
  if (perm !== "granted") {
    return {
      ok: false,
      reason: perm,
      message: "Notifications aren't allowed for this site — re-allow them in your browser's site settings, then reload.",
    };
  }
  try {
    const n = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      // With a tag, Chrome replaces the sitting notification silently; renotify
      // forces it to re-alert (banner + sound) so a fresh transition isn't lost.
      renotify: input.tag ? true : undefined,
      icon: `${import.meta.env.BASE_URL}favicon.svg`,
    } as NotificationOptions);
    n.onclick = () => {
      window.focus();
      input.onClick?.();
      n.close();
    };
    return { ok: true };
  } catch (err) {
    // Some browsers throw in insecure contexts or when the OS blocks the call.
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "The browser couldn't show the notification.",
    };
  }
}
