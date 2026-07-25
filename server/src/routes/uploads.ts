import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { verifyUploadTicket } from "../lib/upload-signing.js";

const querySchema = z.object({ token: z.string() });

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  app.put("/uploads/put", async (req, reply) => {
    const { token } = querySchema.parse(req.query);
    const ticket = verifyUploadTicket(token);
    if (ticket.op !== "put") {
      return reply.status(403).send({ message: "Wrong ticket op" });
    }

    const rootDir = ticket.root === "assets" ? config.paths.assets : config.paths.saves;
    const target = path.resolve(rootDir, ticket.relativePath);
    const rootAbs = path.resolve(rootDir);
    if (!target.startsWith(rootAbs + path.sep)) {
      return reply.status(400).send({ message: "Invalid path" });
    }

    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared && declared > ticket.maxBytes) {
      return reply.status(413).send({ message: "File too large" });
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });

    const tmp = path.join(
      config.paths.tmp,
      `up-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    const out = fs.createWriteStream(tmp);
    let written = 0;
    try {
      for await (const chunk of req.raw) {
        written += chunk.length;
        if (written > ticket.maxBytes) throw new Error("File too large");
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
      });
      fs.renameSync(tmp, target);
    } catch (err) {
      out.destroy();
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
    return reply.status(200).send({ ok: true });
  });

  app.get("/uploads/get", async (req, reply) => {
    const { token } = querySchema.parse(req.query);
    const ticket = verifyUploadTicket(token);
    if (ticket.op !== "get") {
      return reply.status(403).send({ message: "Wrong ticket op" });
    }

    const rootDir = ticket.root === "assets" ? config.paths.assets : config.paths.saves;
    const target = path.resolve(rootDir, ticket.relativePath);
    const rootAbs = path.resolve(rootDir);
    if (!target.startsWith(rootAbs + path.sep)) {
      return reply.status(400).send({ message: "Invalid path" });
    }
    if (!fs.existsSync(target)) {
      return reply.status(404).send({ message: "Not found" });
    }
    const stat = fs.statSync(target);
    reply.header("Content-Type", ticket.contentType || "application/octet-stream");
    reply.header("Content-Length", stat.size);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${path.basename(target)}"`
    );
    return reply.send(fs.createReadStream(target));
  });
}
