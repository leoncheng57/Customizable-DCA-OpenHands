#!/bin/sh
# Git credential helper (GIT_ASKPASS) for the agent-canvas compose service.
# Lets the agent run plain `git clone https://...` without interactive
# prompts — credentials come from the container env.
#
# Git invokes this with the prompt text as $1, which contains the host URL:
#   "Username for 'https://gitlab.com': "  → a PAT works with any username
#   "Password for 'https://...':"         → the token itself
#
# Host-aware: github.com prompts are answered with GITHUB_TOKEN
# (username x-access-token, the form GitHub documents for PATs); everything
# else (GitLab et al.) keeps the original oauth2/GIT_TOKEN behavior.
case "$1" in
  *github.com*)
    case "$1" in
      Username*) echo "x-access-token" ;;
      *) echo "${GITHUB_TOKEN:-}" ;;
    esac
    ;;
  *)
    case "$1" in
      Username*) echo "oauth2" ;;
      *) echo "${GIT_TOKEN:-}" ;;
    esac
    ;;
esac
