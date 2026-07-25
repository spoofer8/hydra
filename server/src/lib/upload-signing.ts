import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export interface UploadTicket {
  userId: string;
  relativePath: string;   // path under DATA_DIR/assets or DATA_DIR/saves
  root: "assets" | "saves";
  contentType: string;
  maxBytes: number;
  exp: number;            // unix seconds
  op: "put" | "get";
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string): string {
  return b64url(
    createHmac("sha256", config.JWT_SECRET).update(payload).digest()
  );
}

export function mintUploadTicket(
  ticket: Omit<UploadTicket, "exp"> & { ttlSeconds?: number }
): string {
  const full: UploadTicket = {
    userId: ticket.userId,
    relativePath: ticket.relativePath,
    root: ticket.root,
    contentType: ticket.contentType,
    maxBytes: ticket.maxBytes,
    op: ticket.op,
    exp: Math.floor(Date.now() / 1000) + (ticket.ttlSeconds ?? 900),
  };
  const payload = b64url(Buffer.from(JSON.stringify(full)));
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyUploadTicket(token: string): UploadTicket {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Malformed upload ticket");

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid upload ticket signature");
  }

  const ticket: UploadTicket = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  );
  if (ticket.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Upload ticket expired");
  }
  return ticket;
}

export function buildPresignedPutUrl(ticket: Omit<UploadTicket, "exp" | "op">): string {
  const token = mintUploadTicket({ ...ticket, op: "put" });
  return `${config.publicUrl}/uploads/put?token=${encodeURIComponent(token)}`;
}

export function buildPresignedGetUrl(ticket: Omit<UploadTicket, "exp" | "op">): string {
  const token = mintUploadTicket({ ...ticket, op: "get" });
  return `${config.publicUrl}/uploads/get?token=${encodeURIComponent(token)}`;
}
