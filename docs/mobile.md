# Mobile & Tailscale

Use the app from a phone on your tailnet — the dev stack or the packaged release —
plus what "mobile-friendly" means in this codebase.

## The short version

```bash
bash scripts/dev.sh --tailscale
# → prints  ▶ Tailnet: http://<machine>.<tailnet>.ts.net:5173
# open that on the phone (same tailnet)
```

The flag auto-detects this machine's MagicDNS name, allowlists it for vite's
Host check (`VITE_ALLOWED_HOSTS`), and **probes the macOS Application
Firewall** — the one silent failure mode (see below). Everything it does can
also be configured by hand; read on.

## How the traffic flows

```text
📱 Phone (Tailscale app, same tailnet)
   │  WireGuard tunnel
   ▼
tailscaled on this machine
   │
   ├── direct TCP ──────────► vite :5173 (dev)  /  docker-published :3000 (release)
   │                          ⚠ subject to the macOS Application Firewall
   │
   └── tailscale serve ─────► localhost:5173 / :3000 over loopback
       (HTTPS :443)           ✓ bypasses the firewall — tailscaled terminates
                              the connection and proxies locally
```

Two gates sit on the **direct** path, and only affect it:

1. **Vite's Host allowlist** (dev only) — vite rejects requests whose `Host`
   header isn't allowlisted (DNS-rebinding protection). Fix: `--tailscale`
   flag, or `VITE_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net` (or `all`) in
   `.env` (see `vite.config.ts`). The packaged release has no vite — this
   gate doesn't exist there.
2. **macOS Application Firewall** — node binaries that were ever denied (or
   were never approved) get incoming connections **silently dropped**:
   localhost works, the tailnet IP gets empty replies, and firewall state
   queries (`socketfilterfw --getappblocked`) report "permitted" anyway.
   `dev.sh --tailscale` detects this empirically (throwaway listener + curl
   against the tailscale IP). Fix once:

   ```bash
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(command -v node)"
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(command -v node)"
   ```

   The rule is per-binary: every nvm version switch is a new binary. Docker's
   backend is typically already approved, so the release package's published
   port is unaffected.

## Dev stack over Tailscale

```bash
bash scripts/dev.sh --tailscale          # or OPENHANDS_TAILSCALE=1 in .env / env
# phone: http://<machine>.<tailnet>.ts.net:5173
```

An explicit `VITE_ALLOWED_HOSTS` in `.env` wins over the auto-detected name.
The BFF (`:$PORT`) needs no config — the phone talks only to vite, which
proxies `/api` over loopback.

## Release package over Tailscale

The [single-click package](packaging.md) serves UI+API from one Express
process on `:3000`, bound to `127.0.0.1` by default (`OPENHANDS_BIND` in
`~/openhands-app/.env`). Two options:

- **`tailscale serve` (recommended)** — keeps the loopback bind, tailnet-only
  HTTPS, no firewall involvement:

  ```bash
  tailscale serve --bg --https=443 http://localhost:3000
  # → https://<machine>.<tailnet>.ts.net
  tailscale serve status    # inspect
  tailscale serve reset     # undo
  ```

- **Direct port** — set `OPENHANDS_BIND=0.0.0.0`, `docker compose up -d`,
  open `http://<machine>.<tailnet>.ts.net:3000`. Fine on a trusted tailnet.

## HTTPS via `tailscale serve`

Needed for browser features gated on secure contexts — notably **desktop/mobile
notifications** (`client/lib/notify.ts`). One-time, per tailnet: the first
`tailscale serve` run prints a personalized admin-console link
(*"Serve is not enabled on your tailnet"*) — enabling it is a browser click,
not a command. Then re-run; the first successful run also provisions the TLS
certificate (~30 s).

Works for the dev stack too: `tailscale serve --bg --https=443 http://localhost:5173`
still needs `VITE_ALLOWED_HOSTS` (serve forwards the original Host header) but
sidesteps the firewall.

> ⚠ Never use `tailscale funnel` here — funnel is the *public-internet*
> variant of serve, and this app has no real authentication in local mode.

## Add to home screen (PWA)

`client/public/` ships a web-app manifest (`manifest.webmanifest`) and touch
icons rendered from `favicon.svg`, linked from `client/index.html`. From the
tailnet URL: share sheet → *Add to Home Screen* (iOS Safari) / install prompt
(Android Chrome). Standalone display, brand icon, `start_url` at the Hub.
There is no service worker on purpose — the app is useless offline and a
stale-cache layer would only complicate dev.

## What "mobile-friendly" means here

**Conversation layout (below `lg` = 64rem):**

- The sidebar icon rail and its overlay panel are replaced by a **dock row**
  above the composer (`MobileDock`) and a **full-screen bottom sheet**
  (`MobileSheet`) — full transcript width, scrim, swipe-down / tap-scrim /
  ✕ / OS-back-gesture dismissal (the sheet pushes one history entry while
  open). Panel content is the same `SidebarPanelBody` the desktop sidebar
  renders. The sheet never auto-opens from localStorage; deep links
  (`…/files`, `…/changes`) still open it.
- The `w-72` pinned task-list column becomes a collapsible **strip** above
  the dock (`TaskListStrip`).
- Below `sm` (40rem) the header collapses to **one row**: back chevron,
  title, status dot, and a `⋯` menu (`HeaderMenu`) carrying Run / Pause /
  Promote / Wrap / Delete plus the status and workspace badges. (Plan mode is
  deliberately absent — the composer's amber chrome and its
  Build/Plan toggle stay the single signal and control.)
- The shell column (`main.tsx`) is `h-[var(--app-vvh,100dvh)]`. `100dvh`
  follows the collapsing URL bar but *not* the software keyboard, so on
  coarse-pointer devices `--app-vvh` tracks the visual viewport
  (`client/lib/viewport.ts`) and every routed page inherits the correction.
- While the keyboard is up the panel dock, task strip and status bar are
  dropped (`useKeyboardOpen`) and the composer's control strip shrinks rather
  than wrapping — otherwise a 390x664 phone leaves a 252px column in which
  Send falls below the fold. Threshold is unit-tested (`tests/viewport.test.ts`).
- `viewport-fit=cover` + `env(safe-area-inset-bottom)` on the status bar and
  sheet, so nothing hides under the iPhone home indicator.

**Touch ergonomics (`pointer-coarse:` Tailwind variant):**

- `Button` sizes, tool-call chips, action-group toggles, the Build/Plan
  toggle, and the attach button all bump to ≥40px targets.
- Composer textarea and model select render at 16px on touch devices — iOS
  Safari auto-zooms on focus of anything smaller. The textarea also
  auto-grows with content (capped ~6 lines).
- The composer's Enter key inserts a newline on coarse-pointer devices —
  `client/lib/touch.ts` (`isCoarsePointer()`), send is the visible button.
  Tests: `tests/touch.test.ts`.
- The sidebar resize handle is hidden on touch (pointer events drive it
  elsewhere).

**Overflow discipline:**

- Below `lg`, the **Changes** page's three-column grid stacks into one scroll
  column.
- `.prose-ui code` breaks anywhere (`overflow-wrap: anywhere`) and
  `.prose-ui img` is capped at the column width; block code and tables
  scroll inside their own boxes, never the page. Tool-chip summaries truncate
  (`min-w-0`), `max-w-[90%]` bubbles, tighter paddings.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Phone: connection works on `http://localhost` forwarding but tailnet URL times out or resets | macOS firewall dropping node — run the `socketfilterfw` commands above, or use `tailscale serve` |
| "Blocked request. This host is not allowed." | vite Host allowlist — `--tailscale` flag or `VITE_ALLOWED_HOSTS` |
| `tailscale serve`: "Serve is not enabled on your tailnet" | one-time enable via the printed admin-console link |
| Notifications toggle does nothing on the phone | needs a secure context — use the `tailscale serve` HTTPS URL |
| Pasted a snippet and zsh says `missing delimiter for 'u' glob qualifier` | you pasted the trailing `# → … (undo: …)` comment line — run the bare command |
