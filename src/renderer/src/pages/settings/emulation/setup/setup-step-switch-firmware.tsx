import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ClockIcon,
  CheckCircleFillIcon,
  SyncIcon,
} from "@primer/octicons-react";

import { Button } from "@renderer/components";
import type { EmulatorConfig } from "@types";

interface Props {
  config: EmulatorConfig;
  onFirmwareStatusChange: (installed: boolean) => void;
  onSkip: () => void;
}

/**
 * Setup wizard: Switch firmware install check.
 *
 * Firmware installation itself happens inside Ryubing via Tools → Install
 * Firmware — Hydra does not unpack XCI/ZIP firmware bundles in-app because:
 *   1. It requires the user's prod.keys to decrypt the NCAs
 *   2. Ryubing's built-in installer handles version detection and NCA
 *      registration that a naive extract-to-directory would miss
 *
 * We detect firmware by counting NCA files under
 * bis/system/Contents/registered/. See inspectSwitchFirmware in
 * services/emulators/firmware-detection.ts for detection details.
 */
export function SetupStepSwitchFirmware({
  config,
  onFirmwareStatusChange,
  onSkip,
}: Readonly<Props>) {
  const { t } = useTranslation("settings");
  const [installed, setInstalled] = useState(false);
  const [ncaCount, setNcaCount] = useState(0);
  const [checking, setChecking] = useState(false);

  const probe = async () => {
    setChecking(true);
    try {
      const result = await window.electron.checkSwitchFirmware(
        config.executablePath
      );
      setInstalled(result.firmwareInstalled);
      setNcaCount(result.firmwareNcaCount);
      onFirmwareStatusChange(result.firmwareInstalled);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRyubing = () => {
    // Best-effort: open the emulator so the user can go to
    // Tools → Install Firmware. If Ryubing isn't installed yet, this no-ops.
    if (config.executablePath) {
      window.electron.openExternal(`file://${config.executablePath}`);
    }
  };

  const openFirmwareGuide = () => {
    // Third-party guide with a step-by-step walkthrough of downloading and
    // installing Switch firmware for Ryujinx-derived emulators. Matches the
    // prod.keys page pattern — one canonical link users can follow rather
    // than an in-app explanation that has to stay in sync with the guide.
    window.electron.openExternal(
      "https://prodkeys.net/ryujinx-firmware-v5/"
    );
  };

  return (
    <>
      <h3 className="setup-modal__body-title">
        {t("setup_step_switch_firmware", {
          defaultValue: "Install Switch firmware",
        })}
      </h3>
      <div>
        <p className="setup-modal__body-intro" style={{ margin: 0 }}>
          {t("setup_switch_firmware_intro", {
            defaultValue:
              "Ryubing needs Nintendo Switch firmware to launch games. Follow the guide below to download and install it, then come back and click Check again.",
          })}
        </p>
      </div>

      <div className="setup-modal__hint">
        <button
          type="button"
          className="setup-modal__link-button"
          onClick={openFirmwareGuide}
        >
          {t("setup_switch_firmware_guide", {
            defaultValue: "Open firmware guide",
          })}
        </button>
        {config.executablePath && (
          <button
            type="button"
            className="setup-modal__ghost-button"
            onClick={openRyubing}
          >
            {t("setup_switch_firmware_open_emulator", {
              defaultValue: "Launch Ryubing",
            })}
          </button>
        )}
        <button
          type="button"
          className="setup-modal__ghost-button"
          onClick={onSkip}
        >
          {t("setup_skip_later")}
        </button>
      </div>

      <div
        className="setup-modal__alert setup-modal__alert--neutral"
        style={{ marginTop: "auto" }}
      >
        <div
          className={`setup-modal__row-icon ${
            installed
              ? "setup-modal__row-icon--found"
              : "setup-modal__row-icon--neutral"
          }`}
          style={{ width: 36, height: 36 }}
        >
          {installed ? (
            <CheckCircleFillIcon size={16} />
          ) : (
            <ClockIcon size={16} />
          )}
        </div>
        <div className="setup-modal__alert-text">
          <span className="setup-modal__alert-title">
            {installed
              ? t("setup_switch_firmware_found", {
                  defaultValue: "Firmware detected",
                })
              : t("setup_switch_firmware_not_yet", {
                  defaultValue: "Firmware not detected yet",
                })}
          </span>
          <span className="setup-modal__alert-note">
            {installed
              ? t("setup_switch_firmware_found_note", {
                  defaultValue: `Ready to launch (${ncaCount} NCA files present).`,
                  count: ncaCount,
                })
              : t("setup_switch_firmware_recheck_note", {
                  defaultValue:
                    "Install firmware in Ryubing, then click check again.",
                })}
          </span>
        </div>
        {!installed && (
          <Button theme="primary" onClick={probe} disabled={checking}>
            <SyncIcon size={14} />
            <span>
              {t("setup_switch_firmware_check_again", {
                defaultValue: "Check again",
              })}
            </span>
          </Button>
        )}
      </div>
    </>
  );
}
