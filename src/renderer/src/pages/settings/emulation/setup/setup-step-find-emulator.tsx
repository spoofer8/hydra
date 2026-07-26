import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircleFillIcon,
  AlertIcon,
  SyncIcon,
} from "@primer/octicons-react";

import { Button } from "@renderer/components";
import type {
  EmulatorConfig,
  EmulatorInstallProgress,
  ResolvedInstallOption,
} from "@types";

import { KNOWN_BINARY_LABELS } from "../known-binary-labels";
import { GitHubIcon } from "./brand-icons";

interface Props {
  config: EmulatorConfig;
  detecting?: boolean;
  onBrowse: () => void;
  onShowDownloadHelp: () => void;
  // Install state passed down from the modal so the primary install action
  // is available inline on this page (rather than hidden behind a
  // "Show download options" click). Same state feeds the download subpage.
  installOptions: ResolvedInstallOption[] | null;
  installProgress: Record<string, EmulatorInstallProgress>;
  installingId: string | null;
  onInstall: (optionId: string) => void;
}

export function SetupStepFindEmulator({
  config,
  detecting = false,
  onBrowse,
  onShowDownloadHelp,
  installOptions,
  installProgress,
  installingId,
  onInstall,
}: Readonly<Props>) {
  const { t } = useTranslation("settings");
  const name = KNOWN_BINARY_LABELS[config.binary];
  const found = config.executablePath !== null;

  // Primary install option = first non-link (i.e. one Hydra can auto-install)
  // that matches the OS. Multiple installables can exist (e.g. PCSX2 has
  // release + prerelease); we pick the first, which by convention is the
  // recommended one (setup-step-download orders release before prerelease).
  const primaryOption = useMemo<ResolvedInstallOption | null>(
    () => installOptions?.find((option) => option.kind !== "link") ?? null,
    [installOptions]
  );
  const primaryProgress = primaryOption
    ? installProgress[primaryOption.id]
    : undefined;
  const isPrimaryInstalling =
    primaryOption != null && installingId === primaryOption.id;

  const primaryStatusText = () => {
    if (!primaryProgress) return t("setup_install_with_hydra_desc", { name });
    if (primaryProgress.phase === "downloading") {
      const percent =
        primaryProgress.total && primaryProgress.total > 0
          ? Math.floor(
              ((primaryProgress.loaded ?? 0) / primaryProgress.total) * 100
            )
          : 0;
      return t("setup_install_downloading", { percent });
    }
    if (primaryProgress.phase === "extracting")
      return t("setup_install_extracting");
    if (primaryProgress.phase === "running") return t("setup_install_running");
    if (primaryProgress.phase === "done") return t("setup_install_done");
    if (primaryProgress.phase === "error") return t("setup_install_failed");
    return t("setup_install_with_hydra_desc", { name });
  };

  // Hide the inline install button once the emulator is detected — no point
  // offering to re-install what's already there. `showPrimary` also gates
  // against fetch-still-pending (null options) vs empty (no installable
  // options for this OS/arch).
  const showPrimary = !found && primaryOption != null;

  return (
    <>
      <h3 className="setup-modal__body-title">
        {t("setup_step_find_emulator", { name })}
      </h3>
      <p className="setup-modal__body-intro">
        {t("setup_step_find_intro", { name })}
      </p>

      <div className="setup-modal__row-card">
        <div
          className={`setup-modal__row-icon ${
            detecting
              ? "setup-modal__row-icon--warn"
              : found
                ? "setup-modal__row-icon--found"
                : "setup-modal__row-icon--warn"
          }`}
        >
          {detecting ? (
            <SyncIcon size={18} />
          ) : found ? (
            <CheckCircleFillIcon size={20} />
          ) : (
            <AlertIcon size={18} />
          )}
        </div>
        <div className="setup-modal__row-text">
          <div className="setup-modal__row-heading">
            <span className="setup-modal__row-title">
              {detecting
                ? t("setup_emulator_detecting", { name })
                : found
                  ? t("setup_emulator_found", { name })
                  : t("setup_emulator_not_found", { name })}
            </span>
            {config.detectedVersion && (
              <span className="setup-modal__row-version">
                v{config.detectedVersion}
              </span>
            )}
          </div>
          <span className="setup-modal__row-path">
            {config.executablePath ?? t("setup_emulator_not_found_hint")}
          </span>
        </div>
      </div>

      {showPrimary && primaryOption && (
        <Button
          theme="primary"
          onClick={() => onInstall(primaryOption.id)}
          disabled={Boolean(installingId) && !isPrimaryInstalling}
        >
          <GitHubIcon size={16} />
          <span>
            {isPrimaryInstalling
              ? primaryStatusText()
              : t("setup_install_with_hydra_short", {
                  defaultValue: `Install ${name} with Hydra`,
                  name,
                })}
          </span>
        </Button>
      )}
      {showPrimary && primaryProgress && (
        <div
          className="setup-modal__progress-bar"
          style={{ marginTop: -6, marginBottom: 6 }}
        >
          <div
            className={`setup-modal__progress-fill ${
              primaryProgress.phase !== "downloading" ||
              !primaryProgress.total ||
              primaryProgress.total === 0
                ? "setup-modal__progress-fill--indeterminate"
                : ""
            }`}
            style={
              primaryProgress.phase === "downloading" &&
              primaryProgress.total &&
              primaryProgress.total > 0
                ? {
                    width: `${Math.min(
                      100,
                      Math.floor(
                        ((primaryProgress.loaded ?? 0) / primaryProgress.total) *
                          100
                      )
                    )}%`,
                  }
                : undefined
            }
          />
        </div>
      )}

      <div className="setup-modal__hint">
        <div className="setup-modal__hint-group">
          <span>{t("setup_browse_manually_q")}</span>
          <button
            type="button"
            className="setup-modal__link-button"
            onClick={onBrowse}
          >
            {t("setup_browse_manually")}
          </button>
        </div>
        <button
          type="button"
          className="setup-modal__link-button"
          onClick={onShowDownloadHelp}
        >
          {t("setup_more_install_options", {
            defaultValue: "More install options",
          })}
        </button>
      </div>
    </>
  );
}
