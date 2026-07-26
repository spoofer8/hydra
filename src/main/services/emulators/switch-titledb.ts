import axios from "axios";
import { promises as fs } from "node:fs";
import path from "node:path";

import { SystemPath } from "@main/services/system-path";
import { logger } from "../logger";

/**
 * Community-maintained Nintendo Switch title database. Keyed by uppercase
 * 16-hex title ID → game metadata (name, publisher, icon, banner). Hosted as
 * a plain JSON file on GitHub; the US-English regional variant covers ~99%
 * of the games our Western users have.
 *
 * Why we need this
 *   Hydra's `/games/shop-details` LaunchBox endpoint returns [] for every
 *   Switch title ID we send — LaunchBox's classics catalogue does not index
 *   Switch games by title ID (and possibly not at all through this endpoint).
 *   Without a Switch-specific metadata source, every scanned Switch ROM
 *   comes back "unmatched" and shows up in the UI with no title or cover
 *   art. titledb is the standard workaround the entire Switch scene uses.
 *
 * Cache model
 *   The full US.en.json is ~20 MB (compressed by GitHub during download).
 *   We cache under userData/titledb/US.en.json. On first lookup we check
 *   the cache — if missing or older than TTL, we refresh; otherwise we
 *   parse the on-disk copy. The parsed dict is memoized for the process
 *   lifetime (Ryubing users typically scan once per session).
 */

const TITLEDB_URL =
  "https://raw.githubusercontent.com/blawar/titledb/master/US.en.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FETCH_TIMEOUT_MS = 30_000;

// Raw shape returned by titledb — annotated only with the fields we use. The
// full record has ~20 other fields we ignore.
interface TitledbRawEntry {
  id?: string | null;
  name?: string | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  publisher?: string | null;
  releaseDate?: number | null; // YYYYMMDD int
  intro?: string | null;
  description?: string | null;
}

export interface SwitchTitleMetadata {
  titleId: string; // uppercased 16-hex
  name: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  publisher: string | null;
  releaseDate: string | null; // ISO YYYY-MM-DD
  description: string | null;
}

let cachedDb: Map<string, SwitchTitleMetadata> | null = null;
let loadInflight: Promise<Map<string, SwitchTitleMetadata> | null> | null = null;

const cacheDir = (): string => path.join(SystemPath.getPath("userData"), "titledb");
const cachePath = (): string => path.join(cacheDir(), "US.en.json");

const cacheAgeMs = async (): Promise<number | null> => {
  try {
    const stat = await fs.stat(cachePath());
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
};

const releaseDateToIso = (raw: number | null | undefined): string | null => {
  if (typeof raw !== "number") return null;
  const s = String(raw);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const normalizeEntry = (
  titleId: string,
  raw: TitledbRawEntry
): SwitchTitleMetadata | null => {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  return {
    titleId,
    name,
    iconUrl: typeof raw.iconUrl === "string" ? raw.iconUrl : null,
    bannerUrl: typeof raw.bannerUrl === "string" ? raw.bannerUrl : null,
    publisher: typeof raw.publisher === "string" ? raw.publisher : null,
    releaseDate: releaseDateToIso(raw.releaseDate ?? null),
    description:
      (typeof raw.description === "string" && raw.description) ||
      (typeof raw.intro === "string" && raw.intro) ||
      null,
  };
};

const TITLE_ID_RE = /^[0-9A-Fa-f]{16}$/;

const parseDatabase = (
  text: string
): Map<string, SwitchTitleMetadata> => {
  const dict = JSON.parse(text) as Record<string, TitledbRawEntry>;
  const map = new Map<string, SwitchTitleMetadata>();
  // titledb keys the outer dict by NSU ID (14-digit Nintendo eShop id like
  // `70010000000025`), not by title ID. The actual 16-hex title ID we care
  // about — the one that appears in ROM filenames — lives inside each entry
  // as `entry.id`. Iterate values and pull the id from there.
  //
  // Some entries have null `id` (update/DLC placeholders or malformed
  // records); skip those. When multiple entries share a title ID (e.g. a
  // base game and its update record), the later one wins — usually fine
  // since base games appear before updates in the dump; if not, the update
  // record still carries the correct name/art.
  for (const entry of Object.values(dict)) {
    const titleId = typeof entry?.id === "string" ? entry.id : null;
    if (!titleId || !TITLE_ID_RE.test(titleId)) continue;
    const key = titleId.toUpperCase();
    const normalized = normalizeEntry(key, entry);
    if (normalized) map.set(key, normalized);
  }
  return map;
};

const fetchAndCache = async (): Promise<string | null> => {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    const response = await axios.get<string>(TITLEDB_URL, {
      responseType: "text",
      transformResponse: (v) => v, // don't auto-parse; we cache the raw bytes
      timeout: FETCH_TIMEOUT_MS,
      headers: { "User-Agent": "HydraLauncher" },
    });
    if (typeof response.data !== "string" || response.data.length === 0) {
      return null;
    }
    await fs.writeFile(cachePath(), response.data, "utf-8");
    logger.log("[switch-titledb] fetched", {
      bytes: response.data.length,
    });
    return response.data;
  } catch (err) {
    logger.error("[switch-titledb] fetch failed", err);
    return null;
  }
};

const loadFromDiskOrFetch = async (): Promise<Map<
  string,
  SwitchTitleMetadata
> | null> => {
  const age = await cacheAgeMs();
  const cacheFresh = age !== null && age < CACHE_TTL_MS;

  if (cacheFresh) {
    try {
      const text = await fs.readFile(cachePath(), "utf-8");
      return parseDatabase(text);
    } catch (err) {
      logger.error("[switch-titledb] cache parse failed, refetching", err);
    }
  }

  const text = await fetchAndCache();
  if (text) {
    try {
      return parseDatabase(text);
    } catch (err) {
      logger.error("[switch-titledb] fresh parse failed", err);
    }
  }

  // Last-ditch: if fetch failed but we have a stale cache, use it. Better
  // than losing all Switch matching because GitHub is temporarily flaky.
  if (age !== null) {
    try {
      const text = await fs.readFile(cachePath(), "utf-8");
      logger.warn("[switch-titledb] using stale cache", { ageDays: age / 86400000 });
      return parseDatabase(text);
    } catch {
      // fall through
    }
  }

  return null;
};

/** Loads (or returns memoized) the full titledb map. Safe to call concurrently. */
const loadDatabase = async (): Promise<Map<
  string,
  SwitchTitleMetadata
> | null> => {
  if (cachedDb) return cachedDb;
  if (loadInflight) return loadInflight;
  loadInflight = loadFromDiskOrFetch().then((result) => {
    if (result) cachedDb = result;
    loadInflight = null;
    return result;
  });
  return loadInflight;
};

/**
 * Look up a Switch title by 16-hex ID. Returns null when unknown OR when the
 * database can't be loaded (network + no cache). Callers should treat both
 * cases as "no metadata available" — no different from LaunchBox returning [].
 */
export const lookupSwitchTitle = async (
  titleId: string
): Promise<SwitchTitleMetadata | null> => {
  const db = await loadDatabase();
  if (!db) return null;
  return db.get(titleId.toUpperCase()) ?? null;
};

/**
 * Batch variant — returns a Map keyed by uppercase title ID. Prefer this for
 * ROM-scan flows so we load the database once per scan, not once per game.
 */
export const lookupSwitchTitles = async (
  titleIds: readonly string[]
): Promise<Map<string, SwitchTitleMetadata>> => {
  const out = new Map<string, SwitchTitleMetadata>();
  const db = await loadDatabase();
  if (!db) return out;
  for (const raw of titleIds) {
    const key = raw.toUpperCase();
    const hit = db.get(key);
    if (hit) out.set(key, hit);
  }
  return out;
};
