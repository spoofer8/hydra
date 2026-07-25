import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../lib/db.js";
import { authenticate } from "../lib/auth.js";
import { newId } from "../lib/ids.js";

const putAchievementsBody = z.object({
  id: z.string().min(1),
  achievements: z.array(
    z.object({
      name: z.string(),
      unlockTime: z.number().int().min(0),
      hardcoreUnlockTime: z.union([z.number(), z.null()]).optional(),
    })
  ),
});

interface LibraryRow { userId: string; shop: string; objectId: string }

function findLibraryGameByRemoteId(remoteId: string): LibraryRow | null {
  const row = db
    .prepare(
      `SELECT user_id AS userId, shop, object_id AS objectId
       FROM library_games WHERE id = ?`
    )
    .get(remoteId) as LibraryRow | undefined;
  return row ?? null;
}

export async function registerAchievementsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/games/:shop/:objectId/achievements", async (req, reply) => {
    // Catalog of achievement definitions. The self-hosted server doesn't have
    // Steam's data — return an empty catalog. The client falls back to whatever
    // it discovered locally (Steam schema.json in the install folder) so
    // unlocked achievements still show up in the launcher; only the pretty
    // titles/descriptions from the catalog are missing.
    reply.header("ETag", '"empty"');
    reply.header("Cache-Control", "public, max-age=3600");
    if (req.headers["if-none-match"] === '"empty"') {
      return reply.status(304).send();
    }
    return [];
  });

  app.put("/profile/games/achievements", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }

    const parsed = putAchievementsBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid payload" });

    const game = findLibraryGameByRemoteId(parsed.data.id);
    if (!game || game.userId !== user.id) {
      return reply.status(404).send({ message: "game/not-found" });
    }

    const insert = db.prepare(
      `INSERT INTO achievements (id, user_id, object_id, shop, achievement_name,
                                 unlocked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, shop, object_id, achievement_name)
       DO UPDATE SET unlocked_at = MIN(unlocked_at, excluded.unlocked_at)`
    );
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const a of parsed.data.achievements) {
        insert.run(newId(), user!.id, game.objectId, game.shop, a.name, a.unlockTime, now);
      }
    });
    tx();

    const rows = db
      .prepare(
        `SELECT achievement_name AS name, unlocked_at AS unlockTime
         FROM achievements WHERE user_id = ? AND shop = ? AND object_id = ?`
      )
      .all(user.id, game.shop, game.objectId) as { name: string; unlockTime: number }[];
    return {
      objectId: game.objectId,
      shop: game.shop,
      achievements: rows,
    };
  });

  app.delete("/profile/games/achievements/:gameRemoteId", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { gameRemoteId } = req.params as { gameRemoteId: string };
    const game = findLibraryGameByRemoteId(gameRemoteId);
    if (!game || game.userId !== user.id) {
      return reply.status(404).send({ message: "game/not-found" });
    }
    db.prepare(
      "DELETE FROM achievements WHERE user_id = ? AND shop = ? AND object_id = ?"
    ).run(user.id, game.shop, game.objectId);
    return reply.status(204).send();
  });

  app.get("/users/:userId/games/achievements/compare", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const q = req.query as { shop: string; objectId: string };

    let ownerId: string | null = null;
    try {
      const decoded = await req.jwtVerify<{ sub: string }>();
      ownerId = decoded.sub;
    } catch { /* comparison is public-ish, but owner section will be empty */ }

    if (!q.shop || !q.objectId) {
      return reply.status(400).send({ message: "shop and objectId are required" });
    }

    const targetRows = db
      .prepare(
        `SELECT achievement_name AS name, unlocked_at AS unlockTime
         FROM achievements WHERE user_id = ? AND shop = ? AND object_id = ?`
      )
      .all(userId, q.shop, q.objectId) as { name: string; unlockTime: number }[];
    const ownerRows = ownerId
      ? db
          .prepare(
            `SELECT achievement_name AS name, unlocked_at AS unlockTime
             FROM achievements WHERE user_id = ? AND shop = ? AND object_id = ?`
          )
          .all(ownerId, q.shop, q.objectId) as { name: string; unlockTime: number }[]
      : [];
    const target = db.prepare(
      "SELECT display_name AS displayName, profile_image_url AS profileImageUrl FROM users WHERE id = ?"
    ).get(userId) as { displayName: string; profileImageUrl: string | null } | undefined;

    const names = new Set<string>([...ownerRows, ...targetRows].map((r) => r.name));
    const merged = Array.from(names).map((name) => {
      const t = targetRows.find((r) => r.name === name);
      const o = ownerRows.find((r) => r.name === name);
      return {
        hidden: false,
        icon: null,
        displayName: name,
        description: "",
        ownerStat: o
          ? { unlocked: true, unlockTime: o.unlockTime }
          : { unlocked: false, unlockTime: null },
        targetStat: t
          ? { unlocked: true, unlockTime: t.unlockTime }
          : { unlocked: false, unlockTime: null },
      };
    });

    return {
      achievementsPointsTotal: 0,
      owner: {
        totalAchievementCount: merged.length,
        unlockedAchievementCount: ownerRows.length,
        achievementsPointsEarnedSum: 0,
      },
      target: {
        displayName: target?.displayName ?? "Unknown",
        profileImageUrl: target?.profileImageUrl ?? null,
        totalAchievementCount: merged.length,
        unlockedAchievementCount: targetRows.length,
        achievementsPointsEarnedSum: 0,
      },
      achievements: merged,
    };
  });

  // RetroAchievements integration — not supported in self-host build.
  app.get("/profile/integrations/retroachievements", async () => ({ connected: false }));
  app.post("/profile/integrations/retroachievements/connect", async (_req, reply) =>
    reply.status(501).send({ message: "RetroAchievements integration is not available in self-host mode" })
  );
  app.delete("/profile/integrations/retroachievements", async (_req, reply) => reply.status(204).send());
  app.post("/profile/games/:shop/:objectId/retroachievements/sync", async (_req, reply) => reply.status(204).send());
}
