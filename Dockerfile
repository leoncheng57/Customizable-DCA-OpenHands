# App image for the single-click package (see deploy/).
#
# Builds the UI + BFF and runs the compiled server, which serves the static
# client and proxies the agent-server. The container needs only two things at
# runtime: network reach to the agent-server (OPENHANDS_INTERNAL_URL) and the
# auto-generated agent API key (OPENHANDS_API_KEY or a mounted
# OPENHANDS_API_KEY_FILE). All file/git operations go through the agent-server
# HTTP API — no projects mount, no docker socket.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# vite bundles docs/*.md + CONTRIBUTING.md raw (client/lib/docs.ts), so the
# build context must include them — .dockerignore keeps the rest lean.
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# Links the GHCR package to this repo, so the package page and permissions
# follow the repository (set BEFORE the first publish).
LABEL org.opencontainers.image.source="https://github.com/leoncheng57/Customizable-DCA-OpenHands"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
# dist/server/index.js resolves the client at ../client — keep dist/ intact.
COPY --from=build /app/dist ./dist
COPY scripts/seed-agent-settings.mjs ./scripts/seed-agent-settings.mjs
COPY deploy/app-entrypoint.sh /usr/local/bin/app-entrypoint
RUN chmod +x /usr/local/bin/app-entrypoint
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch("http://localhost:"+(process.env.PORT||3000)+"/api/openhands/status").then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["app-entrypoint"]
