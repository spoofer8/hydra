import type { FastifyInstance } from "fastify";
import { db } from "../lib/db.js";
import { authenticate } from "../lib/auth.js";
import { subscriptionPayload, userQuirks } from "../lib/subscription.js";

interface UserRow {
  id: string;
  email: string;
  username: string;
  displayName: string;
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
  bio: string;
  profileVisibility: string;
}

function loadUser(id: string): UserRow | null {
  return db
    .prepare(
      `SELECT id, email, username, display_name AS displayName,
              profile_image_url AS profileImageUrl,
              background_image_url AS backgroundImageUrl,
              bio, profile_visibility AS profileVisibility
       FROM users WHERE id = ?`
    )
    .get(id) as UserRow | undefined ?? null;
}

function userProfilePayload(u: UserRow, viewerId: string | null) {
  return {
    id: u.id,
    displayName: u.displayName,
    email: viewerId === u.id ? u.email : null,
    profileImageUrl: u.profileImageUrl,
    backgroundImageUrl: u.backgroundImageUrl,
    profileVisibility: u.profileVisibility,
    libraryGames: [],
    recentGames: [],
    friends: [],
    totalFriends: 0,
    relation: null,
    currentGame: null,
    bio: u.bio,
    hasActiveSubscription: true,
    karma: 0,
    quirks: userQuirks(),
    badges: [],
    badgesDetails: [],
    hasCompletedWrapped2025: false,
    subscription: subscriptionPayload(u as any),
  };
}

export async function registerUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    let viewerId: string | null = null;
    try {
      const decoded = await req.jwtVerify<{ sub: string }>();
      viewerId = decoded.sub;
    } catch { /* endpoint is public */ }

    const u = loadUser(userId);
    if (!u) return reply.status(404).send({ message: "User not found" });
    return userProfilePayload(u, viewerId);
  });

  app.get("/users/:userId/stats", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const libraryCount = (
      db.prepare("SELECT COUNT(*) AS c FROM library_games WHERE user_id = ?").get(userId) as any
    ).c ?? 0;
    const totalPlayTimeInMs = (
      db.prepare("SELECT COALESCE(SUM(playtime_ms),0) AS t FROM library_games WHERE user_id = ?").get(userId) as any
    ).t ?? 0;
    return {
      libraryCount,
      friendsCount: 0,
      totalPlayTimeInSeconds: {
        value: Math.floor(Number(totalPlayTimeInMs) / 1000),
        topPercentile: 100,
      },
      achievementsPointsEarnedSum: 0,
      unlockedAchievementSum: (
        db.prepare("SELECT COUNT(*) AS c FROM achievements WHERE user_id = ?").get(userId) as any
      ).c ?? 0,
    };
  });

  app.get("/users/:userId/library", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const query = req.query as { take?: string; skip?: string };
    const take = Math.min(100, Number(query.take ?? "100"));
    const skip = Number(query.skip ?? "0");
    const rows = db
      .prepare(
        `SELECT id, object_id AS objectId, shop, title, icon_url AS iconUrl,
                playtime_ms AS playtimeMs, last_played_at AS lastPlayedAtMs, favorite
         FROM library_games WHERE user_id = ?
         ORDER BY playtime_ms DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, take, skip) as any[];
    const library = rows.map((r) => ({
      id: r.id,
      objectId: r.objectId,
      shop: r.shop,
      title: r.title,
      iconUrl: r.iconUrl,
      libraryHeroImageUrl: null,
      libraryImageUrl: null,
      logoImageUrl: null,
      coverImageUrl: null,
      playTimeInMilliseconds: r.playtimeMs ?? 0,
      lastTimePlayed: r.lastPlayedAtMs ? new Date(r.lastPlayedAtMs).toISOString() : null,
      achievementCount: 0,
      unlockedAchievementCount: 0,
    }));
    return { library, pinnedGames: [] };
  });

  app.get("/users/:userId/friends", async (_req) => ({ totalFriends: 0, friends: [] }));

  app.get("/users/:userId/reviews", async (_req) => ({ reviews: [], totalCount: 0 }));

  app.post("/users/:userId/block", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return reply.status(204).send();
  });

  app.post("/users/:userId/unblock", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return reply.status(204).send();
  });

  // Friend-related endpoints — stubs (self-host defaults to no social features).
  app.get("/profile/friends", async () => ({ totalFriends: 0, onlineFriends: 0, friends: [] }));
  app.get("/profile/friends/search", async () => ({ friends: [] }));
  app.get("/profile/friend-requests", async () => []);
  app.post("/profile/friend-requests", async (_req, reply) => reply.status(204).send());
  app.patch("/profile/friend-requests/:userId", async (_req, reply) => reply.status(204).send());
  app.delete("/profile/friend-requests/:userId", async (_req, reply) => reply.status(204).send());
  app.get("/profile/blocks", async () => ({ totalBlocks: 0, blocks: [] }));

  // Notifications — stubs.
  app.get("/profile/notifications", async () => ({
    notifications: [],
    pagination: { total: 0, take: 20, skip: 0, hasMore: false },
  }));
  app.get("/profile/notifications/count", async () => ({ count: 0 }));
  app.patch("/profile/notifications/:id/read", async (_req, reply) => reply.status(204).send());
  app.patch("/profile/notifications/all/read", async (_req, reply) => reply.status(204).send());
  app.delete("/profile/notifications/:id", async (_req, reply) => reply.status(204).send());
  app.delete("/profile/notifications/all", async (_req, reply) => reply.status(204).send());
}
