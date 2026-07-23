# ---- Builder ----
FROM node:24-alpine AS builder

WORKDIR /app

# Resolve dependencies at build time so the bundled @actual-app/api tracks the
# newest release satisfying the ^26.7.0 range. This avoids the recurring
# `out-of-sync-migrations` failure that occurs when the pinned client lags
# behind the Actual Budget sync server's schema migrations.
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm npm install

COPY . ./
RUN npm run build

# ---- Release ----
FROM node:24-alpine AS release

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/build ./build

ENV NODE_ENV=production

RUN --mount=type=cache,target=/root/.npm npm install --omit=dev

EXPOSE 3000
ENTRYPOINT ["node", "build/index.js"]
