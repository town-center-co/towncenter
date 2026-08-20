# =============================================================================
# Towncenter — production image.
#
#   docker build -t towncenter --build-arg APP_VERSION=1.2.3 .
#   docker run -p 3000:3000 --env-file .env towncenter
#
# `.env`, not `.env.local` — that one's for `npm run dev` (see README). `-e
# KEY=VALUE` overrides individual values from --env-file, and both combine.
# =============================================================================

# `prepare` runs `husky`, which expects a `.git` directory to hook into.
# `.dockerignore` deliberately excludes `.git` from the build context — git
# hooks have no meaning inside an image — so the script has nothing to do
# and is dropped before install rather than left to fail on it.

# ---- build: full node_modules (build needs devDependencies: typescript,
# tailwindcss), source, compiled output. Pruned back to production-only
# node_modules at the end, so the runner copies one clean directory rather
# than reassembling it from parts. ----
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare && npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Baked in at build time, read by the app to identify its own version.
# Defaulted so a local `docker build` without --build-arg still produces a
# runnable image; CI always passes the real tag.
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

RUN addgroup -S -g 1001 towncenter && adduser -S -u 1001 -G towncenter towncenter

# `--chown` matters, not just `USER` below: COPY defaults to the ownership
# already on the files (root, from the `build` stage), and `USER` only
# governs the process, not files copied before it. Without `--chown`, `next
# start` running as `towncenter` gets EACCES the first time it writes to
# `.next/cache` — e.g. `next/image` optimizing the login screen's logo.
COPY --chown=towncenter:towncenter --from=build /app/node_modules ./node_modules
COPY --chown=towncenter:towncenter --from=build /app/.next ./.next
COPY --chown=towncenter:towncenter --from=build /app/next.config.ts ./next.config.ts
COPY --chown=towncenter:towncenter package.json ./package.json

# `next start` reads only `.next`, `node_modules`, `next.config.ts` and
# `package.json` — none of `app/`, `lib/`, `components/` are needed at
# runtime, the build already compiled them into `.next`. `drizzle/` and
# `scripts/migrate.mjs` are the exception: `npm start` runs the migration
# script before `next start`, and that script is never traced or bundled by
# `next build` since it's not part of the app's own import graph.
COPY --chown=towncenter:towncenter drizzle ./drizzle
COPY --chown=towncenter:towncenter scripts/migrate.mjs ./scripts/migrate.mjs

USER towncenter

EXPOSE 3000

# Same command as local dev (`npm start`): migrate, then serve. One
# definition of "how this app boots", shared between `next start` on a bare
# host and this image.
CMD ["npm", "start"]
