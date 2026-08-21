#!/usr/bin/env bash
# One-command local dev: agent-canvas (+ postgres when PGHOST is set) via
# docker compose, then the API server (tsx watch) and Vite dev UI on the host.
set -euo pipefail
cd "$(dirname "$0")/.."

# ── Flags ─────────────────────────────────────────────────────────────────────
# --tailscale (or OPENHANDS_TAILSCALE=1): expose the dev UI to your tailnet —
# auto-detects this machine's MagicDNS name for vite's Host allowlist and
# probes whether the macOS Application Firewall would silently drop tailnet
# connections. See docs/mobile.md.
TAILSCALE_MODE="${OPENHANDS_TAILSCALE:-0}"
for arg in "$@"; do
  case "$arg" in
    --tailscale) TAILSCALE_MODE=1 ;;
    *) echo "Unknown option: $arg (supported: --tailscale)" >&2; exit 1 ;;
  esac
done

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — set ANTHROPIC_API_KEY (and OPENHANDS_PROJECTS_DIR), then re-run."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

# Compose can't expand ~ — do it here so .env may use ~/Projects.
if [ "${OPENHANDS_PROJECTS_DIR:-}" != "" ]; then
  export OPENHANDS_PROJECTS_DIR="${OPENHANDS_PROJECTS_DIR/#\~/$HOME}"
  mkdir -p "$OPENHANDS_PROJECTS_DIR"
fi
mkdir -p .state

profiles=(--profile agent)
if [ -n "${PGHOST:-}" ]; then
  profiles+=(--profile manager)
fi

docker compose "${profiles[@]}" up -d --wait 2>/dev/null || docker compose "${profiles[@]}" up -d

# The projects bind mount makes docker create /home/openhands/workspace as
# root on first boot, which blocks the agent (uid 10001) from creating
# workspace/sessions/<uuid>. Idempotent ownership fix:
docker compose exec -T -u root openhands \
  chown openhands:openhands /home/openhands/workspace 2>/dev/null || true

# ── Sandbox CLIs: glab + acli + ntn ──────────────────────────────────────────
# The agent-canvas image ships gh but not glab (GitLab), acli (Atlassian) or
# ntn (Notion). Install once into the persistent home volume (survives
# container recreates), then symlink onto PATH as root each start (the symlink
# target /usr/local/bin is image-layer, i.e. lost on recreate — relinking is
# cheap).
docker compose exec -T openhands sh -c '
  set -e
  mkdir -p "$HOME/.local/bin"
  ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) A=arm64;; x86_64) A=amd64;; *) exit 0;; esac
  if [ ! -x "$HOME/.local/bin/glab" ]; then
    VER=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases?per_page=1" | sed -n "s/.*\"tag_name\":\"v\([0-9.]*\)\".*/\1/p" | head -1)
    if [ -n "$VER" ]; then
      curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${VER}/downloads/glab_${VER}_linux_${A}.tar.gz" | tar -xz -C /tmp
      find /tmp -maxdepth 3 -name glab -type f -exec mv {} "$HOME/.local/bin/glab" \; 2>/dev/null || true
      chmod +x "$HOME/.local/bin/glab" 2>/dev/null || true
    fi
  fi
  if [ ! -x "$HOME/.local/bin/acli" ]; then
    curl -fsSL -o "$HOME/.local/bin/acli" "https://acli.atlassian.com/linux/latest/acli_linux_${A}/acli" && chmod +x "$HOME/.local/bin/acli" || true
  fi
  # Notion CLI: official npm distribution (image ships node 22). --prefix puts
  # the install under the persistent home volume, bin lands in ~/.local/bin.
  if [ ! -x "$HOME/.local/bin/ntn" ]; then
    npm install --global --prefix "$HOME/.local" ntn >/dev/null 2>&1 || true
  fi
' 2>/dev/null || true
docker compose exec -T -u root openhands sh -c '
  [ -x /home/openhands/.local/bin/glab ] && ln -sf /home/openhands/.local/bin/glab /usr/local/bin/glab
  [ -x /home/openhands/.local/bin/acli ] && ln -sf /home/openhands/.local/bin/acli /usr/local/bin/acli
  [ -x /home/openhands/.local/bin/ntn ] && ln -sf /home/openhands/.local/bin/ntn /usr/local/bin/ntn
  true
' 2>/dev/null || true

# acli login (idempotent, best-effort): skipped when already authed or when
# the Atlassian env vars are absent. Credentials persist in the home volume.
docker compose exec -T openhands sh -c '
  command -v acli >/dev/null 2>&1 || exit 0
  [ -n "$ATLASSIAN_SITE" ] && [ -n "$ATLASSIAN_EMAIL" ] && [ -n "$ATLASSIAN_API_TOKEN" ] || exit 0
  acli jira auth status >/dev/null 2>&1 && exit 0
  echo "$ATLASSIAN_API_TOKEN" | acli jira auth login --site "$ATLASSIAN_SITE" --email "$ATLASSIAN_EMAIL" --token >/dev/null 2>&1 || true
' 2>/dev/null || true

# ── MCP servers for the agent ────────────────────────────────────────────────
# Sync mcp-servers.json (gitignored; see mcp-servers.example.json) into
# agent-canvas settings. No-op when the file is absent.
bash scripts/sync-mcp.sh 2>/dev/null || true

# ── Agent performance defaults ───────────────────────────────────────────────
# Seed the condenser token threshold (only over the stock null — user-saved
# values win) and disable the unreachable slack-mcp server. Issues #48 / #41.
bash scripts/sync-agent-settings.sh 2>/dev/null || true

export PORT="${PORT:-3000}"
echo "▶ API on :$PORT, UI on :5173 (agent-server on :8010)"

# ── Tailscale mode (issue #77, docs/mobile.md) ───────────────────────────────
if [ "$TAILSCALE_MODE" = "1" ]; then
  ts_name="$(tailscale status --json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  if [ -z "$ts_name" ]; then
    # No python3 (or tailscale down) — best-effort sed over the pretty-printed
    # JSON; Self precedes Peer, so the first DNSName is this machine's.
    ts_name="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": "\(.*\)\.",*/\1/p' | head -1 || true)"
  fi
  if [ -z "$ts_name" ]; then
    echo "⚠ --tailscale: could not detect this machine's tailnet name — is Tailscale running and logged in?" >&2
  else
    # Respect an explicit allowlist from .env; otherwise allow the MagicDNS
    # name (vite rejects unknown Host headers — DNS-rebinding protection).
    export VITE_ALLOWED_HOSTS="${VITE_ALLOWED_HOSTS:-$ts_name}"
    echo "▶ Tailnet: http://$ts_name:5173 (VITE_ALLOWED_HOSTS=$VITE_ALLOWED_HOSTS)"

    # Empirical firewall probe (macOS): a node listener that works on
    # localhost can still be silently dropped on the tailnet IP when the
    # Application Firewall has (ever) denied this node binary. Firewall
    # state queries lie for unlisted binaries — probing is the only
    # reliable check. Best-effort: skipped when curl/node/an IP is missing.
    ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    if [ "$(uname)" = "Darwin" ] && [ -n "$ts_ip" ] && command -v curl >/dev/null 2>&1; then
      node -e 'require("http").createServer((q,s)=>s.end("ok")).listen(19731,"0.0.0.0")' >/dev/null 2>&1 &
      fw_probe_pid=$!
      sleep 1
      if [ "$(curl -s -m 3 "http://$ts_ip:19731/" 2>/dev/null || true)" != "ok" ]; then
        node_bin="$(command -v node)"
        cat >&2 <<EOF
⚠ The macOS Application Firewall is dropping tailnet connections to this node
  binary ($node_bin) — localhost works, but the phone will get
  empty replies. Allow it once (then re-run):
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$node_bin"
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$node_bin"
  Alternative without sudo: HTTPS via 'tailscale serve --bg --https=443 http://localhost:5173'
  (tailscaled proxies over loopback, bypassing the firewall). See docs/mobile.md.
EOF
      fi
      kill "$fw_probe_pid" 2>/dev/null || true
    fi
  fi
fi

cleanup() {
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

npx tsx watch server/index.ts &
npx vite
