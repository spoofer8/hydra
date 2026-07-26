import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Modal } from "@renderer/components";
import { useClassicsScan, useToast } from "@renderer/hooks";
import type {
  EmulatorConfig,
  EmulatorInstallProgress,
  EmulatorSystem,
  ResolvedInstallOption,
} from "@types";

import { SetupFooter } from "./setup-footer";
import { SetupStepDownload } from "./setup-step-download";
import { SetupStepFindEmulator } from "./setup-step-find-emulator";
import { SetupStepFirmware } from "./setup-step-firmware";
import { SetupStepBios } from "./setup-step-bios";
import { SetupStepSwitchKeys } from "./setup-step-switch-keys";
import { SetupStepSwitchFirmware } from "./setup-step-switch-firmware";
import { SetupStepRomFolder } from "./setup-step-rom-folder";
import { SetupStepScanning } from "./setup-step-scanning";
import { SetupStepDone } from "./setup-step-done";
import { type PendingFolder, stepListForSystem, type StepKind } from "./types";

import "./setup-shell.scss";

interface Props {
  visible: boolean;
  system: EmulatorSystem | null;
  systemLabel: string;
  initialConfig: EmulatorConfig | null;
  onClose: () => void;
  onComplete: (system: EmulatorSystem) => void;
}

export function EmulatorSetupModal({
  visible,
  system,
  systemLabel,
  initialConfig,
  onClose,
  onComplete,
}: Readonly<Props>) {
  const { t } = useTranslation("settings");
  const { showErrorToast } = useToast();
  const { scan, start, cancel } = useClassicsScan();

  const [config, setConfig] = useState<EmulatorConfig | null>(initialConfig);
  const [stepIndex, setStepIndex] = useState(0);
  const [folders, setFolders] = useState<PendingFolder[]>([]);
  const [firmwareOk, setFirmwareOk] = useState(false);
  const [biosOk, setBiosOk] = useState(false);
  const [keysOk, setKeysOk] = useState(false);
  const [gamesAdded, setGamesAdded] = useState(0);
  const [scanComplete, setScanComplete] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [ymlEntryCount, setYmlEntryCount] = useState(0);
  const [showDownloadHelp, setShowDownloadHelp] = useState(false);
  // Install options + progress are owned by the modal (rather than the
  // download subpage) so the find-emulator step can also render the primary
  // "Install with Hydra" action inline — one fetch, one subscription, shared
  // state across both pages.
  const [installOptions, setInstallOptions] =
    useState<ResolvedInstallOption[] | null>(null);
  const [installProgress, setInstallProgress] = useState<
    Record<string, EmulatorInstallProgress>
  >({});
  const [installingId, setInstallingId] = useState<string | null>(null);

  const autoDetectRef = useRef(false);
  const scanStartedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setConfig(initialConfig);
      setStepIndex(0);
      setFolders([]);
      setFirmwareOk(false);
      setBiosOk(false);
      setKeysOk(false);
      setGamesAdded(0);
      setScanComplete(false);
      setYmlEntryCount(0);
      setShowDownloadHelp(false);
      setInstallOptions(null);
      setInstallProgress({});
      setInstallingId(null);
      autoDetectRef.current = false;
      scanStartedRef.current = false;
    }
  }, [visible, initialConfig]);

  // Fetch install options once per (visible, binary). Both find-emulator and
  // download pages consume the resulting list. Errors default to [] so the
  // UI just doesn't render install buttons rather than getting stuck.
  useEffect(() => {
    if (!visible || !config?.binary) return;
    let cancelled = false;
    setInstallOptions(null);
    window.electron
      .getEmulatorInstallOptions(config.binary)
      .then((result) => {
        if (!cancelled) setInstallOptions(result);
      })
      .catch(() => {
        if (!cancelled) setInstallOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, config?.binary]);

  // Subscribe once per binary so install progress updates land in either page.
  useEffect(() => {
    if (!config?.binary) return;
    const unsub = window.electron.onEmulatorInstallProgress((payload) => {
      if (payload.binary !== config.binary) return;
      setInstallProgress((prev) => ({ ...prev, [payload.optionId]: payload }));
    });
    return unsub;
  }, [config?.binary]);

  const handleInstallOption = useCallback(
    async (optionId: string) => {
      if (!config?.binary || installingId) return;
      setInstallingId(optionId);
      try {
        await window.electron.installEmulator(config.binary, optionId);
      } finally {
        setInstallingId(null);
      }
    },
    [config?.binary, installingId]
  );

  // Rescan without leaving the current page — used by the "Rescan" button on
  // the download subpage AND automatically after an install completes so the
  // find-emulator page's status flips to "detected" without a manual click.
  // Inlines getEmulatorConfigs rather than calling refreshConfig (defined
  // further down) to avoid a forward-reference in this file's declaration
  // order.
  const handleRescan = useCallback(async () => {
    if (!system) return;
    setDetecting(true);
    try {
      const all = await window.electron.getEmulatorConfigs();
      const refreshed = all[system];
      if (refreshed?.executablePath) {
        setConfig(refreshed);
        return;
      }
      const preview = await window.electron.previewEmulatorExecutable(system);
      if (!preview) return;
      setConfig((curr) =>
        curr
          ? {
              ...curr,
              executablePath: preview.executablePath,
              detectedVersion: preview.detectedVersion,
            }
          : curr
      );
    } finally {
      setDetecting(false);
    }
  }, [system]);

  // Auto-rescan when the currently-installing option completes. Skips if the
  // exec is already known (avoids stomping a user-picked path) or if there is
  // no active install.
  useEffect(() => {
    if (!installingId) return;
    const current = installProgress[installingId];
    if (current?.phase !== "done") return;
    if (config?.executablePath) return;
    void handleRescan();
  }, [installingId, installProgress, config?.executablePath, handleRescan]);

  useEffect(() => {
    if (!visible || !system) return;
    if (autoDetectRef.current) return;
    if (initialConfig?.executablePath) return;
    autoDetectRef.current = true;

    let cancelled = false;
    setDetecting(true);
    (async () => {
      try {
        const preview = await window.electron.previewEmulatorExecutable(system);
        if (cancelled || !preview) return;
        setConfig((curr) => {
          if (curr?.executablePath) return curr;
          if (!curr) return curr;
          return {
            ...curr,
            executablePath: preview.executablePath,
            detectedVersion: preview.detectedVersion,
          };
        });
      } finally {
        if (!cancelled) setDetecting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, system, initialConfig?.executablePath]);

  const prefilledRef = useRef(false);

  const steps = useMemo<StepKind[]>(
    () => (system ? stepListForSystem(system) : []),
    [system]
  );
  const currentStep = steps[stepIndex];
  const systemShort = system ? system.toUpperCase() : "";

  const goNext = useCallback(() => setStepIndex((i) => i + 1), []);
  const goBack = useCallback(() => setStepIndex((i) => Math.max(0, i - 1)), []);

  const handleContinue = useCallback(async () => {
    if (
      currentStep === "find_emulator" &&
      system &&
      config?.executablePath &&
      config.executablePath !== initialConfig?.executablePath
    ) {
      const next = await window.electron.setEmulatorExecutablePath(
        system,
        config.executablePath
      );
      setConfig(next);
    }
    goNext();
  }, [currentStep, system, config, initialConfig?.executablePath, goNext]);

  const refreshConfig = useCallback(async () => {
    if (!system) return null;
    const all = await window.electron.getEmulatorConfigs();
    setConfig(all[system]);
    return all[system];
  }, [system]);

  const handleDownloadReady = useCallback(async () => {
    setShowDownloadHelp(false);
    if (!system) return;
    setDetecting(true);
    try {
      const refreshed = await refreshConfig();
      if (refreshed?.executablePath) return;
      const preview = await window.electron.previewEmulatorExecutable(system);
      if (!preview) return;
      setConfig((curr) =>
        curr
          ? {
              ...curr,
              executablePath: preview.executablePath,
              detectedVersion: preview.detectedVersion,
            }
          : curr
      );
    } finally {
      setDetecting(false);
    }
  }, [system, refreshConfig]);

  const handleBrowseExecutable = useCallback(async () => {
    if (!system) return;
    const isMac = window.electron.platform === "darwin";
    const result = await window.electron.showOpenDialog({
      properties: isMac ? ["openFile", "openDirectory"] : ["openFile"],
      filters:
        window.electron.platform === "win32"
          ? [{ name: "Executable", extensions: ["exe"] }]
          : isMac
            ? [{ name: "Application", extensions: ["app"] }]
            : undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const preview = await window.electron.previewEmulatorExecutable(
      system,
      result.filePaths[0]
    );
    if (!preview) {
      showErrorToast(t("emulator_invalid_executable"));
      return;
    }
    setConfig((curr) =>
      curr
        ? {
            ...curr,
            executablePath: preview.executablePath,
            detectedVersion: preview.detectedVersion,
          }
        : curr
    );
  }, [system, showErrorToast, t]);

  const previewFolder = useCallback(
    async (folderPath: string, scanSubfolders: boolean) => {
      if (!system) return null;
      const { requestId } = await window.electron.startRomScan(
        system,
        folderPath,
        scanSubfolders
      );
      return new Promise<number>((resolve) => {
        const unsub = window.electron.onRomScanProgress(
          requestId,
          (payload) => {
            if (payload.type === "done" || payload.type === "cancelled") {
              unsub();
              resolve(payload.fileCount);
            } else if (payload.type === "error") {
              unsub();
              resolve(0);
            }
          }
        );
      });
    },
    [system]
  );

  useEffect(() => {
    if (!visible) {
      prefilledRef.current = false;
      return;
    }
    if (!system) return;
    if (steps[stepIndex] !== "rom_folder") return;
    if (prefilledRef.current) return;
    if (folders.length > 0) return;

    prefilledRef.current = true;

    (async () => {
      if (system === "ps3") {
        const sources = await window.electron.getRpcs3DefaultSources();
        setYmlEntryCount(sources.gamesYmlEntries.length);
        const gamesDir = sources.gamesDir;
        if (gamesDir) {
          setFolders([
            { path: gamesDir, scanSubfolders: true, previewCount: null },
          ]);
          const count = await previewFolder(gamesDir, true);
          setFolders((prev) =>
            prev.map((x) =>
              x.path === gamesDir ? { ...x, previewCount: count } : x
            )
          );
        }
        return;
      }

      if (system === "switch") {
        // Ryubing keeps registered ROM folders in Config.json → game_dirs.
        // Prefill each so the user sees what Ryubing already scans.
        const sources = await window.electron.getRyubingDefaultSources();
        if (sources.gameDirs.length === 0) return;
        const initial: PendingFolder[] = sources.gameDirs.map((p) => ({
          path: p,
          scanSubfolders: true,
          previewCount: null,
        }));
        setFolders(initial);
        for (const f of initial) {
          const count = await previewFolder(f.path, true);
          setFolders((prev) =>
            prev.map((x) =>
              x.path === f.path ? { ...x, previewCount: count } : x
            )
          );
        }
        return;
      }

      if (system !== "ps1" && system !== "ps2") return;

      const paths = await window.electron.getEmulatorRomPaths(system);
      if (paths.length === 0) return;
      const initial: PendingFolder[] = paths.map((p) => ({
        path: p,
        scanSubfolders: true,
        previewCount: null,
      }));
      setFolders(initial);
      for (const f of initial) {
        const count = await previewFolder(f.path, true);
        setFolders((prev) =>
          prev.map((x) =>
            x.path === f.path ? { ...x, previewCount: count } : x
          )
        );
      }
    })();
  }, [visible, system, steps, stepIndex, folders.length, previewFolder]);

  useEffect(() => {
    if (!visible || !system) return;
    if (currentStep !== "scanning") return;
    if (scanStartedRef.current) return;
    scanStartedRef.current = true;
    void start(
      system,
      folders.map((f) => ({
        path: f.path,
        scanSubfolders: f.scanSubfolders,
      }))
    );
  }, [visible, system, currentStep, folders, start]);

  useEffect(() => {
    if (currentStep !== "scanning") return;
    if (scan.system !== system) return;
    if (scan.phase !== "done" || !scan.result) return;
    setGamesAdded(scan.result.matched);
    setScanComplete(true);
    void refreshConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.phase, scan.result, scan.system, currentStep]);

  const handleAddFolder = useCallback(async () => {
    if (!system) return;
    const result = await window.electron.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const folderPath = result.filePaths[0];

    if (folders.some((f) => f.path === folderPath)) return;

    setFolders((prev) => [
      ...prev,
      { path: folderPath, scanSubfolders: true, previewCount: null },
    ]);

    if (system === "ps1" || system === "ps2" || system === "switch") {
      // For switch, addEmulatorRomPath dispatches to addRyujinxGameDir which
      // mutates Config.json → game_dirs. See events/emulator-rom-paths.ts.
      window.electron.addEmulatorRomPath(system, folderPath).catch(() => {});
    }

    const count = await previewFolder(folderPath, true);
    setFolders((prev) =>
      prev.map((f) =>
        f.path === folderPath ? { ...f, previewCount: count } : f
      )
    );
  }, [folders, previewFolder, system]);

  const handleChangeFolder = useCallback(
    async (index: number) => {
      const result = await window.electron.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return;
      const newPath = result.filePaths[0];

      const folder = folders[index];
      setFolders((prev) =>
        prev.map((f, i) =>
          i === index ? { ...f, path: newPath, previewCount: null } : f
        )
      );

      const count = await previewFolder(newPath, folder.scanSubfolders);
      setFolders((prev) =>
        prev.map((f, i) => (i === index ? { ...f, previewCount: count } : f))
      );
    },
    [folders, previewFolder]
  );

  const handleRemoveFolder = useCallback((index: number) => {
    setFolders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleToggleSubfolders = useCallback(
    async (index: number) => {
      const folder = folders[index];
      const next = !folder.scanSubfolders;
      setFolders((prev) =>
        prev.map((f, i) =>
          i === index ? { ...f, scanSubfolders: next, previewCount: null } : f
        )
      );
      const count = await previewFolder(folder.path, next);
      setFolders((prev) =>
        prev.map((f, i) => (i === index ? { ...f, previewCount: count } : f))
      );
    },
    [folders, previewFolder]
  );

  const continueDisabled = useMemo(() => {
    if (currentStep === "find_emulator") return config?.executablePath === null;
    if (currentStep === "firmware") return !firmwareOk;
    if (currentStep === "keys") return !keysOk;
    if (currentStep === "bios") return !biosOk;
    if (currentStep === "rom_folder") return folders.length === 0;
    if (currentStep === "scanning") return !scanComplete;
    return true;
  }, [currentStep, config, firmwareOk, keysOk, biosOk, folders, scanComplete]);

  const continueHidden = currentStep === "done";

  if (!visible || !system) return null;

  const handleClose = () => {
    onClose();
  };

  const handleSkip = () => {
    if (
      currentStep === "firmware" ||
      currentStep === "bios" ||
      currentStep === "keys"
    ) {
      goNext();
    } else if (currentStep === "rom_folder") {
      refreshConfig();
      onComplete(system);
    }
  };

  const handleScanCancel = () => {
    refreshConfig();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      title={
        <div className="setup-modal__header">
          <h2 className="setup-modal__header-title">
            {t("setup_modal_title", { system: systemLabel })}
          </h2>
        </div>
      }
      onClose={handleClose}
      clickOutsideToClose={false}
    >
      <div className="setup-modal">
        <div className="setup-modal__body">
          {currentStep === "find_emulator" && config && !showDownloadHelp && (
            <SetupStepFindEmulator
              config={config}
              detecting={detecting}
              onBrowse={handleBrowseExecutable}
              onShowDownloadHelp={() => setShowDownloadHelp(true)}
              installOptions={installOptions}
              installProgress={installProgress}
              installingId={installingId}
              onInstall={handleInstallOption}
            />
          )}
          {currentStep === "find_emulator" && config && showDownloadHelp && (
            <SetupStepDownload
              binary={config.binary}
              installOptions={installOptions}
              installProgress={installProgress}
              installingId={installingId}
              onInstall={handleInstallOption}
              onRescan={handleRescan}
              detecting={detecting}
              detected={config.executablePath !== null}
            />
          )}
          {currentStep === "firmware" && config && system === "ps3" && (
            <SetupStepFirmware
              config={config}
              systemLabel={systemShort}
              onFirmwareStatusChange={setFirmwareOk}
              onSkip={handleSkip}
            />
          )}
          {currentStep === "firmware" && config && system === "switch" && (
            <SetupStepSwitchFirmware
              config={config}
              onFirmwareStatusChange={setFirmwareOk}
              onSkip={handleSkip}
            />
          )}
          {currentStep === "keys" && config && system === "switch" && (
            <SetupStepSwitchKeys
              config={config}
              onKeysStatusChange={setKeysOk}
              onSkip={handleSkip}
            />
          )}
          {currentStep === "bios" && config && (
            <SetupStepBios
              system={system}
              config={config}
              systemLabel={systemShort}
              onBiosStatusChange={setBiosOk}
              onConfigChange={setConfig}
              onSkip={handleSkip}
            />
          )}
          {currentStep === "rom_folder" && (
            <SetupStepRomFolder
              system={system}
              systemLabel={systemShort}
              folders={folders}
              ymlEntryCount={ymlEntryCount}
              onAddFolder={handleAddFolder}
              onChangeFolder={handleChangeFolder}
              onRemoveFolder={handleRemoveFolder}
              onToggleSubfolders={handleToggleSubfolders}
            />
          )}
          {currentStep === "scanning" && (
            <SetupStepScanning
              systemLabel={systemShort}
              phase={scan.phase}
              processed={scan.processed}
              total={scan.total}
              percent={scan.percent}
              currentFile={scan.currentFile}
              status={scan.status}
              discovered={scan.discovered}
              matched={scan.matched}
              sizeBytes={scan.sizeBytes}
              unmatchedFiles={scan.result?.unmatchedFiles ?? []}
            />
          )}
          {currentStep === "done" && (
            <SetupStepDone
              systemLabel={systemLabel}
              gamesAdded={gamesAdded}
              onBrowse={() => onComplete(system)}
            />
          )}
        </div>

        {showDownloadHelp ? (
          <div className="setup-modal__footer">
            <div className="setup-modal__footer-side">
              <button
                type="button"
                className="setup-modal__ghost-button"
                onClick={() => setShowDownloadHelp(false)}
              >
                {t("setup_back")}
              </button>
            </div>
            <div className="setup-modal__dots" />
            <div className="setup-modal__footer-side setup-modal__footer-side--end">
              <Button theme="primary" onClick={handleDownloadReady}>
                {t("setup_download_ready")}
              </Button>
            </div>
          </div>
        ) : (
          <SetupFooter
            currentStepIndex={stepIndex}
            totalSteps={steps.length}
            showBack={
              stepIndex > 0 &&
              currentStep !== "scanning" &&
              currentStep !== "done"
            }
            showCancel={currentStep === "find_emulator"}
            showSkip={currentStep === "rom_folder"}
            continueDisabled={continueDisabled}
            continueHidden={continueHidden}
            endAction={
              currentStep === "scanning" && !scanComplete
                ? {
                    label: t("setup_cancel_scan"),
                    onClick: () => {
                      cancel();
                      handleScanCancel();
                    },
                  }
                : null
            }
            onBack={goBack}
            onCancel={handleClose}
            onSkip={handleSkip}
            onContinue={handleContinue}
          />
        )}
      </div>
    </Modal>
  );
}
