import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { db } from "../lib/db.js";
import { authenticate } from "../lib/auth.js";
import { subscriptionPayload, userQuirks } from "../lib/subscription.js";
import { assetUrl, removeAssetByUrl } from "../lib/storage.js";
import { buildPresignedPutUrl } from "../lib/upload-signing.js";
import { newId } from "../lib/ids.js";
import { config } from "../config.js";

// MIME types we accept for avatars + banners, INCLUDING animated formats.
// The client currently doesn't send Content-Type on the presigned PUT (it's
// derived from `file-type` locally), so we treat this as a whitelist of
// extensions we're willing to persist.
const IMAGE_EXT_ALLOW = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "apng", "mp4",
]);

function extMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "apng": return "image/apng";
    case "mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

function meResponse(user: {
  id: string;
  email: string;
  username: string;
  displayName: string;
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
  bio: string;
  profileVisibility: string;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    profileImageUrl: user.profileImageUrl,
    backgroundImageUrl: user.backgroundImageUrl,
    profileVisibility: user.profileVisibility,
    bio: user.bio,
    workwondersJwt: "",
    subscription: subscriptionPayload(user as any),
    karma: 0,
    quirks: userQuirks(),
  };
}

const patchBody = z
  .object({
    displayName: z.string().min(1).max(64).optional(),
    profileVisibility: z.enum(["PUBLIC", "PRIVATE", "FRIENDS"]).optional(),
    profileImageUrl: z.string().url().nullable().optional(),
    backgroundImageUrl: z.string().url().nullable().optional(),
    bio: z.string().max(2000).optional(),
    language: z.string().max(16).optional(),
  })
  .strict();

const presignedBody = z.object({
  imageExt: z.string().transform((s) => s.toLowerCase().replace(/^\./, "")),
  imageLength: z.number().int().positive(),
});

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profile/me", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }
    return meResponse(user);
  });

  app.patch("/profile", async (req, reply) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }

    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid payload", details: parsed.error.flatten() });
    }
    const patch = parsed.data;

    // If the client cleared an existing profile image, delete the underlying file.
    if ("profileImageUrl" in patch && patch.profileImageUrl !== user.profileImageUrl) {
      await removeAssetByUrl(user.profileImageUrl);
    }
    if ("backgroundImageUrl" in patch && patch.backgroundImageUrl !== user.backgroundImageUrl) {
      await removeAssetByUrl(user.backgroundImageUrl);
    }

    const now = Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined)       { fields.push("display_name = ?");         values.push(patch.displayName); }
    if (patch.profileVisibility !== undefined) { fields.push("profile_visibility = ?");   values.push(patch.profileVisibility); }
    if (patch.profileImageUrl !== undefined)   { fields.push("profile_image_url = ?");    values.push(patch.profileImageUrl); }
    if (patch.backgroundImageUrl !== undefined){ fields.push("background_image_url = ?"); values.push(patch.backgroundImageUrl); }
    if (patch.bio !== undefined)               { fields.push("bio = ?");                  values.push(patch.bio); }
    if (fields.length) {
      fields.push("updated_at = ?"); values.push(now);
      db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values, user.id);
    }

    // Return a UserProfile-shaped object (the client's update-profile handler
    // consumes the shape from `/users/:id`).
    const fresh = db
      .prepare(
        `SELECT id, email, username, display_name AS displayName,
                profile_image_url AS profileImageUrl,
                background_image_url AS backgroundImageUrl,
                bio, profile_visibility AS profileVisibility
         FROM users WHERE id = ?`
      )
      .get(user.id) as any;
    return {
      ...meResponse(fresh),
      hasActiveSubscription: true,
      libraryGames: [],
      recentGames: [],
      friends: [],
      totalFriends: 0,
      relation: null,
      currentGame: null,
      badges: [],
      badgesDetails: [],
      hasCompletedWrapped2025: false,
    };
  });

  const presignedHandler = (kind: "profile" | "background") => async (req: any, reply: any) => {
    let user;
    try { user = await authenticate(req); } catch { return reply.status(401).send({ message: "Unauthorized" }); }

    const parsed = presignedBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ message: "Invalid payload" });

    const { imageExt, imageLength } = parsed.data;
    if (!IMAGE_EXT_ALLOW.has(imageExt)) {
      return reply.status(415).send({ message: `Unsupported image extension: ${imageExt}` });
    }
    if (imageLength > config.MAX_ASSET_UPLOAD_BYTES) {
      return reply.status(413).send({ message: "File too large" });
    }

    const subdir = kind === "profile" ? "avatars" : "banners";
    const fileName = `${newId()}.${imageExt}`;
    const relativePath = path.posix.join(subdir, user.id, fileName);

    const presignedUrl = buildPresignedPutUrl({
      userId: user.id,
      relativePath,
      root: "assets",
      contentType: extMime(imageExt),
      maxBytes: imageLength,
    });
    const publicUrlValue = assetUrl(relativePath);

    return kind === "profile"
      ? { presignedUrl, profileImageUrl: publicUrlValue }
      : { presignedUrl, backgroundImageUrl: publicUrlValue };
  };

  app.post("/presigned-urls/profile-image", presignedHandler("profile"));
  app.post("/presigned-urls/background-image", presignedHandler("background"));
}
