import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig(() => {
  // VITE_BASE_PATH is set by an agent session when this very app is being
  // developed *inside* an OpenHands workspace and served through the live
  // preview proxy (base = /api/openhands/conversations/<id>/preview/<port>/).
  const configuredBase = process.env.VITE_BASE_PATH || "/";
  const base = configuredBase.endsWith("/") ? configuredBase : `${configuredBase}/`;
  // The API server port is configurable (PORT) since :3000 is commonly taken.
  const apiTarget = `http://localhost:${process.env.PORT || 3000}`;

  return {
    base,
    plugins: [react(), tailwindcss()],
    root: "client",
    build: {
      // Server resolves dist/server/index.js -> ../client (see server/index.ts).
      outDir: "../dist/client",
      emptyOutDir: true,
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      // Vite rejects dev-server requests whose Host header is not allowlisted
      // (DNS-rebinding protection). The live-preview proxy reaches this server
      // with a non-localhost host, so preview sessions set VITE_ALLOWED_HOSTS
      // ("all" -> any host, or a comma-separated allowlist). Unset keeps
      // Vite's localhost-only default for normal local dev.
      allowedHosts:
        process.env.VITE_ALLOWED_HOSTS === "all"
          ? (true as const)
          : process.env.VITE_ALLOWED_HOSTS?.split(",").map((host) => host.trim()).filter(Boolean),
      fs: {
        // server/openhands/images.ts is shared client+server validation code;
        // docs/ + CONTRIBUTING.md are bundled raw into the Contributing pages
        // (client/lib/docs.ts). Keep this an explicit list — never the repo
        // root, which would expose .env via /@fs/.
        allow: [
          resolve(process.cwd(), "client"),
          resolve(process.cwd(), "server/openhands"),
          resolve(process.cwd(), "docs"),
          resolve(process.cwd(), "CONTRIBUTING.md"),
        ],
      },
      proxy: {
        // The live-preview base path starts with /api
        // (/api/openhands/conversations/<id>/preview/<port>), so without this
        // bypass the "/api" rule below would proxy the app's OWN pages/assets
        // to localhost:3000 (which doesn't exist in an agent workspace). Vite
        // matches proxy keys in insertion order, so this more-specific entry
        // wins and hands the request back to the dev server.
        ...(base.startsWith("/api/")
          ? {
              [base.replace(/\/$/, "")]: {
                target: apiTarget,
                bypass: (req: { url?: string }) => req.url ?? false,
              },
            }
          : {}),
        "/api": {
          target: apiTarget,
          ws: true,
        },
      },
    },
  };
});
