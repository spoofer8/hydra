import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { SystemPath } from "../system-path";
import type { KnownBinary } from "./known-binaries";
import { getEmulatorVersion } from "./get-emulator-version";

const isWindows = process.platform === "win32";

const lookupOnPath = (name: string): string | null => {
  const cmd = isWindows ? "where" : "which";
  const result = spawnSync(cmd, [name], {
    encoding: "utf8",
    shell: false,
    timeout: 3000,
  });

  if (result.error || result.status !== 0) return null;

  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return null;

  const resolved = firstLine.trim();
  return existsSync(resolved) ? resolved : null;
};

const linuxSearchDirs = (): string[] => {
  const home = homedir();
  return [
    "/usr/bin",
    "/usr/local/bin",
    "/var/lib/flatpak/exports/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "flatpak", "exports", "bin"),
    path.join(home, "Applications"),
    "/opt",
  ];
};

const linuxAppImageDirs = (): string[] => {
  const home = homedir();
  return [
    home,
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Applications"),
    path.join(home, "AppImages"),
    path.join(home, ".local", "bin"),
    "/opt",
  ];
};

const windowsSearchDirs = (): string[] => {
  const programFiles =
    process.env["ProgramFiles"] ?? String.raw`C:\Program Files`;
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? String.raw`C:\Program Files (x86)`;
  const localAppData =
    process.env["LOCALAPPDATA"] ??
    path.join(process.env["USERPROFILE"] ?? "", "AppData", "Local");

  const dirs: string[] = [];
  for (const root of [programFiles, programFilesX86, localAppData]) {
    dirs.push(root, path.join(root, "Programs"));
  }
  return dirs;
};

const windowsPortableDirs = (): string[] => {
  const home = homedir();
  const dirs = [
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Emulators"),
    String.raw`D:\Emulators`,
    String.raw`C:\Emulators`,
  ];
  const userProfile = process.env["USERPROFILE"];
  if (userProfile) {
    dirs.push(
      path.join(userProfile, "emudeck", "EmulationStation-DE", "Emulators")
    );
  }
  return dirs;
};

const binarySubdirName = (executableName: string): string => {
  const base = executableName.replace(/\.exe$/i, "");
  return base.split(/[-_]/)[0];
};

const searchInDirs = (names: string[], dirs: string[]): string | null => {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of names) {
      const direct = path.join(dir, name);
      if (existsSync(direct)) return direct;

      const sub = path.join(dir, binarySubdirName(name), name);
      if (existsSync(sub)) return sub;
    }
  }
  return null;
};

const safeReaddir = (dir: string): string[] | null => {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
};

const safeIsDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

const findNameIn = (dir: string, names: string[]): string | null => {
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const searchPortableWindows = (
  names: string[],
  dirs: string[]
): string | null => {
  for (const dir of dirs) {
    const entries = existsSync(dir) ? safeReaddir(dir) : null;
    if (!entries) continue;
    for (const entry of entries) {
      const sub = path.join(dir, entry);
      if (!safeIsDirectory(sub)) continue;
      const hit = findNameIn(sub, names);
      if (hit) return hit;
    }
  }
  return null;
};

const findAppImage = (
  binaryKeywords: string[],
  dirs: string[]
): string | null => {
  for (const dir of dirs) {
    const entries = existsSync(dir) ? safeReaddir(dir) : null;
    if (!entries) continue;
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (!lower.endsWith(".appimage")) continue;
      if (!binaryKeywords.some((k) => lower.includes(k.toLowerCase()))) {
        continue;
      }
      const full = path.join(dir, entry);
      if (existsSync(full)) return full;
    }
  }
  return null;
};

// Hydra's own emulator install directory (userData/emulators/<binary>/). ZIP
// installs commonly wrap the exe in a `publish/`, `bin/`, or version-suffixed
// subfolder, so we recursively walk this tree instead of expecting a specific
// layout. Kept separate from the general Windows/Linux search functions so
// this cheap targeted check runs even when the broad search wouldn't (e.g.
// Ryubing on Windows lives here but nowhere else in windowsPortableDirs).
const managedEmulatorDir = (binary: string): string =>
  path.join(SystemPath.getPath("userData"), "emulators", binary);

const searchManagedDir = (
  binary: string,
  names: readonly string[]
): string | null => {
  const root = managedEmulatorDir(binary);
  if (!existsSync(root)) return null;

  const lowerNames = names.map((n) => n.toLowerCase());
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = safeReaddir(dir);
    if (!entries) continue;
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (safeIsDirectory(full)) {
        stack.push(full);
      } else if (lowerNames.includes(entry.toLowerCase())) {
        return full;
      }
    }
  }
  return null;
};

const flatpakSystemDir = "/var/lib/flatpak/exports/bin";

const tryFlatpak = (flatpakIds: string[]): string | null => {
  if (process.platform !== "linux") return null;

  for (const id of flatpakIds) {
    const result = spawnSync("flatpak", ["info", id], {
      encoding: "utf8",
      shell: false,
      timeout: 3000,
    });
    if (result.error || result.status !== 0) continue;

    const userWrapper = path.join(
      homedir(),
      ".local",
      "share",
      "flatpak",
      "exports",
      "bin",
      id
    );
    if (existsSync(userWrapper)) return userWrapper;

    const systemWrapper = path.join(flatpakSystemDir, id);
    if (existsSync(systemWrapper)) return systemWrapper;
  }

  return null;
};

export interface DetectionResult {
  executablePath: string;
  detectedVersion: string | null;
}

export const detectEmulator = (
  binary: KnownBinary,
  options?: { resolveVersion?: boolean }
): DetectionResult | null => {
  const names = isWindows ? binary.windowsNames : binary.linuxNames;
  const resolveVersion = options?.resolveVersion ?? false;
  const versionFor = (executablePath: string): string | null =>
    resolveVersion ? getEmulatorVersion(executablePath, binary) : null;

  // Managed dir first — cheap, targeted, and the location where Hydra's own
  // auto-installer drops emulators. Priority over PATH so a user with a
  // stale system-wide install doesn't shadow a fresh in-app install.
  const managed = searchManagedDir(binary.binary, names);
  if (managed) {
    return {
      executablePath: managed,
      detectedVersion: versionFor(managed),
    };
  }

  for (const name of names) {
    const onPath = lookupOnPath(name);
    if (onPath) {
      return {
        executablePath: onPath,
        detectedVersion: versionFor(onPath),
      };
    }
  }

  const dirs = isWindows ? windowsSearchDirs() : linuxSearchDirs();
  const found = searchInDirs(names, dirs);
  if (found) {
    return {
      executablePath: found,
      detectedVersion: versionFor(found),
    };
  }

  if (isWindows) {
    const portable = searchPortableWindows(names, windowsPortableDirs());
    if (portable) {
      return {
        executablePath: portable,
        detectedVersion: versionFor(portable),
      };
    }
  } else {
    const appImage = findAppImage(
      [binary.binary, binary.displayName],
      linuxAppImageDirs()
    );
    if (appImage) {
      return {
        executablePath: appImage,
        detectedVersion: versionFor(appImage),
      };
    }
  }

  const flatpak = tryFlatpak(binary.flatpakIds);
  if (flatpak) {
    return {
      executablePath: flatpak,
      detectedVersion: null,
    };
  }

  return null;
};
