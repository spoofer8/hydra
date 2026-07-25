import argon2 from "argon2";
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "./db.js";
import { newId, newToken } from "./ids.js";

export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
}

export interface AuthedUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
  bio: string;
  profileVisibility: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueRefreshToken(userId: string): { token: string; id: string; expiresAt: number } {
  const token = newToken();
  const id = newId();
  const expiresAt = Date.now() + config.REFRESH_TOKEN_TTL * 1000;
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, hashToken(token), expiresAt, Date.now());
  return { token, id, expiresAt };
}

export function consumeRefreshToken(token: string): { userId: string } | null {
  const row = db
    .prepare(
      `SELECT id, user_id AS userId, expires_at AS expiresAt
       FROM refresh_tokens WHERE token_hash = ?`
    )
    .get(hashToken(token)) as { id: string; userId: string; expiresAt: number } | undefined;
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(row.id);
    return null;
  }
  db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(row.id);
  return { userId: row.userId };
}

export function getUserById(id: string): AuthedUser | null {
  const row = db
    .prepare(
      `SELECT id, email, username, display_name AS displayName,
              profile_image_url AS profileImageUrl,
              background_image_url AS backgroundImageUrl,
              bio, profile_visibility AS profileVisibility
       FROM users WHERE id = ?`
    )
    .get(id) as AuthedUser | undefined;
  return row ?? null;
}

export async function authenticate(req: FastifyRequest): Promise<AuthedUser> {
  const decoded = await req.jwtVerify<JwtPayload>();
  const user = getUserById(decoded.sub);
  if (!user) {
    const err = new Error("User not found") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return user;
}
