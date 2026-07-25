import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../lib/auth.js";
import { newId } from "../lib/ids.js";

// Download sources in Hydra are lists of magnet/torrent URLs the launcher can
// pull game repacks from. The self-hosted server treats them as user-owned
// URL bookmarks — we accept whatever the client sends and echo it back. There
// is no crawling or fingerprinting.
export async function registerDownloadSourcesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/download-sources", async (req, reply) => {
    const body = z.object({ url: z.string().url() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    return {
      id: newId(),
      name: body.data.url,
      url: body.data.url,
      status: "active",
      downloadCount: 0,
      fingerprint: null,
      createdAt: new Date().toISOString(),
    };
  });

  app.post("/download-sources/sync", async (req, reply) => {
    const body = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    return [];
  });

  app.post("/download-sources/changes", async () => []);

  app.get("/profile/download-sources", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return [];
  });

  app.post("/profile/download-sources", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return reply.status(204).send();
  });

  app.delete("/profile/download-sources", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return reply.status(204).send();
  });
}
