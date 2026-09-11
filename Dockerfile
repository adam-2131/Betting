# PolyAlpha — one container running both the website and the sync loop.
#
# Two processes rather than a serverless deployment, and the reason is concrete: a full trader
# pass has been measured at seventeen minutes. Vercel's hobby functions cap at sixty seconds, and
# `/api/cron/sync` declares maxDuration = 300 precisely because that is the ceiling on the
# platforms it was written for. Neither fits, so the sync needs a process that can simply keep
# running — which is what `npm run auto` already is.
#
# Targets any host that runs a container with a persistent process. See DEPLOY.md for the free
# options and their catches.

FROM node:22-slim AS base
# Prisma needs OpenSSL, and the slim image does not ship it.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- Dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
# The embedded-postgres platform binaries are only for `npm run db:local`, which a deployment
# never uses — it points DATABASE_URL at a hosted database instead. Skipping them saves a large
# download and a lot of image size.
ENV npm_config_omit=optional
RUN npm ci --no-audit --no-fund

# --- Build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- Run --------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY package.json next.config.ts tsconfig.json ./
COPY public* ./public/
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src

EXPOSE 3000

# `db push` on boot so a fresh database is usable without a manual migration step. It is
# idempotent, so restarts are free.
#
# Both processes run under one shell and the container exits if either dies, so the host's restart
# policy sees a failure rather than a half-running app quietly serving stale data.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && (npm run start & npm run auto -- --minutes=15 & wait -n; exit 1)"]
