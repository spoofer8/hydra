import type { EmulatorSystem } from "@types";

export type StepKind =
  | "find_emulator"
  | "firmware"
  | "bios"
  | "keys"
  | "rom_folder"
  | "scanning"
  | "done";

export interface PendingFolder {
  path: string;
  scanSubfolders: boolean;
  previewCount: number | null;
}

export const stepListForSystem = (system: EmulatorSystem): StepKind[] => {
  if (system === "ps3") {
    return ["find_emulator", "firmware", "rom_folder", "scanning", "done"];
  }
  if (system === "switch") {
    // Switch needs keys BEFORE firmware — Ryubing's built-in firmware
    // installer refuses without prod.keys present, so we walk the user
    // through them in that order.
    return [
      "find_emulator",
      "keys",
      "firmware",
      "rom_folder",
      "scanning",
      "done",
    ];
  }
  return ["find_emulator", "bios", "rom_folder", "scanning", "done"];
};
