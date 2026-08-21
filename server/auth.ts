// Extracts authenticated user info from oauth2-proxy headers.
// If a proxy fronts the app it sets these headers; otherwise (normal local
// use) requests fall back to a single-user dev identity. This local runner is
// single-tenant by design — the fallback is ON unless explicitly disabled or
// NODE_ENV=production. Setting ALLOW_DEV_AUTH=true re-enables the fallback
// even in production builds: the packaged single-click distribution runs the
// compiled server with NODE_ENV=production but is still a local single-user
// app (bound to localhost, no proxy in front).

import type { Request, Response, NextFunction } from "express";

export interface AuthUser {
  email: string;
  name?: string;
  groups?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const DEV_FALLBACK_EMAIL =
  process.env.ALLOW_DEV_AUTH === "true" ||
  (process.env.ALLOW_DEV_AUTH !== "false" && process.env.NODE_ENV !== "production")
    ? (process.env.DEV_USER_EMAIL ?? "dev@local")
    : null;

export function authMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const email =
      (req.headers["x-forwarded-email"] as string) ||
      (req.headers["x-auth-request-email"] as string) ||
      (req.headers["x-forwarded-user"] as string) ||
      DEV_FALLBACK_EMAIL;

    if (email) {
      const name =
        (req.headers["x-forwarded-preferred-username"] as string) ||
        (req.headers["x-auth-request-preferred-username"] as string) ||
        email.split("@")[0];

      const groupsHeader =
        (req.headers["x-auth-request-groups"] as string) ||
        (req.headers["x-forwarded-groups"] as string);

      const groups = groupsHeader
        ? groupsHeader.split(",").map((g) => g.trim()).filter(Boolean)
        : undefined;

      req.user = { email, name, groups };
    }

    next();
  };
}
