import { registerEvent } from "../register-event";
import { emulators } from "@main/services";

// Reports per-component presence for the Switch setup wizard: prod.keys
// (required), title.keys (optional), firmware NCA install (checked by NCA
// count in bis/system/Contents/registered/). Symmetrical with checkPs3Firmware
// but returns richer state because Switch has three prerequisites that the
// user configures in separate wizard steps.
const checkSwitchFirmware = async (
  _event: Electron.IpcMainInvokeEvent,
  executablePath: string | null
) => {
  return emulators.inspectSwitchFirmware(executablePath);
};

registerEvent("checkSwitchFirmware", checkSwitchFirmware);
