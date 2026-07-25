import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";

// Minimal WebSocket endpoint. The launcher's realtime client expects to
// connect after calling POST /auth/realtime; we accept the connection and
// keep it open with periodic pings, but never push friend-presence or
// notification events (those features are inert in self-host mode). The
// client already falls back to polling when nothing arrives.
export async function registerRealtimeRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket);
  app.get("/realtime", { websocket: true }, (socket) => {
    const ping = setInterval(() => {
      try { socket.send(JSON.stringify({ v: 1, event: "ping", publishedAt: Date.now() })); }
      catch { /* connection likely closed */ }
    }, 30_000);
    socket.on("close", () => clearInterval(ping));
    socket.on("message", () => { /* nothing to do */ });
  });
}
