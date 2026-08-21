// server/openhands/images.ts
//
// Chat-image rules shared by the OpenHands client (paste/attach pre-checks)
// and BFF (the authoritative gate). Users can attach screenshots to the
// initial task and to follow-up messages; the BFF forwards them to
// agent-canvas as ImageContent blocks ({ type: "image", image_urls: [data
// URL] } — see the agent-server OpenAPI SendMessageRequest schema).
//
// Validation here is deliberately stricter than the DeepStar prompt-image
// precedent it is modelled on: issue #258 showed that non-image bytes
// attached as an image permanently poison a conversation (the invalid block
// is persisted in the event log and replayed to the LLM on every resume), so
// the server verifies MAGIC BYTES, not just the declared media type.
// This module is isomorphic — no DOM, no Buffer — so both bundles can use it.

export const CHAT_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ChatImageMediaType = (typeof CHAT_IMAGE_MEDIA_TYPES)[number];

/** Decoded-size cap — about what the model ingests, not the wire (base64 inflates ~4/3). */
export const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const CHAT_IMAGE_MAX_COUNT = 3;

/** Wire shape on POST /conversations and POST /conversations/:id/messages. */
export interface ChatImage {
  mediaType: ChatImageMediaType;
  /** Standard base64 (no data: prefix). */
  data: string;
}

const MEDIA_TYPES: ReadonlySet<string> = new Set(CHAT_IMAGE_MEDIA_TYPES);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type AcceptResult = { ok: true } | { ok: false; reason: string };

/** Client-side pre-check so a paste rejects instantly; the server re-validates. */
export function acceptChatImage(candidate: { type: string; size: number }, currentCount: number): AcceptResult {
  if (currentCount >= CHAT_IMAGE_MAX_COUNT) {
    return { ok: false, reason: `at most ${CHAT_IMAGE_MAX_COUNT} images per message` };
  }
  if (!MEDIA_TYPES.has(candidate.type)) {
    return { ok: false, reason: `only ${CHAT_IMAGE_MEDIA_TYPES.map((t) => t.slice(6)).join(", ")} images are supported` };
  }
  if (candidate.size > CHAT_IMAGE_MAX_BYTES) {
    return { ok: false, reason: `image exceeds the ${CHAT_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` };
  }
  return { ok: true };
}

export interface PasteSelection {
  /** Indices into the candidate array that fit the caps, in paste order. */
  accepted: number[];
  /** First reject reason — null on a clean batch. */
  reason: string | null;
}

/**
 * Batch decision for one paste/pick event: each acceptance counts against the
 * cap for the rest of the batch; a rejected file never blocks later valid ones
 * (same semantics as DeepStar's selectPastedImages).
 */
export function selectChatImages(candidates: Array<{ type: string; size: number }>, currentCount: number): PasteSelection {
  const accepted: number[] = [];
  let reason: string | null = null;
  for (const [i, candidate] of candidates.entries()) {
    const verdict = acceptChatImage(candidate, currentCount + accepted.length);
    if (verdict.ok) accepted.push(i);
    else reason ??= verdict.reason;
  }
  return { accepted, reason };
}

// ── Magic-byte verification ──────────────────────────────────────────────────
// Decode just the first base64 quantums (no Buffer/atob so the module stays
// isomorphic) and match the file signature against the declared media type.

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64_ALPHABET].map((c, i) => [c, i] as const));

/** Decode the first `count` bytes of a base64 string (input already validated). */
function decodePrefix(data: string, count: number): number[] {
  const out: number[] = [];
  for (let q = 0; out.length < count && q + 4 <= data.length; q += 4) {
    const [a, b, c, d] = [...data.slice(q, q + 4)].map((ch) => B64_INDEX.get(ch) ?? -1);
    if (a! < 0 || b! < 0) break;
    out.push(((a! << 2) | (b! >> 4)) & 0xff);
    if (c! >= 0) out.push(((b! << 4) | (c! >> 2)) & 0xff);
    if (d! >= 0) out.push(((c! << 6) | d!) & 0xff);
  }
  return out.slice(0, count);
}

function matches(bytes: number[], signature: Array<number | null>, offset = 0): boolean {
  return signature.every((expected, i) => expected === null || bytes[offset + i] === expected);
}

/** True when the decoded bytes carry the file signature of the declared type. */
export function hasImageMagicBytes(mediaType: ChatImageMediaType, data: string): boolean {
  const bytes = decodePrefix(data, 12);
  if (bytes.length < 12) return false;
  switch (mediaType) {
    case "image/png":
      return matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return matches(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif": // GIF87a / GIF89a
      return matches(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp": // RIFF....WEBP
      return matches(bytes, [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]);
  }
}

export type ValidateChatImagesResult = { ok: true; value: ChatImage[] } | { ok: false; error: string };

/** The authoritative server-side gate for the `images` field on both routes. */
export function validateChatImages(input: unknown): ValidateChatImagesResult {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: "images must be an array of { mediaType, data } objects" };
  }
  if (input.length > CHAT_IMAGE_MAX_COUNT) {
    return { ok: false, error: `at most ${CHAT_IMAGE_MAX_COUNT} images per message` };
  }
  const value: ChatImage[] = [];
  for (const [i, raw] of input.entries()) {
    const e = raw as Record<string, unknown>;
    if (typeof e !== "object" || e === null || typeof e.mediaType !== "string" || typeof e.data !== "string") {
      return { ok: false, error: `images[${i}] must be { mediaType: string, data: base64 string }` };
    }
    if (!MEDIA_TYPES.has(e.mediaType)) {
      return {
        ok: false,
        error: `images[${i}]: media type "${e.mediaType}" is not supported (allowed: ${CHAT_IMAGE_MEDIA_TYPES.join(", ")})`,
      };
    }
    const data = e.data;
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      return { ok: false, error: `images[${i}]: data is not well-formed base64` };
    }
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const decodedBytes = (data.length / 4) * 3 - padding;
    if (decodedBytes > CHAT_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        error: `images[${i}]: ${decodedBytes} bytes exceeds the ${CHAT_IMAGE_MAX_BYTES / (1024 * 1024)} MB per-image limit`,
      };
    }
    if (!hasImageMagicBytes(e.mediaType as ChatImageMediaType, data)) {
      return { ok: false, error: `images[${i}]: content is not a valid ${e.mediaType} file` };
    }
    value.push({ mediaType: e.mediaType as ChatImageMediaType, data });
  }
  return { ok: true, value };
}

/** data: URL as agent-canvas ImageContent.image_urls expects. */
export function toImageDataUrl(image: ChatImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
