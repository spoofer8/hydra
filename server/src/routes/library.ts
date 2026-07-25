import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../lib/db.js";
import { authenticate } from "../lib/auth.js";
import { newId } from "../lib/ids.js";

const shopSchema = z.enum(["steam", "launchbox", "epic", "gog", "custom"]).or(z.string());

const createGameBody = z.object({
  objectId: z.string().min(1),
  shop: shopSchema,
  playTimeInMilliseconds: z.number().int().min(0),
  lastTimePlayed: z.union([z.string(), z.null()]).optional(),
});

const batchGameBody = z.array(
  z.object({
    objectId: z.string(),
    shop: shopSchema,
    playTimeInMilliseconds: z.number().int().min(0),
    lastTimePlayed: z.union([z.string(), z.null()]).optional(),
    isFavorite: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  })
);

function upsertGame(
  userId: string,
  input: {
    objectId: string;
    shop: string;
    playTimeInMilliseconds: number;
    lastTimePlayed?: string | null;
    title?: string;
    isFavorite?: boolean;
  }
): { id: string; createdAt: string } {
  const existing = db
    .prepare(
      `SELECT id, created_at AS createdAtMs FROM library_games
       WHERE user_id = ? AND shop = ? AND object_id = ?`
    )
    .get(userId, input.shop, input.objectId) as { id: string; createdAtMs: number } | undefined;

  const now = Date.now();
  const lastPlayedMs = input.lastTimePlayed ? new Date(input.lastTimePlayed).getTime() : null;

  if (existing) {
    db.prepare(
      `UPDATE library_games
       SET playtime_ms = ?, last_played_at = ?, updated_at = ?, favorite = COALESCE(?, favorite)
       WHERE id = ?`
    ).run(
      input.playTimeInMilliseconds,
      lastPlayedMs,
      now,
      input.isFavorite === undefined ? null : input.isFavorite ? 1 : 0,
      existing.id
    );
    return {
      id: existing.id,
      createdAt: new Date(existing.createdAtMs).toISOString(),
    };
  }
  const id = newId();
  db.prepare(
    `INSERT INTO library_games (id, user_id, object_id, shop, title,
                                playtime_ms, last_played_at, favorite,
                                created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    input.objectId,
    input.shop,
    input.title ?? "",
    input.playTimeInMilliseconds,
    lastPlayedMs,
    input.isFavorite ? 1 : 0,
    now,
    now
  );
  return { id, createdAt: new Date(now).toISOString() };
}

function toProfileGame(row: any) {
  return {
    id: row.id,
    objectId: row.objectId,
    shop: row.shop,
    title: row.title,
    iconUrl: row.iconUrl,
    libraryHeroImageUrl: null,
    libraryImageUrl: null,
    logoImageUrl: null,
    coverImageUrl: null,
    playTimeInMilliseconds: row.playtimeMs ?? 0,
    lastTimePlayed: row.lastPlayedAtMs ? new Date(row.lastPlayedAtMs).toISOString() : null,
    hasManuallyUpdatedPlaytime: false,
    isFavorite: !!row.favorite,
    isPinned: false,
    achievementCount: 0,
    unlockedAchievementCount: 0,
    createdAt: new Date(row.createdAtMs).toISOString(),
    collectionIds: [],
  };
}

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/profile/games", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const parsed = createGameBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid payload" });
    const result = upsertGame(user.id, parsed.data);
    return {
      id: result.id,
      playTimeInMilliseconds: parsed.data.playTimeInMilliseconds,
      lastTimePlayed: parsed.data.lastTimePlayed ?? null,
      createdAt: result.createdAt,
    };
  });

  app.post("/profile/games/batch", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const parsed = batchGameBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid payload" });
    const tx = db.transaction((rows: typeof parsed.data) => {
      for (const row of rows) upsertGame(user!.id, row);
    });
    tx(parsed.data);
    return { count: parsed.data.length };
  });

  app.get("/profile/games", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const q = req.query as { take?: string; skip?: string; shop?: string };
    const take = Math.min(200, Number(q.take ?? "100"));
    const skip = Number(q.skip ?? "0");
    const rows = q.shop
      ? db.prepare(
          `SELECT id, object_id AS objectId, shop, title, icon_url AS iconUrl,
                  playtime_ms AS playtimeMs, last_played_at AS lastPlayedAtMs,
                  favorite, created_at AS createdAtMs
           FROM library_games WHERE user_id = ? AND shop = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(user.id, q.shop, take, skip)
      : db.prepare(
          `SELECT id, object_id AS objectId, shop, title, icon_url AS iconUrl,
                  playtime_ms AS playtimeMs, last_played_at AS lastPlayedAtMs,
                  favorite, created_at AS createdAtMs
           FROM library_games WHERE user_id = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(user.id, take, skip);
    return (rows as any[]).map(toProfileGame);
  });

  app.put("/profile/games/:shop/:objectId", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { shop, objectId } = req.params as { shop: string; objectId: string };
    const body = z.object({
      playTimeDeltaInSeconds: z.number(),
      lastTimePlayed: z.union([z.string(), z.null()]).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    const lastMs = body.data.lastTimePlayed ? new Date(body.data.lastTimePlayed).getTime() : null;
    const result = db.prepare(
      `UPDATE library_games
       SET playtime_ms = playtime_ms + ?, last_played_at = COALESCE(?, last_played_at),
           updated_at = ?
       WHERE user_id = ? AND shop = ? AND object_id = ?`
    ).run(
      Math.floor(body.data.playTimeDeltaInSeconds * 1000),
      lastMs,
      Date.now(),
      user.id, shop, objectId
    );
    if (result.changes === 0) {
      return reply.status(404).send({ message: "game/not-found" });
    }
    return reply.status(204).send();
  });

  app.put("/profile/games/:shop/:objectId/playtime", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { shop, objectId } = req.params as { shop: string; objectId: string };
    const body = z.object({ playTimeInSeconds: z.number().min(0) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    const result = db.prepare(
      `UPDATE library_games SET playtime_ms = ?, updated_at = ?
       WHERE user_id = ? AND shop = ? AND object_id = ?`
    ).run(Math.floor(body.data.playTimeInSeconds * 1000), Date.now(), user.id, shop, objectId);
    if (result.changes === 0) return reply.status(404).send({ message: "game/not-found" });
    return reply.status(204).send();
  });

  app.delete("/profile/games/:shop/:objectId/playtime", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { shop, objectId } = req.params as { shop: string; objectId: string };
    db.prepare(
      `UPDATE library_games SET playtime_ms = 0, last_played_at = NULL, updated_at = ?
       WHERE user_id = ? AND shop = ? AND object_id = ?`
    ).run(Date.now(), user.id, shop, objectId);
    return reply.status(204).send();
  });

  app.delete("/profile/games/:remoteId", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { remoteId } = req.params as { remoteId: string };
    db.prepare("DELETE FROM library_games WHERE id = ? AND user_id = ?").run(remoteId, user.id);
    return reply.status(204).send();
  });

  app.put("/profile/games/:shop/:objectId/favorite", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { shop, objectId } = req.params as { shop: string; objectId: string };
    db.prepare(
      `UPDATE library_games SET favorite = 1, updated_at = ?
       WHERE user_id = ? AND shop = ? AND object_id = ?`
    ).run(Date.now(), user.id, shop, objectId);
    return reply.status(204).send();
  });

  app.put("/profile/games/:shop/:objectId/unfavorite", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { shop, objectId } = req.params as { shop: string; objectId: string };
    db.prepare(
      `UPDATE library_games SET favorite = 0, updated_at = ?
       WHERE user_id = ? AND shop = ? AND object_id = ?`
    ).run(Date.now(), user.id, shop, objectId);
    return reply.status(204).send();
  });

  app.put("/profile/games/:shop/:objectId/pin", async (_req, reply) => reply.status(204).send());
  app.put("/profile/games/:shop/:objectId/unpin", async (_req, reply) => reply.status(204).send());
  app.put("/profile/games/:shop/:objectId/collection", async (_req, reply) => reply.status(204).send());

  // Collections — minimal in-memory table via a JSON column would be nicer, but for
  // MVP we skip real collection storage. UI still works (empty list).
  app.get("/profile/games/collections", async () => []);
  app.post("/profile/games/collections", async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    return { id: newId(), name: body.data.name, gamesCount: 0 };
  });
  app.put("/profile/games/collections/:collectionId", async (_req, reply) => reply.status(204).send());
  app.delete("/profile/games/collections/:collectionId", async (_req, reply) => reply.status(204).send());
}
