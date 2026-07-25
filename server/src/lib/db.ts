import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(config.paths.root, { recursive: true });
fs.mkdirSync(config.paths.saves, { recursive: true });
fs.mkdirSync(config.paths.assets, { recursive: true });
fs.mkdirSync(config.paths.tmp, { recursive: true });

export const db = new Database(config.paths.db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

const migrations: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        profile_visibility TEXT NOT NULL DEFAULT 'PUBLIC',
        profile_image_url TEXT,
        background_image_url TEXT,
        bio TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

      CREATE TABLE library_games (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        shop TEXT NOT NULL,
        title TEXT NOT NULL,
        icon_url TEXT,
        playtime_ms INTEGER NOT NULL DEFAULT 0,
        last_played_at INTEGER,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_id, shop, object_id)
      );
      CREATE INDEX idx_library_user ON library_games(user_id);

      CREATE TABLE achievements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        shop TEXT NOT NULL,
        achievement_name TEXT NOT NULL,
        unlocked_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, shop, object_id, achievement_name)
      );
      CREATE INDEX idx_achievements_user_game
        ON achievements(user_id, shop, object_id);

      CREATE TABLE save_artifacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL,
        shop TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL DEFAULT '',
        home_dir TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        download_option_title TEXT,
        file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        upload_status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_save_artifacts_user_game
        ON save_artifacts(user_id, shop, object_id);

      CREATE TABLE friend_requests (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'PENDING',
        created_at INTEGER NOT NULL,
        UNIQUE (sender_id, receiver_id)
      );

      CREATE TABLE friendships (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, friend_id)
      );
    `,
  },
];

function ensureMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function runMigrations(): void {
  ensureMigrationsTable();
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id)
  );
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id, Date.now());
    });
    tx();
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration ${migration.id}`);
  }
}
