import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ClockIcon,
  CheckCircleFillIcon,
  SyncIcon,
  FileDirectoryIcon,
} from "@primer/octicons-react";

import { Button } from "@renderer/components";
import type { EmulatorConfig } from "@types";

interface Props {
  config: EmulatorConfig;
  onKeysStatusChange: (ready: boolean) => void;
  onSkip: () => void;
}

/**
 * Setup wizard: prod.keys + title.keys presence check for Switch.
 *
 * The user is expected to have dumped keys from their own Switch console
 * (Lockpick_RCM on RCM-vulnerable units, or NxKeygen on modchipped ones).
 * Nintendo does NOT distribute these; there is no legal download source, so
 * this step provides guidance rather than automation.
 *
 * We do offer one small convenience: a file picker that copies a selected
 * prod.keys (or title.keys) into the correct system/ directory next to
 * Ryubing's Config.json — most users get tripped up placing the file in
 * the wrong location.
 */
export function SetupStepSwitchKeys({
  config,
  onKeysStatusChange,
  onSkip,
}: Readonly<Props>) {
  const { t } = useTranslation("settings");
  const [prodKeys, setProdKeys] = useState(false);
  const [titleKeys, setTitleKeys] = useState(false);
  const [keysPath, setKeysPath] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const probe = async () => {
    setChecking(true);
    try {
      const result = await window.electron.checkSwitchFirmware(
        config.executablePath
      );
      setProdKeys(result.prodKeysPresent);
      setTitleKeys(result.titleKeysPresent);
      setKeysPath(result.keysPath);
      // Only prod.keys are required; title.keys are per-title overrides that
      // most users don't need. Wizard advances once prod.keys are present.
      onKeysStatusChange(result.prodKeysPresent);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRyubingDocs = () => {
    window.electron.openExternal("https://ryubing.org/");
  };

  return (
    <>
      <h3 className="setup-modal__body-title">
        {t("setup_step_switch_keys", { defaultValue: "Set up prod.keys" })}
      </h3>
      <div>
        <p className="setup-modal__body-intro" style={{ margin: 0 }}>
          {t("setup_switch_keys_intro_1", {
            defaultValue:
              "Ryubing needs prod.keys (from your own Switch console) to decrypt games. Nintendo does not distribute keys; you must dump them from a Switch you own.",
          })}
        </p>
        <p className="setup-modal__body-intro" style={{ margin: 0 }}>
          {t("setup_switch_keys_intro_2", {
            defaultValue:
              "title.keys is optional — only needed for a small set of legacy titles.",
          })}
        </p>
      </div>

      <div className="setup-modal__numbered-list">
        <div className="setup-modal__numbered-item">
          <span className="setup-modal__numbered-marker">1</span>
          <span className="setup-modal__numbered-text">
            {t("setup_switch_keys_step_1", {
              defaultValue:
                "Dump prod.keys from your Switch using Lockpick_RCM (RCM-vulnerable units) or NxKeygen (modchipped units).",
            })}
          </span>
        </div>
        <div className="setup-modal__numbered-item">
          <span className="setup-modal__numbered-marker">2</span>
          <span className="setup-modal__numbered-text">
            {t("setup_switch_keys_step_2", {
              defaultValue: keysPath
                ? `Place prod.keys at: ${keysPath}`
                : "Copy the file into Ryubing's system/ folder (next to Config.json).",
            })}
          </span>
        </div>
      </div>

      <div className="setup-modal__hint">
        <button
          type="button"
          className="setup-modal__link-button"
          onClick={openRyubingDocs}
        >
          {t("setup_switch_keys_guide", {
            defaultValue: "Open Ryubing setup docs",
          })}
        </button>
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
            prodKeys
              ? "setup-modal__row-icon--found"
              : "setup-modal__row-icon--neutral"
          }`}
          style={{ width: 36, height: 36 }}
        >
          {prodKeys ? (
            <CheckCircleFillIcon size={16} />
          ) : (
            <ClockIcon size={16} />
          )}
        </div>
        <div className="setup-modal__alert-text">
          <span className="setup-modal__alert-title">
            {prodKeys
              ? t("setup_switch_keys_found", {
                  defaultValue: "prod.keys detected",
                })
              : t("setup_switch_keys_not_yet", {
                  defaultValue: "prod.keys not detected yet",
                })}
          </span>
          <span className="setup-modal__alert-note">
            {prodKeys
              ? titleKeys
                ? t("setup_switch_keys_all_found", {
                    defaultValue: "prod.keys and title.keys both present.",
                  })
                : t("setup_switch_keys_partial_found", {
                    defaultValue: "prod.keys ready. title.keys optional.",
                  })
              : t("setup_switch_keys_recheck_note", {
                  defaultValue:
                    "Add the file, then click check again to continue.",
                })}
          </span>
        </div>
        {!prodKeys && (
          <Button theme="primary" onClick={probe} disabled={checking}>
            <SyncIcon size={14} />
            <span>
              {t("setup_switch_keys_check_again", {
                defaultValue: "Check again",
              })}
            </span>
          </Button>
        )}
        {keysPath && (
          <button
            type="button"
            className="setup-modal__ghost-button"
            onClick={() => window.electron.openExternal(`file://${keysPath}`)}
            title={keysPath}
          >
            <FileDirectoryIcon size={14} />
            <span>
              {t("setup_switch_keys_open_folder", {
                defaultValue: "Open folder",
              })}
            </span>
          </button>
        )}
      </div>
    </>
  );
}
