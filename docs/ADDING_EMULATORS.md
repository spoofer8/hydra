# Adding a New Emulator to Hydra

Step-by-step recipe for adding a new emulator system (e.g. Nintendo 3DS via Citra/Lime3DS, Wii U via Cemu, Xbox via xemu). Follows the same pattern as PS1/PS2/PS3 and Switch — the type layer is the atom of the change and TypeScript surfaces the cascade automatically.

Time budget: ~2–4 hours for a system with a clean binary distribution and simple auto-config; more if the emulator has firmware/keys prerequisites like Switch.

---

## 1. Decide up front

Before touching code, answer these:

| Question | Why it matters |
|---|---|
| **Emulator binary + repo?** | Filename regex in `emulator-install-sources.ts` depends on the release asset naming |
| **Release host** (GitHub? Forgejo? custom server?) | GitHub gets `GithubAssetSource`; Forgejo/Gitea reuses `ForgejoAssetSource`; custom servers need a new resolver or link-only fallback |
| **Config file format** (INI? JSON? YAML?) | Determines how ROM path discovery reads/writes (PCSX2 = INI, RPCS3 = YAML, Ryubing = JSON) |
| **Config file location** per OS | Windows / Linux / macOS paths + portable-install override |
| **ROM extensions** the emulator boots | Populates `romExtensions` in known-binaries and drives file-picker filters |
| **Prerequisites** (BIOS? firmware? keys?) | Adds setup-wizard steps (see PS2 BIOS, PS3 firmware, Switch keys+firmware) |
| **Save location + format** (memcard blob? directory tree? SQLite?) | Determines cloud-save integration path (buffer-based vs. tarball-based) |
| **RetroAchievements support?** | If yes, add to `app.tsx` retroachievements-emulators map |
| **Icon asset** | Need a `<system>.png` in `src/renderer/src/assets/emulation/` |

If you can't answer these confidently, don't start — spike the emulator first, then come back.

---

## 2. Widen the types (Phase 1)

**One file, four unions:**

```ts
// src/types/emulator.types.ts
export type EmulatorSystem = "ps1" | "ps2" | "ps3" | "switch" | "<new-system>";
export type EmulatorBinary = "duckstation" | "pcsx2" | "rpcs3" | "ryujinx" | "<new-binary>";
export type EmulationSavePlatform = "ps1" | "ps2" | "switch" | "<new-system>";  // if cloud saves
export type EmulationSaveEmulator = "duckstation" | "pcsx2" | "ryujinx" | "<new-binary>";  // if cloud saves
```

Now run `yarn typecheck`. You'll get ~10–20 errors. Each one is a `Record<EmulatorSystem, X>` map or a `switch(system)` that needs the new branch. **The error list IS your punchlist for Phases 3+.** Fix them in order — do not silence with `!` or `as any`.

---

## 3. Main-process services (Phase 2)

### 3a. `src/main/services/emulators/known-binaries.ts`
Add an entry to `KNOWN_BINARIES`. Copy any existing entry as a starting point; the fields document themselves. Notes:
- `linuxNames` / `windowsNames` matter for detection order — put the most common name first
- `romExtensions` should be dot-prefixed and lowercase (`".iso"`, not `"iso"`)
- `romDirectoryMarkers` is for emulators that boot from a directory (PS3 `PS3_GAME`); empty array for file-based emulators

### 3b. `src/main/services/emulators/emulator-install-sources.ts`
- If binary is on **GitHub**: copy the pattern from `duckstationEntries` / `pcsx2Entries` / `rpcs3Entries`. Add per-OS asset regex.
- If binary is on **Forgejo/Gitea** (Ryubing pattern): use `ForgejoAssetSource` — the resolver is already there, you just add a new `<name>Entries()` function with `baseUrl` + `repo`.
- If binary is only distributed via a **custom download page**: use `LinkSource` — the install button opens the URL, no auto-install.
- Wire the new binary into `githubEntries()` dispatch.

### 3c. `src/main/services/emulators/emulator-config.ts`
Add per-OS config file candidates + portable-mode override + a reader for the emulator's ROM-path list. Existing patterns:

| Emulator | Format | Key |
|---|---|---|
| DuckStation, PCSX2 | INI `[GameList] RecursivePaths=` | `readRecursivePaths` |
| RPCS3 | YAML `games.yml` (title_id: path) | `readGamesYml` |
| Ryubing | JSON `Config.json → game_dirs[]` | `readRyujinxGameDirs` |

### 3d. `src/main/services/emulators/firmware-detection.ts` / `bios-detection.ts`
Only if the emulator has firmware or BIOS requirements. For a single blob (PS1/PS2 BIOS) use `bios-detection` patterns; for a bundle (PS3 firmware, Switch firmware+keys) use `firmware-detection`.

### 3e. `src/main/services/emulators/emulator-installer.ts`
Add `<new-binary>: "<new-system>"` to `BINARY_TO_SYSTEM`.

---

## 4. IPC events (Phase 3)

### 4a. Extend existing branches
TypeScript will tell you. Common locations:
- `src/main/events/emulators/emulator-rom-paths.ts` — add system branch to `getEmulatorRomPaths` / `addEmulatorRomPath`; add a `get<Emulator>DefaultSources` event if you have a config-file-driven pre-fill
- `src/main/events/emulators/import-launchbox-roms.ts` — add `SYSTEM_DEFAULT_PLATFORM` and `SYSTEM_CATALOGUE_PLATFORM` entries (must match LaunchBox's canonical platform name exactly)
- `src/main/helpers/launch-classics-game.ts` — `buildEmulatorArgs` case for CLI args

### 4b. New Switch-style events (only if prerequisites)
- Firmware / keys check → new `check-<system>-firmware.ts`, registered in `events/emulators/index.ts`
- Expose via IPC signature in `src/renderer/src/declaration.d.ts`

### 4c. `declaration.d.ts`
Any new IPC method added in the main process must have a TypeScript signature here or the renderer can't call it type-safely.

---

## 5. Renderer wiring (Phase 4)

### 5a. `src/renderer/src/helpers.ts`
- `platformToSystem`: add a regex line. **Order matters** — put more-specific patterns before less-specific ones (Switch before PlayStation, else "Nintendo Switch" could get consumed by a broader `\bswitch\b`)
- `SYSTEM_TO_BINARY`: add `<system>: "<binary>"`

### 5b. `src/renderer/src/pages/settings/emulation/known-binary-labels.ts`
`<binary>: "Display Name"` — this is what users see everywhere.

### 5c. `src/renderer/src/pages/settings/emulation/settings-context-emulation.tsx`
Extend `SYSTEMS` array + `SYSTEM_LABELS` map.

### 5d. `src/renderer/src/assets/emulation/<system>.png`
Add a ~800×1067 PNG. Same dimensions as `ps1.png`. If you don't have final art yet, copy an existing PNG as a placeholder and add a `// PLACEHOLDER` comment in the import so it's obvious later.

### 5e. `src/renderer/src/pages/settings/emulation/setup/setup-step-download.tsx`
Add `<binary>` entries to `OFFICIAL_WEBSITES` (upstream homepage) and `ARTICLE_KEYS` (translation key for the install guide).

### 5f. Big-picture UI (`src/big-picture/…`)
- `shared.ts`: `EMULATION_SYSTEMS`, `EMULATION_SYSTEM_LABELS`, `EMULATION_SYSTEM_ART`
- `settings-navigation.ts`: `EMULATION_OVERVIEW_CARD_FOCUS_IDS.<system>`
- `emulation/index.tsx`: `cardNavigationOverridesBySystem` — add the new system to the D-pad navigation graph (which system is to its left/right when the user navigates?)

---

## 6. Setup wizard (Phase 5, if prerequisites)

If the emulator needs BIOS/firmware/keys:

### 6a. `src/renderer/src/pages/settings/emulation/setup/types.ts`
- Add new `StepKind` value if you need a step type that doesn't exist (Switch added `"keys"`)
- Add a branch to `stepListForSystem` returning the ordered step list

### 6b. New step component
- Copy an existing step (`setup-step-firmware.tsx` for a single-check step, `setup-step-switch-keys.tsx` for a status-with-path-hint step)
- Call the new IPC endpoint from step 4b
- Emit status changes via `on<Thing>StatusChange` prop so the modal can gate the Continue button

### 6c. `src/renderer/src/pages/settings/emulation/setup/emulator-setup-modal.tsx`
- Import the new step component
- Add state (e.g. `keysOk`)
- Add render branch keyed by `currentStep === "<step>" && system === "<system>"`
- Add gate to `continueDisabled` useMemo
- Add case to `handleSkip`
- Add prefill for `rom_folder` step if you have a config-driven default (see the `system === "switch"` branch)

---

## 7. Cloud saves (Phase 6, if applicable)

`src/main/services/emulators/emulation-cloud-saves.ts` is the surface. Two patterns:

- **Memcard-blob** (PS1, PS2): a save is a `Buffer` extracted from a memcard image. Upload takes `buffer`, fileName ends in `.psu` / `.mcs`. Reuse `uploadEmulationSave` directly.
- **Directory-tree** (Switch): a save is a folder. Pack to gzipped tar, upload the tarball as the buffer. On restore, download and untar into the target folder. See `packSwitchSaveDirectory` / `unpackSwitchSaveDirectory` for the template.

Update `toEmulationSaveEmulator` — it currently uses an RPCS3-only blacklist (rpcs3 has no cloud saves flow). If your new binary DOES have cloud saves, no change needed. If it DOESN'T, add it to the blacklist.

---

## 8. Locales (Phase 7)

`src/locales/en/translation.json` first, then `src/locales/pt-BR/translation.json` (upstream's second locale). Other locales get English fallback via i18next `defaultValue` in the components — don't try to fill them all.

Keys to add if you have a setup wizard step:
- `setup_step_<system>_<step>` — step title
- `setup_<system>_<step>_intro_1` / `_intro_2` — body paragraphs
- `setup_<system>_<step>_step_1` / `_step_2` — numbered instructions
- `setup_<system>_<step>_guide` — external docs link label
- `setup_<system>_<step>_found` / `_not_yet` — status
- `setup_<system>_<step>_check_again` — retry button
- `setup_step_label_<step>` — stepper label (Switch added `"Keys"`)

---

## 9. Documentation

- Update **§12.7 of [HYBRID_PATCH_GUIDE.md](./HYBRID_PATCH_GUIDE.md)** with the new emulator's file map (copy the Switch template)
- If the emulator has unusual quirks (Ryubing being on Forgejo not GitHub, save_data_id ≠ title_id), document them under "gotchas" so the next merge doesn't lose them

---

## 10. Verify

```bash
yarn typecheck   # must pass — the punchlist from step 2 is now closed
yarn dev         # smoke test the settings UI shows the new emulator
```

Manual QA:
- [ ] Settings → Emulation shows the new emulator with correct icon and display name
- [ ] Install button flows through (either auto-install succeeds OR the link-only fallback opens the download page)
- [ ] Detection finds an already-installed emulator on PATH
- [ ] Setup wizard walks through all steps for the new system
- [ ] Rom folder scan finds ROMs with the declared extensions
- [ ] LaunchBox importer places games under `system = "<new-system>"`
- [ ] Cloud saves upload/download (if implemented)

---

## Common mistakes

1. **Forgetting `platformToSystem` regex order.** More-specific patterns must come first, or a broader regex swallows the new system.
2. **Wrong LaunchBox platform name.** Must be case-sensitive exact match against LaunchBox's official Platforms list (`launchbox-app.com`), not a friendly variant.
3. **Assuming release assets have version-stable names.** Always test the regex against the CURRENT release, not what the download page said last year. Rolling channels (like DuckStation's `tags/latest`) are safer than semver-tagged releases.
4. **Auto-installer that assumes a Windows installer format when the emulator ships as a portable zip.** Check `EmulatorInstallKind` — `windows-installer` runs the exe, `windows-archive` extracts to a folder.
5. **Silently narrowing types with `as any` / `!`.** Every one hides a real branch you forgot to add. The typecheck IS the checklist.

If you hit something not covered here, extend this doc.
