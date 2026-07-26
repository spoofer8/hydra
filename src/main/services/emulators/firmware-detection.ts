import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  ryujinxFirmwareDirs,
  ryujinxSystemDirs,
} from "./emulator-config";

const firmwareSearchDirs = (executablePath: string | null): string[] => {
  const home = homedir();
  const dirs: string[] = [];

  if (process.platform === "win32") {
    const appData =
      process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
    dirs.push(path.join(appData, "rpcs3", "dev_flash"));
  } else {
    dirs.push(
      path.join(home, ".config", "rpcs3", "dev_flash"),
      path.join(
        home,
        ".var",
        "app",
        "net.rpcs3.RPCS3",
        "config",
        "rpcs3",
        "dev_flash"
      )
    );
  }

  if (executablePath) {
    dirs.push(path.join(path.dirname(executablePath), "dev_flash"));
  }

  return dirs;
};

export const isPs3FirmwareInstalled = async (
  executablePath: string | null
): Promise<boolean> => {
  for (const dir of firmwareSearchDirs(executablePath)) {
    if (!existsSync(dir)) continue;
    const sysExternal = path.join(dir, "sys", "external");
    if (!existsSync(sysExternal)) continue;
    try {
      const entries = await fs.readdir(sysExternal);
      if (entries.length > 0) return true;
    } catch {
      // unreadable — keep looking
    }
  }
  return false;
};

// --- Switch (Ryubing) --------------------------------------------------------
// A working Switch install needs THREE separate things:
//   1. prod.keys      — required, decrypts everything. Dumped from a Switch
//                       via Lockpick_RCM (homebrew).
//   2. title.keys     — optional; per-title override keys for legacy or
//                       user-installed titles.
//   3. Firmware NCAs  — installed via Ryubing's built-in installer from an
//                       XCI or ZIP dump. Placed in
//                       bis/system/Contents/registered/ as ~30 .nca files.
//
// The UI wants to tell the user which of these are missing (each has a
// different setup step in the wizard), so this returns per-component presence
// rather than a single boolean.

export interface SwitchFirmwareStatus {
  prodKeysPresent: boolean;
  titleKeysPresent: boolean; // informational; not required
  firmwareInstalled: boolean;
  keysPath: string | null; // resolved system/ dir if any candidate exists
  firmwarePath: string | null; // resolved registered/ dir if any candidate exists
  firmwareNcaCount: number; // rough sanity signal; full firmware has ~30 files
}

export const inspectSwitchFirmware = async (
  executablePath: string | null
): Promise<SwitchFirmwareStatus> => {
  const status: SwitchFirmwareStatus = {
    prodKeysPresent: false,
    titleKeysPresent: false,
    firmwareInstalled: false,
    keysPath: null,
    firmwarePath: null,
    firmwareNcaCount: 0,
  };

  for (const systemDir of ryujinxSystemDirs(executablePath)) {
    if (!existsSync(systemDir)) continue;
    status.keysPath ??= systemDir;
    if (existsSync(path.join(systemDir, "prod.keys"))) {
      status.prodKeysPresent = true;
    }
    if (existsSync(path.join(systemDir, "title.keys"))) {
      status.titleKeysPresent = true;
    }
    if (status.prodKeysPresent) break;
  }

  for (const firmwareDir of ryujinxFirmwareDirs(executablePath)) {
    if (!existsSync(firmwareDir)) continue;
    status.firmwarePath ??= firmwareDir;
    try {
      const entries = await fs.readdir(firmwareDir);
      const ncas = entries.filter((e) => e.toLowerCase().endsWith(".nca"));
      if (ncas.length > status.firmwareNcaCount) {
        status.firmwareNcaCount = ncas.length;
        // Ryubing itself accepts an incomplete firmware and refuses to launch
        // games — but any NCA presence means the user has done SOMETHING;
        // treat >= 10 NCAs as "probably installed" for the UI badge. Actual
        // per-title launch failures still surface as normal emulator errors.
        if (ncas.length >= 10) status.firmwareInstalled = true;
      }
    } catch {
      // unreadable — keep looking
    }
  }

  return status;
};

export const isSwitchReady = async (
  executablePath: string | null
): Promise<boolean> => {
  const status = await inspectSwitchFirmware(executablePath);
  return status.prodKeysPresent && status.firmwareInstalled;
};
