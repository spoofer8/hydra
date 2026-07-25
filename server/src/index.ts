import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { runMigrations } from "./lib/db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerUsersRoutes } from "./routes/users.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerAchievementsRoutes } from "./routes/achievements.js";
import { registerCloudSaveRoutes } from "./routes/cloud-saves.js";
import { registerCatalogueRoutes } from "./routes/catalogue.js";
import { registerDownloadSourcesRoutes } from "./routes/download-sources.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerUploadRoutes } from "./routes/uploads.js";

runMigrations();

const app = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
  },
  bodyLimit: config.MAX_SAVE_UPLOAD_BYTES,
});

// Parse application/x-www-form-urlencoded so the hosted signin/signup pages
// can post their forms. Fastify's default JSON parser is registered too.
app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_req, body: any, done) => {
    try {
      const parsed = Object.fromEntries(new URLSearchParams(body).entries());
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  }
);

// Presigned uploads PUT raw bytes with arbitrary Content-Type headers
// (image/gif, application/tar, application/octet-stream, video/mp4, …).
// We stream the body straight to disk in the upload route via req.raw, so we
// don't want Fastify to buffer or parse it. The wildcard '*' parser catches
// any content-type not registered above and passes the stream through
// untouched.
app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

await app.register(cors, {
  origin: config.corsOrigins as any,
  credentials: true,
  exposedHeaders: ["Content-Disposition", "ETag", "x-hydra-cache"],
});

await app.register(jwt, { secret: config.JWT_SECRET });

await app.register(multipart, {
  limits: { fileSize: config.MAX_SAVE_UPLOAD_BYTES },
});

await app.register(fastifyStatic, {
  root: config.paths.assets,
  prefix: "/static/",
  decorateReply: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
});

app.get("/health", async () => ({ ok: true, version: "0.1.0" }));

await registerAuthRoutes(app);
await registerUploadRoutes(app);
await registerProfileRoutes(app);
await registerUsersRoutes(app);
await registerLibraryRoutes(app);
await registerAchievementsRoutes(app);
await registerCloudSaveRoutes(app);
await registerCatalogueRoutes(app);
await registerDownloadSourcesRoutes(app);
await registerMiscRoutes(app);
await registerRealtimeRoutes(app);

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  reply.status(status).send({
    error: err.name || "Error",
    message: err.message || "Internal server error",
  });
});

app
  .listen({ host: config.HOST, port: config.PORT })
  .then(() => {
    app.log.info(
      `hydra-selfhost-server ready on http://${config.HOST}:${config.PORT} (public: ${config.publicUrl})`
    );
  })
  .catch((err: unknown) => {
    app.log.error(err as Error);
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
