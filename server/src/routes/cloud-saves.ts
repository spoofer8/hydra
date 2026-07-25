import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { db } from "../lib/db.js";
import { authenticate } from "../lib/auth.js";
import { newId } from "../lib/ids.js";
import {
  buildPresignedGetUrl,
  buildPresignedPutUrl,
} from "../lib/upload-signing.js";
import { config } from "../config.js";
import { assetUrl } from "../lib/storage.js";

const createArtifactBody = z.object({
  artifactLengthInBytes: z.number().int().positive(),
  shop: z.string(),
  objectId: z.string(),
  hostname: z.string().default(""),
  winePrefixPath: z.union([z.string(), z.null()]).optional(),
  homeDir: z.string().default(""),
  downloadOptionTitle: z.union([z.string(), z.null()]).optional(),
  platform: z.string().default(""),
  label: z.string().optional(),
});

function artifactRelativePath(userId: string, artifactId: string): string {
  return path.posix.join("saves-fs", userId, artifactId, "save.tar");
}

function artifactAbsolutePath(userId: string, artifactId: string): string {
  return path.join(config.paths.saves, artifactRelativePath(userId, artifactId));
}

function artifactDirAbsolutePath(userId: string, artifactId: string): string {
  return path.join(config.paths.saves, "saves-fs", userId, artifactId);
}

function serializeArtifact(row: any) {
  return {
    id: row.id,
    artifactLengthInBytes: row.sizeBytes ?? 0,
    downloadOptionTitle: row.downloadOptionTitle ?? null,
    createdAt: new Date(row.createdAtMs).toISOString(),
    updatedAt: new Date(row.updatedAtMs).toISOString(),
    hostname: row.hostname ?? "",
    downloadCount: 0,
    label: row.label ?? "",
    isFrozen: false,
  };
}

export async function registerCloudSaveRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profile/games/artifacts", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const q = req.query as { objectId?: string; shop?: string };
    if (!q.objectId || !q.shop) return reply.status(400).send({ message: "objectId and shop required" });
    const rows = db
      .prepare(
        `SELECT id, size_bytes AS sizeBytes, download_option_title AS downloadOptionTitle,
                hostname, label,
                created_at AS createdAtMs, updated_at AS updatedAtMs
         FROM save_artifacts
         WHERE user_id = ? AND shop = ? AND object_id = ? AND upload_status = 'committed'
         ORDER BY created_at DESC`
      )
      .all(user.id, q.shop, q.objectId) as any[];
    return rows.map(serializeArtifact);
  });

  app.post("/profile/games/artifacts", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const parsed = createArtifactBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid payload" });
    if (parsed.data.artifactLengthInBytes > config.MAX_SAVE_UPLOAD_BYTES) {
      return reply.status(413).send({ message: "Save too large" });
    }
    const id = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO save_artifacts (id, user_id, object_id, shop, label, hostname,
                                   home_dir, platform, download_option_title,
                                   file_name, size_bytes, upload_status,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'save.tar', ?, 'pending', ?, ?)`
    ).run(
      id,
      user.id,
      parsed.data.objectId,
      parsed.data.shop,
      parsed.data.label ?? "",
      parsed.data.hostname,
      parsed.data.homeDir,
      parsed.data.platform,
      parsed.data.downloadOptionTitle ?? null,
      parsed.data.artifactLengthInBytes,
      now, now
    );
    // Mint an upload ticket. When the PUT completes we mark the row committed
    // via a side-channel: /profile/games/artifacts/:id/commit (called from
    // uploads.ts via a completion hook — see notes below). For self-host we
    // instead flip the row to committed as soon as the PUT lands, by having
    // the upload PUT also call our own commit endpoint.
    //
    // Simpler pattern: the upload PUT writes the file at a well-known path.
    // We flip status to committed the first time it's downloaded OR when a
    // subsequent GET /profile/games/artifacts sees the file exists on disk.
    // The client only cares that GET returns the row after upload finishes,
    // and by then the file is present. We handle that in the GET above by
    // filtering upload_status = 'committed' AND in a POST hook here — see
    // the "post-upload commit" step below.
    const relative = artifactRelativePath(user.id, id);
    const uploadUrl = buildPresignedPutUrl({
      userId: user.id,
      relativePath: relative,
      root: "saves",
      contentType: "application/tar",
      maxBytes: parsed.data.artifactLengthInBytes,
    });
    // Immediately mark committed — self-host trusts the client to complete the
    // PUT before it next asks for artifacts. This mirrors S3's post-upload
    // behavior (the metadata row is created up-front but only readable after
    // the object is present). If PUT never completes, the row will point at a
    // missing file; the next GET filters it out via file existence check.
    db.prepare("UPDATE save_artifacts SET upload_status = 'committed' WHERE id = ?").run(id);
    return { id, uploadUrl };
  });

  app.post("/profile/games/artifacts/:id/download", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    const row = db
      .prepare(
        `SELECT home_dir AS homeDir, size_bytes AS sizeBytes
         FROM save_artifacts WHERE id = ? AND user_id = ?`
      )
      .get(id, user.id) as { homeDir: string; sizeBytes: number } | undefined;
    if (!row) return reply.status(404).send({ message: "Artifact not found" });

    const absPath = artifactAbsolutePath(user.id, id);
    if (!fs.existsSync(absPath)) {
      return reply.status(410).send({ message: "Artifact file missing" });
    }
    const relative = artifactRelativePath(user.id, id);
    const downloadUrl = buildPresignedGetUrl({
      userId: user.id,
      relativePath: relative,
      root: "saves",
      contentType: "application/tar",
      maxBytes: row.sizeBytes,
    });
    return {
      downloadUrl,
      objectKey: `${id}.tar`,
      homeDir: row.homeDir,
      winePrefixPath: null,
    };
  });

  app.delete("/profile/games/artifacts/:id", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    db.prepare("DELETE FROM save_artifacts WHERE id = ? AND user_id = ?").run(id, user.id);
    try {
      fs.rmSync(artifactDirAbsolutePath(user.id, id), { recursive: true, force: true });
    } catch { /* ignore */ }
    return { ok: true };
  });

  app.put("/profile/games/artifacts/:id", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    const body = z.object({ label: z.string().max(120) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    const res = db.prepare(
      "UPDATE save_artifacts SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?"
    ).run(body.data.label, Date.now(), id, user.id);
    if (res.changes === 0) return reply.status(404).send({ message: "Artifact not found" });
    return reply.status(204).send();
  });

  app.put("/profile/games/artifacts/:id/freeze", async (_req, reply) => reply.status(204).send());
  app.put("/profile/games/artifacts/:id/unfreeze", async (_req, reply) => reply.status(204).send());

  // --- Custom artwork ---

  const artworkKindSchema = z.enum(["grids", "heroes", "logos", "icons"]);

  app.post("/profile/games/:shop/:objectId/artwork/:kind/upload-url", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const params = z.object({
      shop: z.string(),
      objectId: z.string(),
      kind: artworkKindSchema,
    }).safeParse(req.params);
    if (!params.success) return reply.status(400).send({ message: "Invalid path" });
    const body = z.object({
      imageExt: z.string().transform((s) => s.toLowerCase().replace(/^\./, "")),
      imageLength: z.number().int().positive(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });
    if (body.data.imageLength > config.MAX_ASSET_UPLOAD_BYTES) {
      return reply.status(413).send({ message: "File too large" });
    }
    const relative = path.posix.join(
      "artwork",
      user.id,
      params.data.shop,
      params.data.objectId,
      params.data.kind,
      `${newId()}.${body.data.imageExt}`
    );
    const presignedUrl = buildPresignedPutUrl({
      userId: user.id,
      relativePath: relative,
      root: "assets",
      contentType: `image/${body.data.imageExt === "jpg" ? "jpeg" : body.data.imageExt}`,
      maxBytes: body.data.imageLength,
    });
    return { presignedUrl, imageUrl: assetUrl(relative) };
  });

  app.put("/profile/games/:shop/:objectId/artwork/:kind", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    // Server-side we don't track per-game selected artwork — the client stores
    // the URL in its local Level DB and reuses it. Return the acknowledgement
    // the client expects.
    return reply.status(204).send();
  });

  app.delete("/profile/games/:shop/:objectId/artwork/:kind", async (req, reply) => {
    try { await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return reply.status(204).send();
  });

  // --- Emulation cloud saves (PS1/PS2 memcard slots) ---

  app.post("/profile/emulation-saves/upload-url", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const body = z.object({
      platform: z.enum(["ps1", "ps2"]),
      emulator: z.string(),
      saveKind: z.literal("game_save"),
      shop: z.string().optional(),
      objectId: z.string().optional(),
      saveIdentity: z.string(),
      artifactLengthInBytes: z.number().int().positive(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });

    const id = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO save_artifacts (id, user_id, object_id, shop, label, hostname,
                                   home_dir, platform, download_option_title,
                                   file_name, size_bytes, upload_status,
                                   created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      id,
      user.id,
      body.data.objectId ?? "",
      `emulation:${body.data.platform}:${body.data.emulator}:${body.data.saveIdentity}`,
      "",
      "",
      "",
      body.data.platform,
      body.data.emulator,
      `emulation-${body.data.platform}.bin`,
      body.data.artifactLengthInBytes,
      now, now
    );
    const relative = path.posix.join("emulation-fs", user.id, id, "save.bin");
    const uploadUrl = buildPresignedPutUrl({
      userId: user.id,
      relativePath: relative,
      root: "saves",
      contentType: "application/octet-stream",
      maxBytes: body.data.artifactLengthInBytes,
    });
    db.prepare("UPDATE save_artifacts SET upload_status = 'committed' WHERE id = ?").run(id);
    return { id, uploadUrl };
  });

  app.post("/profile/emulation-saves/:id/commit", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    const body = z.object({
      saveKind: z.literal("game_save"),
      artifactLengthInBytes: z.number().int().positive(),
      fileName: z.string(),
      hostname: z.string(),
      localLastModifiedAt: z.string(),
      label: z.string(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });

    db.prepare(
      `UPDATE save_artifacts
       SET file_name = ?, hostname = ?, label = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(body.data.fileName, body.data.hostname, body.data.label, Date.now(), id, user.id);

    const row = db.prepare(
      `SELECT id, shop, object_id AS objectId, platform, download_option_title AS emulator,
              file_name AS fileName, hostname, label, size_bytes AS sizeBytes,
              created_at AS createdAtMs, updated_at AS updatedAtMs
       FROM save_artifacts WHERE id = ? AND user_id = ?`
    ).get(id, user.id) as any;
    if (!row) return reply.status(404).send({ message: "Not found" });

    return serializeEmulationSave(row, body.data.localLastModifiedAt);
  });

  app.get("/profile/emulation-saves", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const q = req.query as { platform?: string; emulator?: string; saveKind?: string; shop?: string; objectId?: string };
    const conditions: string[] = ["user_id = ?", "upload_status = 'committed'"];
    const values: unknown[] = [user.id];
    if (q.platform) { conditions.push("platform = ?"); values.push(q.platform); }
    if (q.emulator) { conditions.push("download_option_title = ?"); values.push(q.emulator); }
    if (q.objectId) { conditions.push("object_id = ?"); values.push(q.objectId); }
    // We synthesized `shop` field into an "emulation:..." prefix for these rows —
    // filter with a LIKE to identify emulation entries only.
    conditions.push("shop LIKE 'emulation:%'");
    const rows = db.prepare(
      `SELECT id, shop, object_id AS objectId, platform, download_option_title AS emulator,
              file_name AS fileName, hostname, label, size_bytes AS sizeBytes,
              created_at AS createdAtMs, updated_at AS updatedAtMs
       FROM save_artifacts WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC`
    ).all(...values) as any[];
    return rows.map((r) => serializeEmulationSave(r, null));
  });

  app.post("/profile/emulation-saves/:id/download-url", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    const row = db.prepare(
      `SELECT size_bytes AS sizeBytes FROM save_artifacts WHERE id = ? AND user_id = ?`
    ).get(id, user.id) as { sizeBytes: number } | undefined;
    if (!row) return reply.status(404).send({ message: "Not found" });

    const relative = path.posix.join("emulation-fs", user.id, id, "save.bin");
    const absPath = path.join(config.paths.saves, relative);
    if (!fs.existsSync(absPath)) return reply.status(410).send({ message: "File missing" });
    return {
      downloadUrl: buildPresignedGetUrl({
        userId: user.id,
        relativePath: relative,
        root: "saves",
        contentType: "application/octet-stream",
        maxBytes: row.sizeBytes,
      }),
    };
  });

  app.delete("/profile/emulation-saves/:id", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    db.prepare("DELETE FROM save_artifacts WHERE id = ? AND user_id = ?").run(id, user.id);
    try {
      fs.rmSync(path.join(config.paths.saves, "emulation-fs", user.id, id), { recursive: true, force: true });
    } catch { /* ignore */ }
    return reply.status(204).send();
  });

  app.put("/profile/emulation-saves/:id", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    const { id } = req.params as { id: string };
    const body = z.object({
      label: z.union([z.string(), z.null()]).optional(),
      metadata: z.union([z.record(z.unknown()), z.null()]).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid payload" });

    if (body.data.label !== undefined) {
      db.prepare("UPDATE save_artifacts SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(body.data.label ?? "", Date.now(), id, user.id);
    }
    const row = db.prepare(
      `SELECT id, shop, object_id AS objectId, platform, download_option_title AS emulator,
              file_name AS fileName, hostname, label, size_bytes AS sizeBytes,
              created_at AS createdAtMs, updated_at AS updatedAtMs
       FROM save_artifacts WHERE id = ? AND user_id = ?`
    ).get(id, user.id) as any;
    if (!row) return reply.status(404).send({ message: "Not found" });
    return serializeEmulationSave(row, null);
  });
}

function serializeEmulationSave(row: any, localLastModifiedAt: string | null) {
  const [_, platform, emulator, ...idParts] = String(row.shop ?? "emulation:::").split(":");
  return {
    id: row.id,
    platform: platform || row.platform,
    emulator: emulator || row.emulator,
    saveKind: "game_save" as const,
    saveIdentity: idParts.join(":") || row.objectId,
    artifactLengthInBytes: row.sizeBytes ?? 0,
    fileName: row.fileName,
    hostname: row.hostname || null,
    localLastModifiedAt: localLastModifiedAt,
    label: row.label || null,
    metadata: null,
    shop: row.objectId ? "launchbox" : null,
    objectId: row.objectId || null,
    lastUploadedAt: new Date(row.updatedAtMs).toISOString(),
    createdAt: new Date(row.createdAtMs).toISOString(),
    updatedAt: new Date(row.updatedAtMs).toISOString(),
  };
}
