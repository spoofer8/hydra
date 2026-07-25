import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../lib/db.js";
import {
  consumeRefreshToken,
  getUserById,
  hashPassword,
  issueRefreshToken,
  verifyPassword,
} from "../lib/auth.js";
import { newId } from "../lib/ids.js";
import { config } from "../config.js";

const registerBody = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/),
  displayName: z.string().min(1).max(64).optional(),
  password: z.string().min(8).max(200),
});

const loginBody = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string(),
});

const refreshBody = z.object({ refreshToken: z.string() });

function issueAccessToken(app: FastifyInstance, userId: string, email: string, username: string): string {
  return app.jwt.sign(
    { sub: userId, email, username },
    { expiresIn: config.ACCESS_TOKEN_TTL }
  );
}

function authResponsePayload(app: FastifyInstance, user: {
  id: string; email: string; username: string;
}): { accessToken: string; refreshToken: string; expiresIn: number; workwondersJwt: string } {
  const accessToken = issueAccessToken(app, user.id, user.email, user.username);
  const refresh = issueRefreshToken(user.id);
  return {
    accessToken,
    refreshToken: refresh.token,
    expiresIn: config.ACCESS_TOKEN_TTL,
    workwondersJwt: "", // Opaque token used only by the checkout webview; empty is fine for self-host.
  };
}

// Very small HTML shell for the sign-in and sign-up forms. This page is opened
// in the OS browser by the Electron client (window-manager.ts constructs the
// URL from MAIN_VITE_AUTH_URL). On successful submit it redirects to the
// hydralauncher:// deep link, which the OS routes back into the launcher.
function renderAuthPage(mode: "signin" | "signup", error?: string): string {
  const title = mode === "signin" ? "Sign in to Hydra" : "Create a Hydra account";
  const submitLabel = mode === "signin" ? "Sign in" : "Create account";
  const switchHref = mode === "signin" ? "signup" : "signin";
  const switchLabel = mode === "signin" ? "Create one" : "Sign in instead";
  const usernameField =
    mode === "signup"
      ? `<label>Username<input name="username" required pattern="[A-Za-z0-9_-]{3,32}" autocomplete="username" /></label>
         <label>Display name (optional)<input name="displayName" autocomplete="nickname" /></label>`
      : "";
  const errorBlock = error ? `<p class="err">${error}</p>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>${title}</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #0f1116; color: #eee; }
  .card { width: 360px; max-width: 90vw; padding: 32px;
          background: #161923; border: 1px solid #262a36; border-radius: 12px; }
  h1 { margin: 0 0 20px; font-size: 20px; }
  label { display: block; margin-bottom: 14px; font-size: 13px; color: #aab; }
  input { width: 100%; padding: 10px 12px; margin-top: 6px; box-sizing: border-box;
          background: #0f1116; border: 1px solid #2b3040; color: #eee;
          border-radius: 6px; font-size: 14px; }
  input:focus { outline: 2px solid #3b6eea; border-color: #3b6eea; }
  button { width: 100%; padding: 10px; margin-top: 8px; background: #3b6eea;
           color: white; border: 0; border-radius: 6px; font-size: 14px; cursor: pointer; }
  .switch { margin-top: 14px; font-size: 13px; text-align: center; color: #889; }
  .switch a { color: #7aa2ff; text-decoration: none; }
  .err { background: #3a1a1a; color: #ffb3b3; padding: 10px; border-radius: 6px;
         font-size: 13px; margin-bottom: 12px; }
</style></head>
<body><form class="card" method="POST" action="${mode}">
  <h1>${title}</h1>
  ${errorBlock}
  ${usernameField}
  <label>Email<input type="email" name="email" required autocomplete="email" /></label>
  <label>Password<input type="password" name="password" required minlength="8" autocomplete="${
    mode === "signin" ? "current-password" : "new-password"
  }" /></label>
  <button type="submit">${submitLabel}</button>
  <p class="switch">${
    mode === "signin" ? "No account?" : "Already have one?"
  } <a href="${switchHref}">${switchLabel}</a></p>
</form></body></html>`;
}

function toDeepLink(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `hydralauncher://auth?payload=${encodeURIComponent(encoded)}`;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // --- Client-called JSON endpoints ---

  app.post("/auth/refresh", async (req, reply) => {
    const { refreshToken } = refreshBody.parse(req.body);
    const consumed = consumeRefreshToken(refreshToken);
    if (!consumed) return reply.status(401).send({ message: "Invalid refresh token" });
    const user = getUserById(consumed.userId);
    if (!user) return reply.status(401).send({ message: "User not found" });
    const accessToken = issueAccessToken(app, user.id, user.email, user.username);
    // Rotate the refresh token (issueRefreshToken creates a new row; the old one is already gone).
    const rotated = issueRefreshToken(user.id);
    return {
      accessToken,
      refreshToken: rotated.token,
      expiresIn: config.ACCESS_TOKEN_TTL,
    };
  });

  app.post("/auth/logout", async (_req, reply) => {
    // Refresh tokens are single-use, so we can't reliably invalidate here without
    // knowing which token was used. The client also drops its local copy. This
    // endpoint is fire-and-forget in the launcher.
    return reply.status(204).send();
  });

  app.post("/auth/payment", async (req, reply) => {
    // The client sends this before opening MAIN_VITE_CHECKOUT_URL. In a self-hosted
    // build there is no checkout — return a token that satisfies the shape but
    // isn't useful; the checkout URL should be a static "you already have
    // everything" page or 404 (safe: the URL only opens in an OS browser).
    const { refreshToken } = refreshBody.parse(req.body);
    const consumed = consumeRefreshToken(refreshToken);
    if (!consumed) return reply.status(401).send({ message: "Invalid refresh token" });
    const user = getUserById(consumed.userId);
    if (!user) return reply.status(401).send({ message: "User not found" });
    // Re-issue a rotated refresh so the client doesn't lose its session.
    issueRefreshToken(user.id);
    return {
      accessToken: issueAccessToken(app, user.id, user.email, user.username),
    };
  });

  app.post("/auth/realtime", async (req, reply) => {
    // Return the WS URL. The client will connect and the server will just idle
    // the connection — friend presence/notification pushes are not implemented,
    // but nothing breaks: the client falls back to polling.
    try { await req.jwtVerify(); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const wsUrl = config.publicUrl.replace(/^http/, "ws") + "/realtime";
    return { url: wsUrl, token: "selfhost-noop", expiresIn: 3600 };
  });

  // --- Direct JSON login/register (bypasses the browser flow) ---
  // Useful for the create-user CLI, tests, and any custom client that skips
  // the deep-link redirect. The browser HTML flow below wraps these.

  app.post("/auth/register", async (req, reply) => {
    if (!config.ALLOW_REGISTRATION) {
      return reply.status(403).send({ message: "Registration is disabled" });
    }
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: "Invalid payload",
        details: parsed.error.flatten(),
      });
    }
    const { email, username, displayName, password } = parsed.data;
    const now = Date.now();
    try {
      const id = newId();
      db.prepare(
        `INSERT INTO users (id, email, password_hash, username, display_name,
                            profile_visibility, bio, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PUBLIC', '', ?, ?)`
      ).run(
        id,
        email,
        await hashPassword(password),
        username,
        displayName ?? username,
        now,
        now
      );
      return authResponsePayload(app, { id, email, username });
    } catch (err: any) {
      if (String(err.message).includes("UNIQUE")) {
        return reply.status(409).send({ message: "Email or username already registered" });
      }
      throw err;
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid payload" });
    const { email, password } = parsed.data;
    const row = db
      .prepare(
        `SELECT id, email, username, password_hash AS passwordHash
         FROM users WHERE email = ?`
      )
      .get(email) as
      | { id: string; email: string; username: string; passwordHash: string }
      | undefined;
    if (!row || !(await verifyPassword(row.passwordHash, password))) {
      return reply.status(401).send({ message: "Invalid email or password" });
    }
    return authResponsePayload(app, row);
  });

  // --- Browser-hosted sign-in / sign-up pages ---
  // Opened by window-manager.ts via `${MAIN_VITE_AUTH_URL}${page}?...`. On
  // successful auth we redirect to the hydralauncher:// deep link so the OS
  // hands the payload back to the launcher.

  app.get("/auth/signin", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return renderAuthPage("signin");
  });

  app.get("/auth/signup", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return renderAuthPage("signup");
  });

  app.post("/auth/signin", async (req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    const form = req.body as Record<string, string>;
    const parsed = loginBody.safeParse(form);
    if (!parsed.success) return renderAuthPage("signin", "Invalid form input");
    const row = db
      .prepare(
        `SELECT id, email, username, password_hash AS passwordHash
         FROM users WHERE email = ?`
      )
      .get(parsed.data.email) as
      | { id: string; email: string; username: string; passwordHash: string }
      | undefined;
    if (!row || !(await verifyPassword(row.passwordHash, parsed.data.password))) {
      return renderAuthPage("signin", "Wrong email or password");
    }
    return reply.redirect(toDeepLink(authResponsePayload(app, row)));
  });

  app.post("/auth/signup", async (req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    if (!config.ALLOW_REGISTRATION) {
      return renderAuthPage("signup", "Registration is disabled on this server");
    }
    const form = req.body as Record<string, string>;
    const parsed = registerBody.safeParse(form);
    if (!parsed.success) {
      return renderAuthPage("signup", "Please check the form fields");
    }
    const now = Date.now();
    try {
      const id = newId();
      db.prepare(
        `INSERT INTO users (id, email, password_hash, username, display_name,
                            profile_visibility, bio, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PUBLIC', '', ?, ?)`
      ).run(
        id,
        parsed.data.email,
        await hashPassword(parsed.data.password),
        parsed.data.username,
        parsed.data.displayName ?? parsed.data.username,
        now,
        now
      );
      return reply.redirect(
        toDeepLink(
          authResponsePayload(app, {
            id,
            email: parsed.data.email,
            username: parsed.data.username,
          })
        )
      );
    } catch (err: any) {
      if (String(err.message).includes("UNIQUE")) {
        return renderAuthPage("signup", "That email or username is already taken");
      }
      throw err;
    }
  });
}
