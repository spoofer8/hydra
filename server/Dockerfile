FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build tools needed for better-sqlite3 and argon2 native modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# libstdc++ ships with the base image; nothing else needed for these natives at runtime.
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The volume is mounted here; the process writes /data/hydra.sqlite + /data/{saves,assets,tmp}.
VOLUME ["/data"]
EXPOSE 8080

USER node
CMD ["node", "dist/index.js"]
