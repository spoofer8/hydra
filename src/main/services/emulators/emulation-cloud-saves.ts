import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

import { hybridAxios } from "@main/services/hybrid-axios";

import { HydraApi } from "@main/services/hydra-api";
import type {
  EmulationCloudSave,
  EmulationSaveEmulator,
  EmulationSavePlatform,
  EmulatorBinary,
} from "@types";

import { ryujinxSaveDirs } from "./emulator-config";

/*
 * Cloud emulation saves client (`/profile/emulation-saves`). Mirrors the
 * existing save-game cloud flow (`CloudSync.uploadSaveGame`): metadata calls go
 * through `HydraApi` (auth + subscription enforced), while the raw artifact
 * bytes are PUT/GET directly against the short-lived presigned URLs with
 * `axios`. Direct (non-barrel) service imports avoid a services/emulators cycle.
 *
 * Every call requires an active Hydra Cloud subscription.
 */

const SUB = { needsAuth: true, needsSubscription: true } as const;
const SAVE_KIND = "game_save" as const;

export const toEmulationSaveEmulator = (
  binary: EmulatorBinary
): EmulationSaveEmulator => {
  if (binary === "rpcs3") {
    throw new Error(`Emulator "${binary}" has no cloud emulation saves`);
  }
  // duckstation, pcsx2, and ryujinx all participate in cloud saves — but with
  // different granularities. Memcard-backed emulators (duckstation, pcsx2)
  // upload a single Buffer per save entry (parsed out of the memcard blob).
  // Ryujinx uploads a per-(save_data_id, user_id) tarball of the on-disk save
  // directory (see uploadSwitchSaveEntry below).
  return binary;
};

export interface UploadEmulationSaveInput {
  platform: EmulationSavePlatform;
  emulator: EmulationSaveEmulator;
  /** "launchbox" when the save matched a game; null (with objectId) otherwise. */
  shop: "launchbox" | null;
  objectId: string | null;
  /** Stable per-game slot id — the on-card folder name / save identifier. */
  saveIdentity: string;
  fileName: string; // must end in .psu (PS2) or .mcs (PS1)
  label: string;
  localLastModifiedAt: string; // ISO 8601
  buffer: Buffer;
}

/** Create a presigned upload, PUT the bytes, then commit — returns the save. */
export const uploadEmulationSave = async (
  input: UploadEmulationSaveInput
): Promise<EmulationCloudSave> => {
  const hasShop = Boolean(input.shop && input.objectId);
  const { id, uploadUrl } = await HydraApi.post<{
    id: string;
    uploadUrl: string;
  }>(
    "/profile/emulation-saves/upload-url",
    {
      platform: input.platform,
      emulator: input.emulator,
      saveKind: SAVE_KIND,
      ...(hasShop ? { shop: input.shop, objectId: input.objectId } : {}),
      saveIdentity: input.saveIdentity,
      artifactLengthInBytes: input.buffer.length,
    },
    SUB
  );

  await hybridAxios.put(uploadUrl, input.buffer, {
    headers: { "Content-Type": "application/octet-stream" },
  });

  return HydraApi.post<EmulationCloudSave>(
    `/profile/emulation-saves/${id}/commit`,
    {
      saveKind: SAVE_KIND,
      artifactLengthInBytes: input.buffer.length,
      fileName: input.fileName,
      hostname: os.hostname(),
      localLastModifiedAt: input.localLastModifiedAt,
      label: input.label,
    },
    SUB
  );
};

export const listEmulationSaves = async (
  platform: EmulationSavePlatform,
  emulator: EmulationSaveEmulator,
  objectId?: string | null
): Promise<EmulationCloudSave[]> => {
  const response = await HydraApi.get<EmulationCloudSave[]>(
    "/profile/emulation-saves",
    {
      platform,
      emulator,
      saveKind: SAVE_KIND,
      ...(objectId ? { shop: "launchbox", objectId } : {}),
    },
    SUB
  );
  return Array.isArray(response) ? response : [];
};

/** Resolve a download URL and fetch the raw save bytes. */
export const downloadEmulationSaveBytes = async (
  id: string
): Promise<Buffer> => {
  const { downloadUrl } = await HydraApi.post<{ downloadUrl: string }>(
    `/profile/emulation-saves/${id}/download-url`,
    undefined,
    SUB
  );
  const response = await hybridAxios.get<ArrayBuffer>(downloadUrl, {
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
};

export const deleteEmulationSave = async (id: string): Promise<void> => {
  await HydraApi.delete(`/profile/emulation-saves/${id}`, SUB);
};

export const updateEmulationSave = async (
  id: string,
  body: { label?: string | null; metadata?: Record<string, unknown> | null }
): Promise<EmulationCloudSave> => {
  return HydraApi.put<EmulationCloudSave>(
    `/profile/emulation-saves/${id}`,
    body,
    SUB
  );
};

/* ── Nintendo Switch (Ryubing) ────────────────────────────────────────────── */
// Switch saves live on disk as directory trees, not memcard blobs. Each save
// unit is a folder at:
//
//   <config-root>/bis/user/save/<save_data_id>/<user_id>/
//
// We treat one (save_data_id, user_id) pair as one cloud save entry:
//   - saveIdentity = "<save_data_id>-<user_id>"
//   - fileName     = "<saveIdentity>.tar.gz"
//   - buffer       = gzipped tarball of the directory
//
// The (save_data_id → title_id) mapping requires parsing Ryubing's system
// save DB (bis/system/save/8000000000000000) and is deferred to v2. Until
// then, `objectId` on the uploaded save is best-effort — passed in from the
// caller if they already know the title, or null.

export interface SwitchSaveEntry {
  saveDataId: string; // 16-hex directory name under bis/user/save/
  userId: string; // 32-hex user directory (Ryubing profile UUID)
  absolutePath: string; // full path to the save directory
  sizeBytes: number; // total bytes across all files inside
  modifiedAt: number; // epoch ms of the newest file in the tree
}

const walkDirStats = async (
  dir: string
): Promise<{ sizeBytes: number; modifiedAt: number }> => {
  let sizeBytes = 0;
  let modifiedAt = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(full);
      sizeBytes += stat.size;
      if (stat.mtimeMs > modifiedAt) modifiedAt = stat.mtimeMs;
    }
  }
  return { sizeBytes, modifiedAt };
};

/**
 * Enumerate all Switch save units under Ryubing's save root. Filters out
 * junk (empty dirs, non-hex names) so callers can trust the shape.
 */
export const enumerateSwitchSaves = async (
  executablePath: string | null
): Promise<SwitchSaveEntry[]> => {
  const entries: SwitchSaveEntry[] = [];
  for (const saveRoot of ryujinxSaveDirs(executablePath)) {
    if (!existsSync(saveRoot)) continue;
    const saveDataIds = await fsp.readdir(saveRoot, { withFileTypes: true });
    for (const sdd of saveDataIds) {
      if (!sdd.isDirectory()) continue;
      // Directory names are 16-hex save_data_ids; skip anything else.
      if (!/^[0-9a-fA-F]{16}$/.test(sdd.name)) continue;
      const saveDataDir = path.join(saveRoot, sdd.name);
      const users = await fsp.readdir(saveDataDir, { withFileTypes: true });
      for (const user of users) {
        if (!user.isDirectory()) continue;
        if (!/^[0-9a-fA-F]{32}$/.test(user.name)) continue;
        const userDir = path.join(saveDataDir, user.name);
        const stats = await walkDirStats(userDir);
        if (stats.sizeBytes === 0) continue; // empty save shell, skip
        entries.push({
          saveDataId: sdd.name.toLowerCase(),
          userId: user.name.toLowerCase(),
          absolutePath: userDir,
          sizeBytes: stats.sizeBytes,
          modifiedAt: stats.modifiedAt,
        });
      }
    }
    if (entries.length > 0) break; // first existing root wins (portable > default)
  }
  return entries;
};

/**
 * Pack a Switch save directory into a gzipped tarball in memory. Paths inside
 * the archive are relative to the save directory so extraction into an
 * arbitrary target restores the original layout.
 */
export const packSwitchSaveDirectory = async (
  saveDirAbsolutePath: string
): Promise<Buffer> => {
  // tar.c() with a directory argument produces relative paths naturally.
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = tar.c(
      {
        gzip: true,
        cwd: saveDirAbsolutePath,
        portable: true, // strip uid/gid/mtime jitter for reproducible archives
      },
      ["."]
    );
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
};

/**
 * Unpack a gzipped tarball into a target directory. Creates the directory if
 * missing. Overwrites conflicting files — callers should back up the target
 * first if the local save is newer than the cloud one.
 */
export const unpackSwitchSaveDirectory = async (
  buffer: Buffer,
  targetDir: string
): Promise<void> => {
  await fsp.mkdir(targetDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const extract = tar.x({ cwd: targetDir });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
    extract.end(buffer);
  });
};

export interface UploadSwitchSaveInput {
  executablePath: string | null;
  saveDataId: string;
  userId: string;
  objectId?: string | null;
  label: string;
}

/**
 * High-level: enumerate → find matching entry → pack → upload. Callers pass
 * (saveDataId, userId) rather than an absolute path so this is robust to
 * portable-mode reshuffles.
 */
export const uploadSwitchSaveEntry = async (
  input: UploadSwitchSaveInput
): Promise<EmulationCloudSave> => {
  const entries = await enumerateSwitchSaves(input.executablePath);
  const match = entries.find(
    (e) =>
      e.saveDataId === input.saveDataId.toLowerCase() &&
      e.userId === input.userId.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `Switch save not found: ${input.saveDataId}/${input.userId}`
    );
  }
  const buffer = await packSwitchSaveDirectory(match.absolutePath);
  const saveIdentity = `${match.saveDataId}-${match.userId}`;
  return uploadEmulationSave({
    platform: "switch",
    emulator: "ryujinx",
    shop: input.objectId ? "launchbox" : null,
    objectId: input.objectId ?? null,
    saveIdentity,
    fileName: `${saveIdentity}.tar.gz`,
    label: input.label,
    localLastModifiedAt: new Date(match.modifiedAt).toISOString(),
    buffer,
  });
};

/**
 * High-level: fetch bytes → unpack into the correct save directory.
 * Reconstructs the target path from saveIdentity ("<saveDataId>-<userId>").
 */
export const restoreSwitchSaveEntry = async (
  saveId: string,
  executablePath: string | null,
  saveIdentity: string
): Promise<void> => {
  const [saveDataId, userId] = saveIdentity.split("-");
  if (!saveDataId || !userId) {
    throw new Error(`Invalid switch saveIdentity: ${saveIdentity}`);
  }
  const saveRoots = ryujinxSaveDirs(executablePath);
  if (saveRoots.length === 0) {
    throw new Error("Ryubing save root not resolvable");
  }
  const targetDir = path.join(saveRoots[0], saveDataId, userId);
  const buffer = await downloadEmulationSaveBytes(saveId);
  await unpackSwitchSaveDirectory(buffer, targetDir);
};
