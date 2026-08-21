#!/usr/bin/env bash
# Single-click install/update for the packaged app. Requires Docker only.
#
#   curl -fsSL https://github.com/leoncheng57/Customizable-DCA-OpenHands/releases/latest/download/install.sh | bash
#
# Downloads the release bundle (compose.yaml + env.example + askpass helper)
# into ~/openhands-app (override: OPENHANDS_APP_DIR), bootstraps .env on first
# run (prompts for ANTHROPIC_API_KEY when a terminal is attached), then
# `docker compose pull && up -d`. Re-running updates to the newest images.
#
# Env knobs: OPENHANDS_APP_DIR (install dir), OPENHANDS_APP_VERSION
# (release tag without the leading v, default latest).
set -euo pipefail

REPO="leoncheng57/Customizable-DCA-OpenHands"
VERSION="${OPENHANDS_APP_VERSION:-latest}"
DIR="${OPENHANDS_APP_DIR:-$HOME/openhands-app}"

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required — install Docker Desktop (or Engine) first: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose' — ships with Docker Desktop)."
docker info >/dev/null 2>&1 || die "Docker daemon is not running — start Docker and re-run."
command -v curl >/dev/null 2>&1 || die "curl is required."

if [ "$VERSION" = "latest" ]; then
  BUNDLE_URL="https://github.com/$REPO/releases/latest/download/openhands-app-bundle.tar.gz"
else
  BUNDLE_URL="https://github.com/$REPO/releases/download/v$VERSION/openhands-app-bundle.tar.gz"
fi

say "Installing into $DIR (bundle: $VERSION)"
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "$BUNDLE_URL" -o openhands-app-bundle.tar.gz \
  || die "Could not download $BUNDLE_URL — check that a release exists and that you are online."
tar -xzf openhands-app-bundle.tar.gz
rm -f openhands-app-bundle.tar.gz

if [ ! -f .env ]; then
  cp env.example .env
  # Default projects dir: absolute path (compose does not expand ~).
  PROJECTS_DEFAULT="$HOME/Projects"
  # -r/-w on /dev/tty is not enough: without a controlling terminal the node
  # exists but opening it fails (macOS: "Device not configured") — probe by
  # actually opening it.
  if { : < /dev/tty; } 2>/dev/null; then
    printf 'Anthropic API key (sk-ant-…, from console.anthropic.com): ' > /dev/tty
    IFS= read -r ANTHROPIC_KEY < /dev/tty || ANTHROPIC_KEY=""
    printf 'Projects directory [%s]: ' "$PROJECTS_DEFAULT" > /dev/tty
    IFS= read -r PROJECTS_DIR < /dev/tty || PROJECTS_DIR=""
  else
    ANTHROPIC_KEY=""
    PROJECTS_DIR=""
  fi
  PROJECTS_DIR="${PROJECTS_DIR:-$PROJECTS_DEFAULT}"
  case "$PROJECTS_DIR" in "~"*) PROJECTS_DIR="$HOME${PROJECTS_DIR#\~}";; esac

  # Portable in-place edit (BSD/GNU sed differ) via a temp file.
  awk -v key="$ANTHROPIC_KEY" -v dir="$PROJECTS_DIR" '
    /^ANTHROPIC_API_KEY=/     { print "ANTHROPIC_API_KEY=" key; next }
    /^OPENHANDS_PROJECTS_DIR=/ { print "OPENHANDS_PROJECTS_DIR=" dir; next }
    { print }
  ' .env > .env.tmp && mv .env.tmp .env

  if [ "$VERSION" != "latest" ]; then
    printf 'OPENHANDS_APP_VERSION=%s\n' "$VERSION" >> .env
  fi
  mkdir -p "$PROJECTS_DIR"
  if [ -z "$ANTHROPIC_KEY" ]; then
    say "No terminal available for prompts — edit $DIR/.env and set ANTHROPIC_API_KEY, then re-run."
    exit 1
  fi
fi

mkdir -p .state
say "Pulling images (first run downloads ~a few GB for the agent image)…"
if ! docker compose pull; then
  die "Image pull failed. If the app image is private (GHCR default until flipped public), login first:
  gh auth token | docker login ghcr.io -u <github-user> --password-stdin
then re-run this script."
fi
say "Starting…"
docker compose up -d

PORT="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3000}"
say "Up! Open http://localhost:$PORT"
say "Manage it from $DIR: docker compose logs -f | docker compose down | re-run install.sh to update."
