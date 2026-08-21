// server/db.ts
//
// Per-app schema-bound database handles.
// Apps get an AppDatabase at startup that automatically routes all
// queries to their schema — no way to accidentally hit the wrong one.

import pg from "pg";
import { logger } from "./logger.js";

/**
 * Schema-bound database handle. All queries run against the app's schema.
 */
export interface AppDatabase {
  /** The schema name this handle is bound to. */
  readonly schema: string;

  /** The underlying pool (for passing to libraries that need it). */
  readonly pool: pg.Pool;

  /**
   * Run a query within the app's schema.
   * Automatically sets search_path before executing.
   */
  query<T extends pg.QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;

  /**
   * Get a client with search_path set to this schema.
   * Caller MUST call client.release() when done.
   */
  getClient(): Promise<pg.PoolClient>;

  /**
   * Run a function with a dedicated client (auto-released).
   * The client has search_path set to this schema.
   */
  withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;

  /**
   * Run a function inside a transaction within this schema.
   * Automatically commits on success, rolls back on error.
   */
  transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
}

const ensured = new Set<string>();

/**
 * Create a schema-bound database handle for an app.
 * Ensures the schema exists on first call.
 *
 * Usage:
 *   const db = await createAppDatabase(pool, "gtm");
 *   await db.query("CREATE TABLE IF NOT EXISTS snapshots (...)");
 *   const { rows } = await db.query("SELECT * FROM snapshots");
 */
export async function createAppDatabase(pool: pg.Pool, schema: string): Promise<AppDatabase> {
  // Validate schema name
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid schema name: ${schema}`);
  }

  // Ensure schema exists (idempotent)
  if (!ensured.has(schema)) {
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      ensured.add(schema);
      logger.info({ schema }, "App database schema ensured");
    } finally {
      client.release();
    }
  }

  const searchPath = `SET search_path TO "${schema}", public`;

  return {
    schema,
    pool,

    async query<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query(searchPath);
        return await client.query<T>(sql, params);
      } finally {
        await client.query("SET search_path TO public").catch(() => {});
        client.release();
      }
    },

    async getClient() {
      const client = await pool.connect();
      await client.query(searchPath);
      // Wrap release to reset search_path before returning to pool
      const originalRelease = client.release.bind(client);
      (client as any).release = async (err?: Error | boolean) => {
        // pg destroys the pooled connection when release receives an error.
        // Do not swallow that signal or attempt another query on a bad session.
        if (!err) await client.query("SET search_path TO public").catch(() => {});
        return originalRelease(err);
      };
      return client;
    },

    async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query(searchPath);
        return await fn(client);
      } finally {
        await client.query("SET search_path TO public").catch(() => {});
        client.release();
      }
    },

    async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query(searchPath);
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        await client.query("SET search_path TO public").catch(() => {});
        client.release();
      }
    },
  };
}
