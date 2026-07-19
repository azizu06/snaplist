# syntax=docker/dockerfile:1
# Multi-stage image (issue #18): deps → build → standalone runner.
#
# The build needs NO secrets: env validation is lazy (src/lib/env.ts getEnv()
# runs at request time, and the Supabase server client reads cookies() first so
# prerendering bails to dynamic before env is touched). Runtime config (OpenAI,
# Supabase, eBay keys) is injected when the container starts:
#
#   docker build -t snaplist .
#   docker run --rm -p 3000:3000 --env-file .env.local snaplist

FROM node:22-alpine AS base
# pnpm via corepack, pinned by package.json's `packageManager` field.
RUN corepack enable

# --- deps: install with the frozen lockfile (cached unless the lockfile moves) ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build: next build with standalone output ---
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# BUILD_STANDALONE flips next.config.ts to `output: "standalone"` (Docker-only;
# the Vercel path keeps the default output).
ENV BUILD_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# --- runner: minimal non-root runtime with only the standalone server ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
# Liveness via the app's own health route (busybox wget ships with alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
