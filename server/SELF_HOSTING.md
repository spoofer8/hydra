# Self-Hosting the Hydra Backend

This directory contains a self-hosted replacement for Hydra Cloud. Running it
gives you cloud saves, achievement sync, library sync, animated avatars, and
custom profile banners without a subscription, using your own server as the
backing store.

**You will need:**

- A small Linux server reachable from the internet (any VPS, home server with
  a static IP, or a Cloudflare Tunnel from a home machine). 1 vCPU / 512 MB RAM
  is plenty for a handful of users; disk depends on how large your game saves
  are.
- A domain name pointing at that server (e.g. `api.your-domain.com`). Caddy
  provisions HTTPS automatically once DNS is in place.
- `docker` and `docker compose` on the server.
- A rebuilt Hydra client pointed at your server via a custom `.env` (details
  at the bottom).

## 1. First-time server setup

On a fresh Debian/Ubuntu VPS:

```bash
# Install Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker

# Clone your fork
git clone https://github.com/YOUR-USER/hydra.git
cd hydra/server
```

Point an A record for `api.your-domain.com` at the server's public IP before
continuing — Caddy needs to answer an HTTP-01 challenge on port 80.

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Key | What to set |
| --- | --- |
| `PUBLIC_URL` | `https://api.your-domain.com` (must be `https` if you're using Caddy for TLS) |
| `JWT_SECRET` | Run `openssl rand -hex 64` and paste the result |
| `ALLOW_REGISTRATION` | Keep `true` while you sign up, then flip to `false` |
| `MAX_SAVE_UPLOAD_BYTES` | Raise if you have very large emulator states (default 512 MiB) |
| `CORS_ORIGINS` | Leave `*` for the Electron client; restrict if you build a web dashboard later |

Then edit `Caddyfile` and replace `api.example.com` on the first line with
your actual domain.

## 3. Bring it up

```bash
docker compose up -d --build
docker compose logs -f api
```

You should see `hydra-selfhost-server ready on http://0.0.0.0:8080 (public:
https://api.your-domain.com)` once the app boots and migrations have run.

Verify from your laptop:

```bash
curl https://api.your-domain.com/health
# {"ok":true,"version":"0.1.0"}
```

If that fails, the TLS handshake likely failed. Check `docker compose logs
caddy` — the usual cause is DNS not pointing at the box yet, or ports 80/443
blocked by a firewall (`ufw allow 80,443/tcp`).

## 4. Create your account

Two options.

**Option A — via the CLI (recommended for the first admin account).** Runs
inside the container so it uses the same SQLite file:

```bash
docker compose exec api node dist/scripts/create-user.js
```

Follow the prompts for email, username, and password. This works even when
`ALLOW_REGISTRATION=false`.

**Option B — via the client sign-up form.** Only works while
`ALLOW_REGISTRATION=true`. Rebuild the client (below), open it, and use the
normal registration flow — the client is already wired to `POST /auth/register`.

Once you and your friends have accounts, edit `.env` to set
`ALLOW_REGISTRATION=false` and `docker compose restart api` to close the door.

## 5. Point the Hydra client at your server

Back in the repo root (not `server/`):

```bash
cp .env.example .env   # if not already present
```

Set these values in the top-level `.env`:

```
MAIN_VITE_API_URL=https://api.your-domain.com
MAIN_VITE_AUTH_URL=https://api.your-domain.com/auth
MAIN_VITE_CHECKOUT_URL=https://api.your-domain.com/subscription
MAIN_VITE_ANALYTICS_API_URL=https://api.your-domain.com
MAIN_VITE_NIMBUS_API_URL=https://api.your-domain.com
MAIN_VITE_EXTERNAL_RESOURCES_URL=https://api.your-domain.com/resources
MAIN_VITE_LAUNCHER_SUBDOMAIN=
```

Then build the client for your OS:

```bash
yarn install
yarn build:linux    # or build:mac / build:win
```

The installer under `dist/` is now a self-contained Hydra Launcher that only
talks to your server. Install it, log in with the account you created, and
cloud saves, achievement sync, and animated avatars all work.

## 6. Backups

Everything lives in the `hydra_data` docker volume: SQLite database +
uploaded saves + uploaded avatars/banners. To back it up nightly:

```bash
# Stop briefly so SQLite has a quiet consistency point (optional; WAL mode
# means live copies are usually fine, but this is bulletproof).
docker compose stop api
docker run --rm -v hydra_data:/data -v "$PWD/backups:/backup" \
  alpine tar czf /backup/hydra-$(date +%F).tar.gz -C /data .
docker compose start api
```

Restore is the reverse: stop the api, `tar xzf` into a fresh volume, start
again.

## 7. Upgrading

```bash
cd hydra
git pull
cd server
docker compose up -d --build
```

Migrations run automatically on boot. If a migration fails, the app exits
non-zero — check `docker compose logs api` before restarting.

## 8. Common problems

- **Client shows "network error" but `/health` works.** Almost always a CORS
  or scheme mismatch. Confirm `PUBLIC_URL` in the server matches
  `MAIN_VITE_API_URL` in the client exactly (including `https://`).
- **Uploads fail on saves >100 MB.** Either the client's HTTP timeout, the
  Caddy `read_timeout`, or `MAX_SAVE_UPLOAD_BYTES` is the limit. All three
  are configurable; the defaults handle 512 MiB.
- **Animated avatar upload gets rejected.** The server accepts `image/gif`,
  `image/webp`, `image/apng`, and `video/mp4`. If a format you want is
  rejected, add its MIME to `AVATAR_MIME_ALLOWLIST` in `src/routes/profile.ts`.
- **"Subscription required" popup still appears.** Check that
  `GET /profile/me` on the server returns a `subscription` object with
  `status: "active"` — that field is what the client's Redux slice reads to
  unlock the paywalled UI.
