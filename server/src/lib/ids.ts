import { randomBytes, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function newToken(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}
