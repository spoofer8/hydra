import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export function assetUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "");
  return `${config.publicUrl}/static/${clean}`;
}

export function assetPathFromUrl(url: string | null): string | null {
  if (!url) return null;
  const prefix = `${config.publicUrl}/static/`;
  if (!url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
}

export function absoluteAssetPath(relativeAssetPath: string): string {
  const resolved = path.resolve(config.paths.assets, relativeAssetPath);
  if (!resolved.startsWith(path.resolve(config.paths.assets) + path.sep)) {
    throw new Error("Path traversal attempt in asset path");
  }
  return resolved;
}

export function savePath(userId: string, artifactId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "save.bin";
  const dir = path.join(config.paths.saves, userId, artifactId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, safeName);
}

export async function removeArtifactFiles(userId: string, artifactId: string): Promise<void> {
  const dir = path.join(config.paths.saves, userId, artifactId);
  await fsp.rm(dir, { recursive: true, force: true });
}

export async function removeAssetByUrl(url: string | null): Promise<void> {
  const rel = assetPathFromUrl(url);
  if (!rel) return;
  try {
    await fsp.unlink(absoluteAssetPath(rel));
  } catch {
    // ignore
  }
}
