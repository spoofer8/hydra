import type { FastifyInstance } from "fastify";

// The self-hosted server intentionally does NOT reimplement Hydra's game
// discovery / repack catalogue — that's a massive scraping operation and
// unrelated to the personal-backup use case this server exists for. All
// discovery endpoints return empty results, which the UI renders as an empty
// state. Users add games via Steam library import (which talks to Steam's
// public API directly, not our server) and configure their own download
// sources.
export async function registerCatalogueRoutes(app: FastifyInstance): Promise<void> {
  app.post("/catalogue/search", async () => ({ edges: [], count: 0 }));
  app.get("/catalogue/:category", async () => []);
  app.get("/catalogue/featured", async () => []);
  app.get("/catalogue/search/suggestions", async () => []);
  app.get("/catalogue/filters", async () => null);

  app.get("/games/:shop/:objectId/assets", async () => null);
  app.get("/games/:shop/:objectId", async () => null);
  app.get("/games/:shop/:objectId/stats", async () => ({
    downloadCount: 0,
    playerCount: 0,
    averageScore: null,
    reviewCount: 0,
  }));

  app.get("/games/:shop/:objectId/artwork/:kind", async (_req, reply) => {
    reply.header("x-hydra-cache", "fresh");
    return { success: true, data: [] };
  });

  app.post("/games/shop-details", async () => []);

  app.get("/games/:shop/:objectId/download-sources", async () => []);

  app.post("/games/:shop/:objectId/download", async (_req, reply) => reply.status(204).send());

  // Reviews — read endpoints return empty; write endpoints accept but discard.
  app.get("/games/:shop/:objectId/reviews/check", async () => ({ hasReviewed: false }));
  app.get("/games/:shop/:objectId/reviews", async () => ({ reviews: [], totalCount: 0 }));
  app.post("/games/:shop/:objectId/reviews", async (_req, reply) => reply.status(204).send());
  app.put("/games/:shop/:objectId/reviews/:reviewId/upvote", async () => ({ upvotes: 0, downvotes: 0 }));
  app.put("/games/:shop/:objectId/reviews/:reviewId/downvote", async () => ({ upvotes: 0, downvotes: 0 }));
  app.delete("/games/:shop/:objectId/reviews/:reviewId", async (_req, reply) => reply.status(204).send());
  app.get("/games/:shop/:objectId/reviews/:reviewId/answers", async () => ({ answers: [], totalCount: 0 }));
  app.post("/games/:shop/:objectId/reviews/:reviewId/answers", async (_req, reply) => reply.status(204).send());
  app.put("/games/:shop/:objectId/reviews/:reviewId/answers/:answerId/upvote", async () => ({ upvotes: 0, downvotes: 0 }));
  app.put("/games/:shop/:objectId/reviews/:reviewId/answers/:answerId/downvote", async () => ({ upvotes: 0, downvotes: 0 }));
  app.delete("/games/:shop/:objectId/reviews/:reviewId/answers/:answerId", async (_req, reply) => reply.status(204).send());
}
