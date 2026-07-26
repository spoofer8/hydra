import { registerEvent } from "../register-event";
import { emulators } from "@main/services";
import type { EmulatorSystem } from "@types";

const getEmulatorRomPaths = async (
  _event: Electron.IpcMainInvokeEvent,
  system: EmulatorSystem
) => {
  const config = await emulators.getEmulatorConfig(system);
  // Switch (Ryubing) stores ROM paths in Config.json → game_dirs, not in an INI
  // RecursivePaths section. Route to the Ryubing-specific reader; PS1/PS2
  // continue to use readRecursivePaths.
  if (system === "switch") {
    return emulators.readRyujinxGameDirs(config.executablePath);
  }
  return emulators.readRecursivePaths(system, config.executablePath);
};

const addEmulatorRomPath = async (
  _event: Electron.IpcMainInvokeEvent,
  system: EmulatorSystem,
  folderPath: string
) => {
  const config = await emulators.getEmulatorConfig(system);
  if (system === "switch") {
    return emulators.addRyujinxGameDir(config.executablePath, folderPath);
  }
  return emulators.addRecursivePath(system, config.executablePath, folderPath);
};

// RPCS3 default discovery sources: the config root's `games/` folder and the
// title-id entries already registered in games.yml.
const getRpcs3DefaultSources = async () => {
  const config = await emulators.getEmulatorConfig("ps3");
  const exe = config.executablePath;
  const ymlMap = await emulators.readGamesYml(exe);
  return {
    gamesDir: emulators.findExistingConfig(
      emulators.rpcs3DefaultGamesDirs(exe)
    ),
    gamesYmlPath: emulators.findExistingConfig(
      emulators.rpcs3GamesYmlCandidates(exe)
    ),
    gamesYmlEntries: Array.from(ymlMap.entries()).map(([titleId, path]) => ({
      titleId,
      path,
    })),
  };
};

// Ryubing (Switch) default discovery sources. Symmetrical with the RPCS3 event
// so the settings UI can render "here's the config file we found + the folders
// already registered in it" for both. No title-id map yet — that requires
// parsing bis/system/save/8000000000000000 (deferred to v2).
const getRyubingDefaultSources = async () => {
  const config = await emulators.getEmulatorConfig("switch");
  const exe = config.executablePath;
  return {
    configPath: emulators.findExistingConfig(
      emulators.ryujinxConfigCandidates(exe)
    ),
    gameDirs: await emulators.readRyujinxGameDirs(exe),
  };
};

registerEvent("getEmulatorRomPaths", getEmulatorRomPaths);
registerEvent("addEmulatorRomPath", addEmulatorRomPath);
registerEvent("getRpcs3DefaultSources", getRpcs3DefaultSources);
registerEvent("getRyubingDefaultSources", getRyubingDefaultSources);
