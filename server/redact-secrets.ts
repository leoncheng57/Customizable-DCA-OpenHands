// server/redact-secrets.ts
//
// Mask credential-shaped substrings in agent output.
//
// Workspace agents run `printenv`-style commands and read config files whose
// output is echoed back on stdout. Without this, live tokens (GitLab, Anthropic,
// Langfuse, Slack, Jira) land verbatim in every sink the agent stream feeds:
// Postgres `events`, the WebSocket broadcast, and now Langfuse observations.
//
// Ported from an internal Python `_RedactingFilter` (a `_SECRET_PATTERNS` table
// plus a `_redact_secrets` pass), which was added after tool output was observed
// dumping live credentials.
//
// Not a complete port, in the direction that matters: the Python has a `KEY=VALUE`
// matcher plus vendor token shapes and NO URL-credential pattern, so it would not mask
// `redis://user:pass@cache` either. URL_CREDENTIALS below is local-only with no
// counterpart to check parity against.
//
// Apply this to the RAW LINE, before JSON.parse — one choke point covers every
// downstream sink, and cannot drift as sinks are added. That is only sound
// because the replacement is JSON-safe: REDACTION contains no quote or
// backslash, the KEY=VALUE and URL-userinfo value classes stop at `"` and `\`, and
// the vendor patterns match token characters only. `redactSecrets` therefore never
// turns a valid JSON line into an invalid one (asserted in redact-secrets.test.ts).
//
// Because this runs per raw line, every pattern must stay linear — the key name is
// length-bounded for that reason, and a perf test pins it.

export const REDACTION = "***REDACTED***";

/**
 * `KEY=VALUE` env dumps where the key name implies a secret. The key is kept and
 * the value masked, so `printenv` output stays readable for debugging. The value
 * class stops at the next separator so the escaped-newline (`\n`) repr of a
 * printenv dump terminates each value instead of swallowing the rest of the line.
 */
const ENV_ASSIGNMENT = /(?<![A-Za-z0-9_])([A-Za-z0-9_]{1,64})=([^\s'"\\,)}]+)/g;

/**
 * Matched against the CAPTURED key rather than scanned for inside the line: a bare
 * alnum blob containing `AUTH`/`TOKEN`/`_KEY` (base64, minified JSON, a hash dump)
 * is ordinary on agent stdout, and the in-pattern scan was quadratic on it.
 * Ceiling: a key name longer than 64 chars is not masked.
 */
const SECRET_KEY_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|_KEY|AUTH/i;

/**
 * `scheme://user[:password]@host` — a git remote's embedded credential, or a bare
 * identity in the userinfo slot, neither of which belongs in a trace. When a password
 * is present AND the username looks like a plausible identity (see `looksLikeIdentity`,
 * not a secret held in the username slot — `https://<token>:x-oauth-basic@github.com`
 * is a real GitHub auth form) the username survives so the error stays diagnosable;
 * otherwise — including a bare userinfo with no password at all — the whole slot is
 * masked, since it is a credential or an identity, never neither.
 * The username class is `*`, not `+`, so the empty-username form
 * (`redis://:hunter2@cache`, `https://:$TOKEN@host`) is masked too — a token-only URL
 * is the more common shape in a connection string, and the trailing `@` still anchors it.
 * It also excludes `?` and `#`: since the password half is optional, a bare username
 * would otherwise swallow a query-string mailbox (`?email=alex@example.com`) whole.
 *
 * The password class no longer excludes `@` — a password containing one (`p@ss`) used to
 * truncate the match at the first `@`, leaving the remainder and the true host boundary
 * in the clear. Greedy matching plus backtracking on the mandatory trailing `@` naturally
 * lands on the LAST `@`, so an embedded one is consumed as part of the password.
 *
 * The password class ALLOWS `/`, because base64-ish deploy tokens contain it and
 * excluding it let those through in the clear. `new URL()` cannot help here: a raw `/`
 * in a password is not a valid URL, so it throws on exactly the input we need to mask.
 * Two guards keep the wider class from eating an ordinary URL that happens to be
 * followed by an `@`:
 *
 *   - `?#&=` stay excluded from the password body. They cannot appear in userinfo, so
 *     their presence proves the `@` belongs to a query value, not a credential — this is
 *     what stops `https://host:8443/x?u=bob@corp.com` collapsing to `https://host:***@corp.com`.
 *   - `(?!\d+\/)` rejects a password that is digits then a slash, i.e. a port followed by
 *     a path (`https://host:8443/a/b@c.com`). A `:` in a URL that is not a credential
 *     separator is almost always a port, so this is the shape worth vetoing. Cost: a
 *     genuine all-digits-then-slash password is missed. Accepted — TOKEN_SHAPES still
 *     covers vendor tokens, and the alternative loses host and path from error text.
 *
 * The trailing `[^…/]` means the password cannot END in `/`, which is what keeps
 * `https://registry:8443/@scope/pkg` intact.
 */
const URL_CREDENTIALS =
  /([a-z][a-z0-9+.-]*:\/\/)([^\s'"\\/:@?#]*)(?::((?!\d+\/)[^\s'"\\,)}?#&=]*[^\s'"\\,)}?#&=/]))?@/gi;

/** Vendor token shapes, masked wherever they appear — not just after a `KEY=`. */
const TOKEN_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /(?:sk|pk)-lf-[A-Za-z0-9-]{6,}/g,
  /glpat-[A-Za-z0-9._-]{6,}/g,
  /gl(?:cbt|ptt|rt|soat)-[A-Za-z0-9._-]{6,}/g,
  /xox[abprs]-[A-Za-z0-9-]{6,}/g,
  /figd_[A-Za-z0-9_-]{6,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

/**
 * Some auth forms put the secret in the USERNAME slot, not the password
 * (GitHub's `https://<token>:x-oauth-basic@github.com`, `https://<apikey>:@host`).
 * Keeping the username verbatim there would leak it — an opaque token has no
 * TOKEN_SHAPES match to fall back on. So the username survives only when it
 * looks like a plausible identity: short, plain characters, no secret shape.
 */
function looksLikeIdentity(user: string): boolean {
  // Empty is the token-only DSN form (`redis://:$TOKEN@host`) — nothing to leak there,
  // so it counts as identity-shaped too, preserving the shape instead of eating the `:`.
  return /^[A-Za-z0-9._-]{0,32}$/.test(user) && !containsSecret(user);
}

/** Mask credential-shaped substrings. Returns the input unchanged when nothing matches. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  // URL_CREDENTIALS cannot match without both `://` and a `@`, and its userinfo class
  // rescans to end-of-line from every start position when no `@` anchors it — O(n^2) on
  // a long line with neither. A 200KB line took 24s before this guard; a reassembled
  // stream-json event is exactly that shape (workspace-lifecycle.ts).
  let out = text.includes("://") && text.includes("@")
    ? text.replace(URL_CREDENTIALS, (_match, scheme: string, user: string, pass: string | undefined) =>
      pass !== undefined && looksLikeIdentity(user) ? `${scheme}${user}:${REDACTION}@` : `${scheme}${REDACTION}@`)
    : text;
  out = out.replace(ENV_ASSIGNMENT, (match, key: string) =>
    SECRET_KEY_NAME.test(key) ? `${key}=${REDACTION}` : match);
  for (const pattern of TOKEN_SHAPES) {
    out = out.replace(pattern, REDACTION);
  }
  return out;
}

/**
 * Drop a trailing fragment of the marker left behind by truncating redacted text.
 * Stops at four chars (`***R`), the shortest fragment that cannot be real content —
 * shorter ones are ordinary text (markdown bold, a glob tail, a footnote asterisk), so
 * a cut landing 1-3 chars in leaves a bare `***` rather than eating the value.
 */
export function stripPartialRedaction(text: string): string {
  if (typeof text !== "string" || !text) return text;
  // A complete marker also ends with its own short prefix (`***`), so bail out first.
  if (text.endsWith(REDACTION)) return text;
  for (let length = REDACTION.length - 1; length >= 4; length--) {
    if (text.endsWith(REDACTION.slice(0, length))) return text.slice(0, -length);
  }
  return text;
}

/** True when `redactSecrets` would change the input — for tests and assertions. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
