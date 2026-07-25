import type { FastifyInstance } from "fastify";

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  // Feature flags — none enabled in self-host build. Anything gated by a flag
  // simply doesn't appear; the app still boots.
  app.get("/features", async () => []);

  // Profile badges — none in self-host. Client just doesn't render badge chips.
  app.get("/badges", async () => []);

  // Steam Deck plugin — point to a version that indicates "not available".
  // The client polls this; returning 404 avoids the OS-notification spam that
  // a bogus version would trigger.
  app.get("/decky/release", async (_req, reply) =>
    reply.status(404).send({ message: "Decky plugin distribution is not provided by the self-host server" })
  );
}
