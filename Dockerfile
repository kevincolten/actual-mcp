# ---- Builder ----
FROM node:24-alpine AS builder

WORKDIR /app

# Reason: the committed lockfile (inherited from upstream) records only
# @emnapi/wasi-threads and omits @emnapi/core and @emnapi/runtime, the nested
# dependencies of the wasm32-wasi binding. `npm ci` rejects it as out of sync on
# every platform, so dependencies are resolved at install time instead.
# This must stay in step with .github/workflows/pr-validation.yml.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

COPY . ./
RUN npm run build

# ---- Release ----
FROM node:24-alpine AS release

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/build ./build

ENV NODE_ENV=production

RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund

EXPOSE 3000
ENTRYPOINT ["node", "build/index.js"]
