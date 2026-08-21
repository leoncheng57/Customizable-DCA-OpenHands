// Minimal replacement for the original platform's ServerAppDeps/ServerAppResult
// mounting contract — just enough for the copied openhands setup() to stay verbatim.

import type { Router } from "express";
import type { AppDatabase } from "./db.js";

export interface ServerAppDeps {
  /** Schema-bound database handle; absent → manager runs disabled. */
  db?: AppDatabase;
}

export interface ServerAppResult {
  /** Express routers to mount. Each gets mounted at the declared path. */
  routes: Array<{ path: string; router: Router }>;
  /** Called during graceful shutdown. */
  shutdown?: () => Promise<void> | void;
}
