import { db, runMigrations } from "../lib/db.js";
import { hashPassword } from "../lib/auth.js";
import { newId } from "../lib/ids.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

runMigrations();

const rl = readline.createInterface({ input, output });

const email = (await rl.question("Email: ")).trim().toLowerCase();
const username = (await rl.question("Username: ")).trim();
const displayName = (await rl.question("Display name: ")).trim() || username;
const password = await rl.question("Password: ");
rl.close();

if (!email || !username || !password) {
  console.error("email, username, and password are required");
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

const now = Date.now();
const id = newId();
const passwordHash = await hashPassword(password);

try {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, username, display_name,
                        profile_visibility, bio, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PUBLIC', '', ?, ?)`
  ).run(id, email, passwordHash, username, displayName, now, now);
  console.log(`Created user ${username} <${email}> with id ${id}`);
} catch (err: any) {
  if (String(err.message).includes("UNIQUE")) {
    console.error("A user with that email or username already exists.");
    process.exit(1);
  }
  throw err;
}
