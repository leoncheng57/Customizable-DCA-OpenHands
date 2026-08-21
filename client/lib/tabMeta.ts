// Browser-tab metadata: dynamic document.title + favicon so each session's
// tab is distinguishable in a wall of tabs (vertical-tab sidebars show ~25
// chars and a favicon — previously every tab was the identical static
// app title + green icon).
//
// Three inputs merge into one tab, conversation page winning:
//   - conversation meta (title + status tone) set by the Conversation page,
//   - a pending-attention count from the notify watcher (transitions observed
//     while the tab was unfocused; cleared on focus),
//   - a static page label for other routes (Runs, Terminal, …).
//
// Favicons are inline SVG data URIs (the base favicon.svg plus a corner status
// dot) — no canvas, no extra assets, immune to BASE_URL path differences.

export type StatusTone = "ok" | "busy" | "warn" | "error";

export const DEFAULT_TAB_TITLE = "Customizable DCA";
const APP_SUFFIX = "DCA";
const MAX_TITLE_CHARS = 40;

/** Glyph prefix mirroring the favicon badge for browsers that shrink favicons:
 * ✅ done, 🏃 running, 🔴 error, ⚠️ awaiting input. */
const TONE_GLYPHS: Record<StatusTone, string> = {
  ok: "✅",
  busy: "🏃",
  warn: "⚠️",
  error: "🔴",
};

/** Corner-badge SVG fragments overlaid on the base favicon. Emoji <text>
 * renders in Chromium/Firefox favicons; the error dot is drawn (crisper than
 * the 🔴 emoji at 16px). */
const BADGES: Record<StatusTone, string> = {
  ok: badgeText("✅"),
  busy: badgeText("🏃"),
  warn: badgeText("⚠️"),
  error: '<circle cx="24" cy="8" r="7.5" fill="#ef4444" stroke="#11181c" stroke-width="1.5"/>',
};

function badgeText(emoji: string): string {
  return `<text x="24" y="13.5" font-size="16" text-anchor="middle">${emoji}</text>`;
}

export function truncateTitle(raw: string, max = MAX_TITLE_CHARS): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

export interface ConversationTabMeta {
  title: string;
  /** null while the conversation is still loading — no glyph/dot yet. */
  tone: StatusTone | null;
}

export interface TabMetaState {
  conversation: ConversationTabMeta | null;
  attention: number;
  page: string | null;
}

export function composeTabTitle(state: TabMetaState): string {
  if (state.conversation) {
    const { title, tone } = state.conversation;
    const glyph = tone ? TONE_GLYPHS[tone] : "";
    const name = truncateTitle(title);
    return `${glyph ? `${glyph} ` : ""}${name} · ${APP_SUFFIX}`;
  }
  const count = state.attention > 0 ? `(${state.attention}) ` : "";
  const base = state.page ? `${state.page} · ${DEFAULT_TAB_TITLE}` : DEFAULT_TAB_TITLE;
  return `${count}${base}`;
}

/** The tone whose dot the favicon shows for the given state, if any. */
export function composeFaviconTone(state: TabMetaState): StatusTone | null {
  if (state.conversation) return state.conversation.tone;
  return state.attention > 0 ? "warn" : null;
}

/** client/favicon.svg with an optional status badge in the top-right corner. */
export function faviconSvg(tone: StatusTone | null): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#3ecf8e"/><stop offset="1" stop-color="#24b47e"/>' +
    "</linearGradient></defs>" +
    '<rect width="32" height="32" rx="8" fill="url(#g)"/>' +
    '<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m8.5 10 6 6-6 6"/><line x1="17.5" y1="22" x2="24" y2="22"/></g>' +
    (tone ? BADGES[tone] : "") +
    "</svg>"
  );
}

export function faviconDataUri(tone: StatusTone | null): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(tone))}`;
}

// ---------------------------------------------------------------------------
// DOM appliers — module-level state merged and rendered on every setter call.

const state: TabMetaState = { conversation: null, attention: 0, page: null };

function render(): void {
  if (typeof document === "undefined") return;
  document.title = composeTabTitle(state);
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = faviconDataUri(composeFaviconTone(state));
}

/** Owned by the Conversation page; pass null on unmount to release the tab. */
export function setConversationTabMeta(meta: ConversationTabMeta | null): void {
  state.conversation = meta;
  render();
}

/** Number of unseen conversation transitions — from the notify watcher. */
export function setTabAttention(count: number): void {
  if (state.attention === count) return;
  state.attention = count;
  render();
}

/** Static label for non-conversation routes (null = hub/default). */
export function setPageTabTitle(page: string | null): void {
  if (state.page === page) return;
  state.page = page;
  render();
}
