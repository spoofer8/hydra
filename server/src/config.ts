import { z } from "zod";
import path from "node:path";

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_URL: z.string().url(),
  DATA_DIR: z.string().default("/data"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(30 * 24 * 3600),
  MAX_SAVE_UPLOAD_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  MAX_ASSET_UPLOAD_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  ALLOW_REGISTRATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CORS_ORIGINS: z.string().default("*"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  publicUrl: env.PUBLIC_URL.replace(/\/$/, ""),
  paths: {
    root: env.DATA_DIR,
    db: path.join(env.DATA_DIR, "hydra.sqlite"),
    saves: path.join(env.DATA_DIR, "saves"),
    assets: path.join(env.DATA_DIR, "assets"),
    tmp: path.join(env.DATA_DIR, "tmp"),
  },
  corsOrigins:
    env.CORS_ORIGINS === "*"
      ? true
      : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
} as const;

export type Config = typeof config;
