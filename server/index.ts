import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { authMiddleware } from "./auth.js";
import { logger } from "./logger.js";
import type { ServerAppDeps } from "./app-types.js";
import { setup as setupOpenHands } from "./openhands/setup.js";

async function main() {
  const app = express();
  app.set("trust proxy", true);

  // OpenHands conversations accept pasted/attached chat images (≤3 × 4 MB
  // decoded, magic-byte-validated in the BFF) on create and follow-up
  // messages — the raised limit must be registered before the global parser.
  app.use("/api/openhands/conversations", express.json({ limit: "20mb" }));
  app.use(express.json());
  app.use(authMiddleware());

  // Manager runs need Postgres. Wire it only when PGHOST is set — without it
  // the feature is cleanly disabled (setup() logs a warning and skips it).
  const deps: ServerAppDeps = {};
  if (process.env.PGHOST) {
    const { default: pg } = await import("pg");
    const { createAppDatabase } = await import("./db.js");
    const pool = new pg.Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "openhands",
      user: process.env.PGUSER || "openhands",
      password: process.env.PGPASSWORD,
      max: 10,
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    });
    try {
      deps.db = await createAppDatabase(pool, "openhands");
      logger.info("database connected (manager runs enabled)");
    } catch (err) {
      logger.error({ err }, "database connection failed; manager runs disabled");
    }
  }

  const result = await setupOpenHands(deps);
  for (const { path: mountPath, router } of result.routes) {
    app.use(mountPath, router);
  }

  // Prod static serving + SPA fallback (dist/server/index.js -> ../client).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(here, "../client");
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"), (err) => {
      if (err) res.status(404).end();
    });
  });

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    logger.info({ port }, "server listening");
  });

  const shutdown = async () => {
    await result.shutdown?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
